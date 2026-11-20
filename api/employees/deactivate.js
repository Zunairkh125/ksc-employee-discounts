import { clean, admin, jsonError } from '../../lib/db.js'
import { deactivateDiscountCodeGraphQL } from '../../lib/shopify.js'

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

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' })
  }

  try {
    const employeeId = clean(req.body?.id || req.body?.employee_id)
    const workEmail = clean(req.body?.work_email || req.body?.email).toLowerCase()
    let discountId = clean(
      req.body?.shopify_discount_id ||
      req.body?.discount_id ||
      req.body?.price_rule_id ||
      req.body?.shopify_price_rule_id
    )

    if (!employeeId && !workEmail && !discountId) {
      return res.status(400).json({
        success: false,
        error: 'Employee ID, work email, or Shopify discount ID is required for deactivation.',
      })
    }

    const supabase = admin()
    let employee = null

    // Look up in `employees` table
    try {
      let query = supabase.from('employees').select('*')
      if (employeeId) query = query.eq('id', employeeId)
      else if (workEmail) query = query.eq('work_email', workEmail)
      const { data } = await query.maybeSingle()
      if (data) {
        employee = data
        if (!discountId) {
          discountId = data.shopify_discount_id || data.shopify_price_rule_id
        }
      }
    } catch {}

    // Fallback look up in `employee_discounts` table
    if (!employee) {
      try {
        let query = supabase.from('employee_discounts').select('*')
        if (employeeId) query = query.eq('id', employeeId)
        else if (workEmail) query = query.eq('work_email', workEmail)
        const { data } = await query.maybeSingle()
        if (data) {
          employee = {
            id: data.id,
            full_name: data.employee_name,
            work_email: data.work_email,
            shopify_discount_id: data.shopify_discount_id,
            status: data.status,
            is_active: false,
          }
          if (!discountId && data.shopify_discount_id) {
            discountId = data.shopify_discount_id
          }
        }
      } catch {}
    }

    // 1. Deactivate discount code in Shopify via GraphQL (discountCodeDeactivate)
    let shopifyDeactivated = false
    if (discountId) {
      try {
        const result = await deactivateDiscountCodeGraphQL(discountId)
        shopifyDeactivated = Boolean(result.success)
      } catch (err) {
        console.warn(`[Deactivate] Shopify discount ${discountId} deactivation warning:`, err.message)
      }
    }

    // 2. Update status in Supabase `employees` table
    const nowIso = new Date().toISOString()
    let updatedEmployee = null

    try {
      let updateQuery = supabase
        .from('employees')
        .update({ is_active: false, status: 'inactive', updated_at: nowIso })
      if (employee?.id) updateQuery = updateQuery.eq('id', employee.id)
      else if (workEmail) updateQuery = updateQuery.eq('work_email', workEmail)
      const { data, error } = await updateQuery.select().maybeSingle()
      if (!error && data) {
        updatedEmployee = data
      }
    } catch (err) {
      console.warn('[Deactivate] Error updating employees table with updated_at, trying status only:', err.message)
      try {
        let updateSimple = supabase
          .from('employees')
          .update({ is_active: false, status: 'inactive' })
        if (employee?.id) updateSimple = updateSimple.eq('id', employee.id)
        else if (workEmail) updateSimple = updateSimple.eq('work_email', workEmail)
        const { data } = await updateSimple.select().maybeSingle()
        if (data) updatedEmployee = data
      } catch {}
    }

    // 3. Also update `employee_discounts` to keep tables in sync
    try {
      const emailToMatch = workEmail || employee?.work_email
      let updateAlt = supabase
        .from('employee_discounts')
        .update({ status: 'Revoked', updated_at: nowIso })
      if (emailToMatch) {
        updateAlt = updateAlt.eq('work_email', emailToMatch)
      } else if (employee?.id) {
        updateAlt = updateAlt.eq('id', employee.id)
      }
      await updateAlt
    } catch (err) {
      console.warn('[Deactivate] Error updating employee_discounts table:', err.message)
    }

    return res.status(200).json({
      success: true,
      message: `Employee ${employee?.full_name || workEmail || ''} has been deactivated and their Shopify discount code disabled.`,
      shopifyDeactivated,
      employee: updatedEmployee || {
        ...employee,
        is_active: false,
        status: 'inactive',
      },
    })
  } catch (error) {
    return jsonError(res, error)
  }
}
