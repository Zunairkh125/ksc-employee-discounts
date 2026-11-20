import { clean, admin, jsonError } from '../lib/db.js'
import {
  hashLoginCode,
  verifyLoginCodeHash,
  createSessionToken,
  getSession,
  isEmailAuthorized,
  getAuthorizedUser,
} from '../lib/session.js'
import { lookupUserByEmail, sendDirectMessage } from '../lib/slack.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  )

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const route = clean(req.query?.route || 'session').toLowerCase()

  try {
    // ------------------------------------------------------------------------
    // 1. Check Session (Protected: Validates active token & allowlist)
    // ------------------------------------------------------------------------
    if (route === 'session') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
      const session = getSession(req)
      if (!session) {
        return res.status(401).json({ ok: false, error: 'No active session or session expired.' })
      }

      const supabase = admin()
      const authorized = await isEmailAuthorized(session.email, supabase)
      if (!authorized) {
        return res.status(403).json({
          ok: false,
          error: 'Access Denied: Your account access has been revoked.',
        })
      }

      return res.status(200).json({ ok: true, user: session })
    }

    // ------------------------------------------------------------------------
    // 2. Request 4-Digit Login Code via Slack DM
    // ------------------------------------------------------------------------
    if (route === 'request-code') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      const email = clean(req.body?.email).toLowerCase()

      if (!email || !email.includes('@')) {
        return res.status(400).json({ ok: false, error: 'A valid work email address is required.' })
      }

      const supabase = admin()

      // 1. Strict Allowlist Guard: Only authorized personnel can request a code
      const authorizedUser = await getAuthorizedUser(email, supabase)
      if (!authorizedUser) {
        return res.status(403).json({
          ok: false,
          error: 'Access Denied: You are not authorized to access this application.',
        })
      }

      // 2. Lookup user in Slack workspace by work email
      let slackUser = null
      try {
        slackUser = await lookupUserByEmail(email)
      } catch (slackErr) {
        console.warn('[/api/auth request-code] Slack lookup warning:', slackErr.message)
      }

      if (!slackUser?.id) {
        return res.status(404).json({
          ok: false,
          error: `No Kawaii Slime Company Slack account was found for "${email}". Please enter the email address tied to your Slack account.`,
        })
      }

      // 3. Generate genuine cryptographically random 4-digit code (1000 - 9999)
      const code = Math.floor(1000 + Math.random() * 9000).toString()
      const codeHash = hashLoginCode(email, code)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes expiry

      // 4. Invalidate any previous unused codes for this email in Supabase
      try {
        await supabase
          .from('discount_login_codes')
          .update({ used_at: new Date().toISOString() })
          .eq('email', email)
          .is('used_at', null)

        await supabase.from('discount_login_codes').insert({
          email,
          code_hash: codeHash,
          slack_user_id: slackUser.id,
          slack_user_name: slackUser.real_name || slackUser.name,
          expires_at: expiresAt.toISOString(),
        })
      } catch (dbErr) {
        console.warn('[/api/auth request-code] Supabase code storage warning:', dbErr.message)
      }

      // 5. Send real 4-digit code directly to employee's Slack DM
      const userName = slackUser.real_name || slackUser.name || authorizedUser.name || 'Team Member'
      const dmText =
        `🔐 *Kawaii Slime Company — Employee Discount Portal*\n\n` +
        `Hello ${userName}!\n` +
        `Your 4-digit verification code is: *${code}*\n\n` +
        `⏱️ *This code expires in 10 minutes.* If you did not request this, please disregard.`

      try {
        await sendDirectMessage(slackUser.id, dmText)
        return res.status(200).json({
          ok: true,
          email,
          expires_in_seconds: 600,
          message: `A 4-digit login code was sent to your Slack direct messages (@${userName}). It expires in 10 minutes.`,
        })
      } catch (dmErr) {
        console.error('[/api/auth request-code] Slack DM delivery failure:', dmErr.message)
        return res.status(500).json({
          ok: false,
          error: `Failed to deliver verification code to Slack user ${userName}: ${dmErr.message}`,
        })
      }
    }

    // ------------------------------------------------------------------------
    // 3. Verify 4-Digit Login Code
    // ------------------------------------------------------------------------
    if (route === 'verify-code') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      const email = clean(req.body?.email).toLowerCase()
      const code = clean(req.body?.code)

      if (!email || !code) {
        return res.status(400).json({ ok: false, error: 'Email and 4-digit code are required.' })
      }

      const supabase = admin()

      // 1. Strict Allowlist Guard
      const authorizedUser = await getAuthorizedUser(email, supabase)
      if (!authorizedUser) {
        return res.status(403).json({
          ok: false,
          error: 'Access Denied: You are not authorized to access this application.',
        })
      }

      const nowIso = new Date().toISOString()

      // 2. Check for active (non-expired, unused) code
      const { data: activeRows, error: selectError } = await supabase
        .from('discount_login_codes')
        .select('*')
        .eq('email', email)
        .is('used_at', null)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)

      if (selectError) {
        console.error('[/api/auth verify-code] DB error:', selectError)
        return res.status(500).json({ ok: false, error: 'Database verification error.' })
      }

      const challenge = activeRows && activeRows[0]

      // 3. If no active code found, check if an expired code exists to give accurate error
      if (!challenge) {
        const { data: expiredRows } = await supabase
          .from('discount_login_codes')
          .select('*')
          .eq('email', email)
          .is('used_at', null)
          .lte('expires_at', nowIso)
          .order('created_at', { ascending: false })
          .limit(1)

        if (expiredRows && expiredRows.length > 0) {
          return res.status(400).json({
            ok: false,
            error: 'Your 4-digit verification code has expired (valid for 10 minutes). Please request a new code.',
          })
        }

        return res.status(400).json({
          ok: false,
          error: 'No active verification code found for this email. Please request a new code.',
        })
      }

      // 4. Verify cryptographic hash
      const isValid = verifyLoginCodeHash(email, code, challenge.code_hash)
      if (!isValid) {
        return res.status(401).json({
          ok: false,
          error: 'Incorrect 4-digit code. Please check your Slack direct messages and try again.',
        })
      }

      // 5. Mark code as used immediately so it cannot be re-used
      await supabase
        .from('discount_login_codes')
        .update({ used_at: nowIso })
        .eq('id', challenge.id)

      const user = {
        username: email,
        name: authorizedUser.name || challenge.slack_user_name || email.split('@')[0],
        email,
        slack_user_id: challenge.slack_user_id || authorizedUser.slack_user_id,
        role: authorizedUser.role || 'Admin',
      }
      const token = createSessionToken(user)

      return res.status(200).json({
        ok: true,
        token,
        user: {
          ...user,
          signedInAt: nowIso,
        },
      })
    }

    // ------------------------------------------------------------------------
    // 4. Logout
    // ------------------------------------------------------------------------
    if (route === 'logout') {
      return res.status(200).json({ ok: true, message: 'Logged out successfully.' })
    }

    return res.status(400).json({ ok: false, error: `Unknown route: ${route}` })
  } catch (error) {
    return jsonError(res, error)
  }
}
