import crypto from 'node:crypto'
import { clean } from './db.js'

export async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
  if (typeof req.body === 'object' && req.body !== null) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(req.body)) {
      params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    return params.toString()
  }
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function verifySlackSignature(rawBody, headers, now = Date.now()) {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret) {
    console.warn('[Slack] SLACK_SIGNING_SECRET is not configured.')
    return false
  }

  const timestamp = String(headers['x-slack-request-timestamp'] || '')
  const signature = String(headers['x-slack-signature'] || '')
  if (!timestamp || !signature) return false

  // 5-minute replay window check
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) {
    console.warn('[Slack] Timestamp replay check failed.')
    return false
  }

  const sigBase = `v0:${timestamp}:${rawBody}`
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn('[Slack] Invalid signature verification.')
    return false
  }
  return true
}

export async function slackAPI(method, body = {}, isForm = false) {
  const token = clean(process.env.SLACK_BOT_TOKEN)
  if (!token) throw new Error('SLACK_BOT_TOKEN is not configured.')

  let requestBody
  const headers = { Authorization: `Bearer ${token}` }

  if (isForm) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null && v !== '') {
        params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
    }
    requestBody = params.toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'
  } else {
    requestBody = JSON.stringify(body)
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers,
    body: requestBody,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    const errDetail = (data.response_metadata?.messages || []).join(' ')
    const errMsg = data.error || `Slack ${method} failed with HTTP ${res.status}`
    throw new Error(errDetail ? `${errMsg} (${errDetail})` : errMsg)
  }
  return data
}

export async function lookupUserByEmail(email) {
  const token = clean(process.env.SLACK_BOT_TOKEN)
  if (!token) return null

  const address = String(email || '').trim().toLowerCase()
  const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(address)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    if (data.error === 'users_not_found') {
      return null
    }
    if (data.error === 'missing_scope') {
      console.warn('[Slack] Missing users:read.email scope.')
      return null
    }
    console.warn('[Slack] users.lookupByEmail error:', data.error)
    return null
  }

  const user = data.user
  if (!user || user.deleted) return null
  return {
    id: user.id,
    name: user.profile?.real_name || user.real_name || user.name || address,
    email: user.profile?.email ? String(user.profile.email).toLowerCase() : address,
    real_name: user.profile?.real_name || user.real_name || user.name || 'Team Member',
  }
}

export async function openDirectMessage(userId) {
  const data = await slackAPI('conversations.open', { users: userId })
  if (!data.channel?.id) throw new Error('Failed to open DM channel with user.')
  return data.channel.id
}

export async function sendDirectMessage(userId, text, blocks = null) {
  const channelId = await openDirectMessage(userId)
  const payload = {
    channel: channelId,
    text,
  }
  if (blocks) payload.blocks = blocks
  return slackAPI('chat.postMessage', payload)
}

export async function postMessage(channel, text, blocks = null) {
  const payload = { channel, text }
  if (blocks) payload.blocks = blocks
  return slackAPI('chat.postMessage', payload)
}
