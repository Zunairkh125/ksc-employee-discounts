import { createClient } from '@supabase/supabase-js'

export function clean(value) {
  return String(value ?? '').trim()
}

export function admin() {
  const url = clean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)
  const key = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY)
  if (!url || !key) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.')
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  })
}

export function jsonError(res, error, status = 500) {
  console.error('[API Error]', error)
  const message = error instanceof Error ? error.message : String(error || 'Internal server error')
  return res.status(status).json({ ok: false, error: message })
}
