import crypto from 'node:crypto'

const TOKEN_EXPIRY_HOURS = 24
const ALLOWED_ROLES = ['Admin', 'Supervisor', 'Payroll', 'HR', 'Employee', 'IT']

function getSecret() {
  const secret = process.env.FINANCE_SESSION_SECRET || process.env.HQ_SESSION_SECRET
  if (!secret) {
    return 'ksc-discount-session-secret-fallback-key'
  }
  return secret
}

export function hashLoginCode(email, code) {
  const secret = getSecret()
  const cleanEmail = String(email || '').trim().toLowerCase()
  const cleanCode = String(code || '').trim()
  return crypto.createHmac('sha256', secret).update(`discount:${cleanEmail}:${cleanCode}`).digest('hex')
}

export function verifyLoginCodeHash(email, code, storedHash) {
  if (!storedHash) return false
  const expected = hashLoginCode(email, code)
  const a = Buffer.from(expected)
  const b = Buffer.from(storedHash)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function createSessionToken(user = {}) {
  const role = user.role || 'Admin'
  const payload = {
    username: user.username || user.email || 'discount_admin',
    name: user.name || 'Kawaii Slime Admin',
    email: user.email || '',
    slack_user_id: user.slack_user_id || '',
    role,
    exp: Date.now() + TOKEN_EXPIRY_HOURS * 3600 * 1000,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  if (!body || !sig) return null

  try {
    const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Date.now()) {
      return null
    }

    if (!ALLOWED_ROLES.includes(payload.role)) {
      return null
    }

    return payload
  } catch (err) {
    console.error('[Session] Token verification error:', err.message)
    return null
  }
}

export function getSession(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim())
  const token = match ? match[1] : (req.query?.token || null)
  return verifySessionToken(token)
}

/**
 * Check if an email is authorized to access the Admin Dashboard
 * 1. Checks ALLOWED_LOGIN_EMAILS env variable
 * 2. Checks Supabase `authorized_users` table where is_active = true
 */
export async function isEmailAuthorized(email, supabase = null) {
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanEmail || !cleanEmail.includes('@')) return false

  // 1. Check ALLOWED_LOGIN_EMAILS env variable (with default core team fallback)
  const rawAllowed =
    process.env.ALLOWED_LOGIN_EMAILS ||
    'zunair@kawaiislimecompany.com,junaid@kawaiislimecompany.com,april@kawaiislimecompany.com,admin@kawaiislimecompany.com'
  const allowedList = rawAllowed
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  if (allowedList.includes(cleanEmail)) {
    return true
  }

  // 2. Check Supabase `authorized_users` table if available
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('authorized_users')
        .select('id, email, is_active')
        .eq('email', cleanEmail)
        .maybeSingle()

      if (!error && data && data.is_active !== false) {
        return true
      }
    } catch {}
  }

  return false
}

/**
 * Get authorized user record (from DB or env)
 */
export async function getAuthorizedUser(email, supabase = null) {
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanEmail || !cleanEmail.includes('@')) return null

  // 1. Try Supabase `authorized_users` table first
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('authorized_users')
        .select('*')
        .eq('email', cleanEmail)
        .maybeSingle()

      if (!error && data && data.is_active !== false) {
        return {
          id: data.id,
          email: data.email,
          name: data.name || cleanEmail.split('@')[0],
          role: data.role || 'Admin',
          slack_user_id: data.slack_user_id || null,
          is_active: true,
        }
      }
    } catch {}
  }

  // 2. Check ALLOWED_LOGIN_EMAILS env fallback
  const rawAllowed =
    process.env.ALLOWED_LOGIN_EMAILS ||
    'zunair@kawaiislimecompany.com,junaid@kawaiislimecompany.com,april@kawaiislimecompany.com,admin@kawaiislimecompany.com'
  const allowedList = rawAllowed
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  if (allowedList.includes(cleanEmail)) {
    const formattedName = cleanEmail
      .split('@')[0]
      .replace(/[._-]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())

    return {
      id: `auth_${cleanEmail}`,
      email: cleanEmail,
      name: formattedName || 'KSC Team Admin',
      role: 'Admin',
      slack_user_id: null,
      is_active: true,
    }
  }

  return null
}
