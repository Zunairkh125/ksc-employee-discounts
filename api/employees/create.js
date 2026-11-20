import { clean, admin, jsonError } from '../../lib/db.js'
import { lookupUserByEmail, sendDirectMessage } from '../../lib/slack.js'
import { buildWelcomeSlackMessage } from '../webhooks/slack.js'
import {
  findOrCreateCustomerGraphQL,
  generateEmpDiscountCode,
  createEmailLockedDiscountGraphQL,
  issueStoreCreditGraphQL,
  activateDiscountCodeGraphQL,
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

    // 0. Check for existing employee with this work_email
    let existingEmployee = null
    try {
      const { data: found } = await supabase
        .from('employees')
        .select('*')
        .eq('work_email', workEmail)
        .maybeSingle()
      if (found) existingEmployee = found
    } catch {}

    if (!existingEmployee) {
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
            status: foundAlt.status,
            is_active: String(foundAlt.status).toLowerCase() === 'active',
          }
        }
      } catch {}
    }

    const isReactivating =
      existingEmployee &&
      (existingEmployee.is_active === false ||
        String(existingEmployee.status).toLowerCase() === 'inactive' ||
        String(existingEmployee.status).toLowerCase() === 'revoked')

    if (existingEmployee && !isReactivating) {
      return res.status(409).json({
        success: false,
        error: `An employee with work email "${workEmail}" is already registered (Code: ${existingEmployee.discount_code}).`,
      })
    }

    // 1. Find or Create Shopify Customer via GraphQL (customerCreate)
    const customer = await findOrCreateCustomerGraphQL({
      email: workEmail,
      fullName,
    })
    const shopifyCustomerId = String(customer.id)

    // 2. Generate Unique Discount Code: EMP-{FIRSTNAME_UPPERCASE}-{4_DIGIT_RANDOM}
    const uniqueDiscountCode = generateEmpDiscountCode(fullName)

    // 3. Create Email-Locked Discount Code in Shopify via GraphQL (discountCodeBasicCreate)
    // Strictly locks customerSelection to [shopifyCustomerId]
    const discountResult = await createEmailLockedDiscountGraphQL({
      customerId: shopifyCustomerId,
      employeeName: fullName,
      workEmail,
      discountPercentage,
      uniqueCode: uniqueDiscountCode,
    })

    const shopifyDiscountId = String(discountResult.discountId)

    // If reactivating an existing discount in Shopify
    if (isReactivating && existingEmployee?.shopify_discount_id) {
      await activateDiscountCodeGraphQL(existingEmployee.shopify_discount_id).catch(() => {})
    }

    // 4. Credit initial store credit balance via Shopify GraphQL (storeCreditAccountCredit)
    let creditTransaction = null
    if (monthlyCreditAmount > 0) {
      try {
        creditTransaction = await issueStoreCreditGraphQL({
          customerId: shopifyCustomerId,
          amount: monthlyCreditAmount,
          currencyCode: 'USD',
        })
      } catch (creditErr) {
        console.warn('[Create Employee] Store credit issuance warning:', creditErr.message)
      }
    }

    const nowIso = new Date().toISOString()

    // 5. Save to Supabase (public.employees)
    const employeeRecord = {
      full_name: fullName,
      work_email: workEmail,
      shopify_customer_id: shopifyCustomerId,
      shopify_discount_id: shopifyDiscountId,
      shopify_price_rule_id: shopifyDiscountId,
      discount_code: uniqueDiscountCode,
      discount_percentage: discountPercentage,
      monthly_credit_amount: monthlyCreditAmount,
      location_type: locationType,
      is_active: true,
      status: 'active',
      last_credited_at: creditTransaction ? nowIso : null,
      updated_at: nowIso,
    }

    let savedEmployee = null
    let saveError = null

    try {
      let op = null
      if (isReactivating && existingEmployee?.id) {
        op = supabase.from('employees').update(employeeRecord).eq('id', existingEmployee.id)
      } else {
        op = supabase.from('employees').insert(employeeRecord)
      }

      const { data: emp, error: err } = await op.select().single()

      if (!err && emp) {
        savedEmployee = emp
      } else if (err && String(err.message).includes('shopify_discount_id')) {
        // Fallback if DB doesn't have shopify_discount_id column
        const { shopify_discount_id: _omitted, ...reducedRecord } = employeeRecord
        let retryOp = null
        if (isReactivating && existingEmployee?.id) {
          retryOp = supabase.from('employees').update(reducedRecord).eq('id', existingEmployee.id)
        } else {
          retryOp = supabase.from('employees').insert(reducedRecord)
        }
        const { data: retryEmp, error: retryErr } = await retryOp.select().single()
        if (!retryErr && retryEmp) {
          savedEmployee = { ...retryEmp, shopify_discount_id: shopifyDiscountId }
        } else {
          saveError = retryErr
        }
      } else {
        saveError = err
      }
    } catch (e) {
      saveError = e
    }

    const targetEmpId = savedEmployee?.id || existingEmployee?.id

    // 6. Record in credit_ledger if initial store credit was issued
    if (creditTransaction && targetEmpId) {
      try {
        await supabase.from('credit_ledger').insert({
          employee_id: targetEmpId,
          amount: monthlyCreditAmount,
          type: 'initial_credit',
          shopify_transaction_id: creditTransaction.transactionId,
          created_at: nowIso,
        })
      } catch (ledgerErr) {
        console.warn('[Create Employee] credit_ledger insert warning:', ledgerErr.message)
      }
    }

    // 7. Record in store_credit_logs (audit log)
    if (creditTransaction) {
      try {
        await supabase.from('store_credit_logs').insert({
          employee_id: targetEmpId,
          employee_name: fullName,
          work_email: workEmail,
          amount: monthlyCreditAmount,
          reason: 'Initial Employee Store Credit (Onboarding)',
          shopify_transaction_id: creditTransaction.transactionId,
          status: 'Success',
          created_at: nowIso,
        })
      } catch (logErr) {
        console.warn('[Create Employee] store_credit_logs insert warning:', logErr.message)
      }
    }

    // 8. Backward compatibility sync to employee_discounts
    try {
      const fallbackRecord = {
        employee_name: fullName,
        work_email: workEmail,
        shopify_customer_id: shopifyCustomerId,
        shopify_discount_id: shopifyDiscountId,
        discount_code: uniqueDiscountCode,
        discount_percent: discountPercentage,
        total_credit_issued: creditTransaction ? monthlyCreditAmount : 0,
        last_credit_issued_at: creditTransaction ? nowIso : null,
        status: 'Active',
      }
      const { data: altEmp } = await supabase
        .from('employee_discounts')
        .upsert(fallbackRecord, { onConflict: 'work_email' })
        .select()
        .single()

      if (!savedEmployee && altEmp) {
        savedEmployee = {
          id: altEmp.id,
          full_name: altEmp.employee_name,
          work_email: altEmp.work_email,
          shopify_customer_id: altEmp.shopify_customer_id,
          shopify_discount_id: altEmp.shopify_discount_id,
          discount_code: altEmp.discount_code,
          discount_percentage: altEmp.discount_percent,
          monthly_credit_amount: monthlyCreditAmount,
          location_type: locationType,
          is_active: true,
          status: 'active',
        }
      }
    } catch (e) {
      console.warn('[Sync employee_discounts warning]:', e.message)
    }

    // 9. Look up Slack user and send Welcome DM if found
    let slackUserId = null
    try {
      const slackUser = await lookupUserByEmail(workEmail).catch(() => null)
      if (slackUser?.id) {
        slackUserId = slackUser.id
        if (targetEmpId) {
          await supabase
            .from('employees')
            .update({ slack_user_id: slackUserId })
            .eq('id', targetEmpId)
            .catch(() => {})
        }
        const dmText = buildWelcomeSlackMessage({
          employeeName: fullName,
          discountCode: uniqueDiscountCode,
          discountPercent: discountPercentage,
          creditAmount: monthlyCreditAmount,
          workEmail,
        })
        await sendDirectMessage(slackUserId, dmText).catch(() => {})
      }
    } catch (slackErr) {
      console.warn('[Create Employee] Slack DM notification warning:', slackErr.message)
    }

    return res.status(201).json({
      success: true,
      message: `Successfully created email-locked discount code ${uniqueDiscountCode} for ${fullName}!`,
      employee: {
        ...(savedEmployee || employeeRecord),
        id: targetEmpId || `mock_${Date.now()}`,
        slack_user_id: slackUserId || savedEmployee?.slack_user_id || null,
      },
      creditTransaction,
    })
  } catch (error) {
    return jsonError(res, error)
  }
}
