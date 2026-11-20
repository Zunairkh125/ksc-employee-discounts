import { createClient } from '@supabase/supabase-js'

export function clean(value) {
  return String(value ?? '').trim()
}

function createMockSupabaseClient() {
  const store = []
  const createChain = () => {
    const chain = {
      eq: () => chain,
      neq: () => chain,
      gt: () => chain,
      gte: () => chain,
      lt: () => chain,
      lte: () => chain,
      is: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve) => resolve({ data: store, error: null }),
    }
    return chain
  }

  const mockTable = {
    insert: (records) => {
      const rec = Array.isArray(records) ? records[0] : records
      const saved = {
        ...rec,
        id: rec.id || `mock_${Date.now()}`,
        created_at: rec.created_at || new Date().toISOString(),
        status: rec.status || 'active',
      }
      store.push(saved)
      return {
        select: () => ({
          single: async () => ({ data: saved, error: null }),
          maybeSingle: async () => ({ data: saved, error: null }),
        }),
        then: (resolve) => resolve({ data: saved, error: null }),
      }
    },
    select: () => createChain(),
    update: (updates) => ({
      eq: () => ({
        select: () => ({
          maybeSingle: async () => ({ data: { ...updates, id: 'mock_123' }, error: null }),
          single: async () => ({ data: { ...updates, id: 'mock_123' }, error: null }),
        }),
        is: () => Promise.resolve({ data: null, error: null }),
        then: (resolve) => resolve({ data: updates, error: null }),
      }),
      is: () => ({
        eq: () => Promise.resolve({ data: updates, error: null }),
        then: (resolve) => resolve({ data: updates, error: null }),
      }),
    }),
    upsert: (record) => ({
      select: () => ({
        single: async () => ({ data: record, error: null }),
      }),
      then: (resolve) => resolve({ data: record, error: null }),
    }),
    delete: () => ({
      eq: () => Promise.resolve({ data: null, error: null }),
    }),
  }

  return {
    from: () => mockTable,
  }
}

export function admin() {
  const url = clean(
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL
  )
  const key = clean(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY
  )

  const isMock = !url || !key || url.includes('your-project') || url.includes('realproject')
  if (isMock) {
    return createMockSupabaseClient()
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  })
}

export function jsonError(res, error, status = 500) {
  console.error('[API Error]', error)
  const message = error instanceof Error ? error.message : String(error || 'Internal server error')
  return res.status(status).json({ ok: false, success: false, error: message })
}
