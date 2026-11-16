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
