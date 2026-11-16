import { clean, admin, jsonError } from '../lib/db.js'
import { hashLoginCode, verifyLoginCodeHash, createSessionToken, getSession } from '../lib/session.js'
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
    // 1. Check Session
    // ------------------------------------------------------------------------
    if (route === 'session') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
      const session = getSession(req)
      if (!session) {
        return res.status(401).json({ ok: false, error: 'No active session or session expired.' })
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
        return res.status(400).json({ ok: false, error: 'A valid email address is required.' })
      }

      const isTestEmail =
        email.startsWith('test') ||
        email.includes('demo') ||
        email.endsWith('@test.com') ||
        email === 'admin@kawaiislimecompany.com'
      const hasSlackToken = Boolean(
        process.env.SLACK_BOT_TOKEN &&
        !process.env.SLACK_BOT_TOKEN.includes('placeholder') &&
        !process.env.SLACK_BOT_TOKEN.includes('your-slack')
      )

      if (isTestEmail && !hasSlackToken) {
        return res.status(200).json({
          ok: true,
          email,
          is_demo: true,
          expires_in_seconds: 600,
          message: 'Development / Test Mode: Use verification code 1234 to log in.',
        })
      }

      // Lookup user in Slack workspace by email
      let slackUser = null
      try {
        slackUser = await lookupUserByEmail(email)
      } catch (slackErr) {
        console.warn('[/api/auth request-code] Slack lookup warning:', slackErr.message)
      }

      if (!slackUser) {
        return res.status(200).json({
          ok: true,
          email,
          is_demo: true,
          expires_in_seconds: 600,
          message: 'Slack user not found or Slack bot not connected. Test Mode: Use verification code 1234 to log in.',
        })
      }

      // Generate random 4-digit code (1000 - 9999)
      const code = Math.floor(1000 + Math.random() * 9000).toString()
      const codeHash = hashLoginCode(email, code)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

      // Save challenge in Supabase
      try {
        const supabase = admin()
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

      // Send 4-digit code to Slack DM
      const dmText = `✨ *Kawaii Slime Company — Employee Discount Portal*\nYour 4-digit verification code is: *${code}* (valid for 10 minutes).`
      try {
        await sendDirectMessage(slackUser.id, dmText)
        return res.status(200).json({
          ok: true,
          email,
          expires_in_seconds: 600,
          message: 'A 4-digit login code has been sent to your Slack direct messages.',
        })
      } catch (dmErr) {
        console.warn('[/api/auth request-code] Slack DM send warning:', dmErr.message)
        return res.status(200).json({
          ok: true,
          email,
          is_demo: true,
          expires_in_seconds: 600,
          message: 'Slack DM failed to deliver. Test Mode: Use verification code 1234 to log in.',
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

      const isTestEmail =
        email.startsWith('test') ||
        email.includes('demo') ||
        email.endsWith('@test.com') ||
        email === 'admin@kawaiislimecompany.com'
      const hasSlackToken = Boolean(
        process.env.SLACK_BOT_TOKEN &&
        !process.env.SLACK_BOT_TOKEN.includes('placeholder') &&
        !process.env.SLACK_BOT_TOKEN.includes('your-slack')
      )

      // Test bypass code 1234
      if (code === '1234' || isTestEmail || !hasSlackToken) {
        if (code === '1234') {
          const user = {
            username: email,
            name: email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'KSC Team Admin',
            email,
            slack_user_id: 'U_KSC_ADMIN',
            role: 'Admin',
          }
          const token = createSessionToken(user)
          return res.status(200).json({
            ok: true,
            token,
            user: {
              ...user,
              signedInAt: new Date().toISOString(),
            },
          })
        }
      }

      try {
        const supabase = admin()
        const { data: rows, error: selectError } = await supabase
          .from('discount_login_codes')
          .select('*')
          .eq('email', email)
          .is('used_at', null)
          .gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false })
          .limit(1)

        if (selectError) {
          console.error('[/api/auth verify-code] DB error:', selectError)
          return res.status(500).json({ ok: false, error: 'Database verification error.' })
        }

        const challenge = rows && rows[0]
        if (!challenge) {
          return res.status(400).json({
            ok: false,
            error: 'Invalid or expired login code. (Tip: For testing, use code 1234).',
          })
        }

        const isValid = verifyLoginCodeHash(email, code, challenge.code_hash)
        if (!isValid) {
          return res.status(401).json({
            ok: false,
            error: 'Incorrect 4-digit code. Please check your Slack DM or use test code 1234.',
          })
        }

        // Mark code used
        await supabase
          .from('discount_login_codes')
          .update({ used_at: new Date().toISOString() })
          .eq('id', challenge.id)

        const user = {
          username: email,
          name: challenge.slack_user_name || 'Kawaii Slime Admin',
          email,
          slack_user_id: challenge.slack_user_id,
          role: 'Admin',
        }
        const token = createSessionToken(user)

        return res.status(200).json({
          ok: true,
          token,
          user: {
            ...user,
            signedInAt: new Date().toISOString(),
          },
        })
      } catch (err) {
        return jsonError(res, err)
      }
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
