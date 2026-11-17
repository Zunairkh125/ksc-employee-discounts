import { clean, admin, jsonError } from '../../lib/db.js'
import {
  findOrCreateCustomerRest,
  generateEmpDiscountCode,
  createEmailLockedPriceRule,
} from '../../lib/shopify.js'

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
    const fullName = clean(req.body?.full_name || req.body?.name)
    const workEmail = clean(req.body?.work_email || req.body?.email).toLowerCase()
    const discountPercentage = Number(req.body?.discount_percentage ?? req.body?.discount_percent ?? 20)
    const monthlyCreditAmount = Number(req.body?.monthly_credit_amount ?? req.body?.monthly_credit ?? 25.0)
    const rawLocationType = clean(req.body?.location_type || 'local').toLowerCase()
    const locationType = rawLocationType.includes('remote') || rawLocationType.includes('shipping') ? 'remote' : 'local'

    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ success: false, error: 'Employee full name is required.' })
    }
    if (!workEmail || !workEmail.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid employee work email is required.' })
    }
    if (!Number.isFinite(discountPercentage) || discountPercentage <= 0 || discountPercentage > 100) {
      return res.status(400).json({ success: false, error: 'Discount percentage must be between 1 and 100.' })
    }

    const supabase = admin()

    // 0. Check for existing employee with this work_email to gracefully prevent duplicates
    let existingEmployee = null
    try {
      const { data: found } = await supabase
        .from('employees')
        .select('*')
        .eq('work_email', workEmail)
        .maybeSingle()
      existingEmployee = found
    } catch {
      // If employees table doesn't exist, check employee_discounts table
      try {
        const { data: foundAlt } = await supabase
          .from('employee_discounts')
          .select('*')
          .eq('work_email', workEmail)
          .maybeSingle()
        if (foundAlt) {
          existingEmployee = {
            id: foundAlt.id,
            full_name: foundAlt.employee_name,
            work_email: foundAlt.work_email,
            discount_code: foundAlt.discount_code,
          }
        }
      } catch {}
    }

    if (existingEmployee) {
      return res.status(409).json({
        success: false,
        error: `An employee with work email "${workEmail}" is already registered (Code: ${existingEmployee.discount_code}).`,
      })
    }

    // 1. Find or Create Shopify Customer
    const customer = await findOrCreateCustomerRest({
      email: workEmail,
      fullName,
    })
    const shopifyCustomerId = String(customer.id)

    // 2. Generate Unique Discount Code: EMP-{FIRSTNAME_UPPERCASE}-{4_DIGIT_RANDOM}
    const uniqueDiscountCode = generateEmpDiscountCode(fullName)

    // 3 & 4. Create Email-Locked Shopify Price Rule & Attach Discount Code
    const priceRuleResult = await createEmailLockedPriceRule({
      customerId: shopifyCustomerId,
      discountPercentage,
      uniqueCode: uniqueDiscountCode,
    })

    const shopifyPriceRuleId = String(priceRuleResult.priceRuleId)

    // 5. Save to Supabase (public.employees)
    const employeeRecord = {
      full_name: fullName,
      work_email: workEmail,
      shopify_customer_id: shopifyCustomerId,
      shopify_price_rule_id: shopifyPriceRuleId,
      discount_code: uniqueDiscountCode,
      discount_percentage: discountPercentage,
      monthly_credit_amount: monthlyCreditAmount,
      location_type: locationType,
      status: 'active',
    }

    let savedEmployee = null
    let saveError = null

    // Try inserting into `employees`
    try {
      const { data: emp, error: err } = await supabase
        .from('employees')
        .insert(employeeRecord)
        .select()
        .single()
      if (err) saveError = err
      else savedEmployee = emp
    } catch (e) {
      saveError = e
    }

    // If table `employees` had an error (e.g. table not created yet or different schema),
    // also write to `employee_discounts` to ensure continuous data integrity
    try {
      const fallbackRecord = {
        employee_name: fullName,
        work_email: workEmail,
        shopify_customer_id: shopifyCustomerId,
        shopify_discount_id: shopifyPriceRuleId,
        discount_code: uniqueDiscountCode,
        discount_percent: discountPercentage,
        total_credit_issued: 0,
        status: 'Active',
      }
      const { data: altEmp } = await supabase
        .from('employee_discounts')
        .insert(fallbackRecord)
        .select()
        .single()

      if (!savedEmployee && altEmp) {
        savedEmployee = {
          id: altEmp.id,
          full_name: altEmp.employee_name,
          work_email: altEmp.work_email,
          shopify_customer_id: altEmp.shopify_customer_id,
          shopify_price_rule_id: shopifyPriceRuleId,
          discount_code: altEmp.discount_code,
          discount_percentage: altEmp.discount_percent,
          monthly_credit_amount: monthlyCreditAmount,
          location_type: locationType,
          status: 'active',
          created_at: altEmp.created_at,
        }
        saveError = null
      }
    } catch {}

    if (saveError && !savedEmployee) {
      if (saveError.code === '23505' || String(saveError.message).includes('duplicate key')) {
        return res.status(409).json({
          success: false,
          error: `Employee with email "${workEmail}" already exists in the database.`,
        })
      }
      return res.status(500).json({
        success: false,
        error: `Database save failed: ${saveError.message || saveError}`,
      })
    }

    return res.status(201).json({
      success: true,
      message: `Successfully created email-locked discount code ${uniqueDiscountCode} for ${fullName}!`,
      employee: savedEmployee || {
        ...employeeRecord,
        id: `emp_${Date.now()}`,
        created_at: new Date().toISOString(),
      },
    })
  } catch (error) {
    return jsonError(res, error)
  }
}
