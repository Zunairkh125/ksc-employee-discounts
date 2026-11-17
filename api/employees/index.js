import { admin, jsonError } from '../../lib/db.js'

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

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' })
  }

  try {
    const supabase = admin()
    let employeesList = []

    // Fetch from `employees` table
    try {
      const { data, error } = await supabase
        .from('employees')
        .select('*')
        .order('created_at', { ascending: false })
      if (!error && Array.isArray(data)) {
        employeesList = data
      }
    } catch {}

    // Fallback or merge with `employee_discounts` table
    if (employeesList.length === 0) {
      try {
        const { data: altData } = await supabase
          .from('employee_discounts')
          .select('*')
          .order('created_at', { ascending: false })

        if (Array.isArray(altData)) {
          employeesList = altData.map((d) => ({
            id: d.id,
            full_name: d.employee_name,
            work_email: d.work_email,
            shopify_customer_id: d.shopify_customer_id,
            shopify_price_rule_id: d.shopify_discount_id,
            discount_code: d.discount_code,
            discount_percentage: d.discount_percent,
            monthly_credit_amount: 25.0,
            location_type: 'local',
            status: d.status === 'Revoked' ? 'inactive' : 'active',
            created_at: d.created_at,
          }))
        }
      } catch {}
    }

    return res.status(200).json({
      success: true,
      employees: employeesList,
    })
  } catch (error) {
    return jsonError(res, error)
  }
}
