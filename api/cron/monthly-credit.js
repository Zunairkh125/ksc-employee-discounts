import { clean, admin, jsonError } from '../../lib/db.js'
import { issueStoreCreditGraphQL } from '../../lib/shopify.js'
import { lookupUserByEmail, sendDirectMessage } from '../../lib/slack.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, X-Cron-Secret'
  )

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // 1. Authorize: Verify CRON_SECRET
  const cronSecret = clean(process.env.CRON_SECRET)
  const authHeader = clean(req.headers?.authorization || req.headers?.Authorization)
  const xCronSecret = clean(req.headers?.['x-cron-secret'])
  const querySecret = clean(req.query?.secret)

  const isAuthorized =
    !cronSecret ||
    authHeader === `Bearer ${cronSecret}` ||
    xCronSecret === cronSecret ||
    querySecret === cronSecret

  if (!isAuthorized) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized. Valid CRON_SECRET is required to execute the monthly credit job.',
    })
  }

  try {
    const supabase = admin()

    // 2. Read configured monthly store credit amount from discount_settings
    let monthlyAmount = 25.0
    try {
      const { data: settings } = await supabase
        .from('discount_settings')
        .select('*')
        .eq('id', 'default')
        .maybeSingle()
      if (settings?.monthly_store_credit_amount) {
        monthlyAmount = Number(settings.monthly_store_credit_amount)
      }
    } catch (e) {
      console.warn('[Monthly Cron] Failed reading discount_settings, using default $25.00:', e.message)
    }

    if (monthlyAmount <= 0) {
      return res.status(200).json({
        success: true,
        message: 'Monthly store credit amount is configured to $0.00. No credits issued.',
        totalProcessed: 0,
      })
    }

    // 3. Fetch all active employees from `employees` table
    let activeEmployees = []
    try {
      const { data: emps, error } = await supabase
        .from('employees')
        .select('*')
      if (!error && Array.isArray(emps) && emps.length > 0) {
        activeEmployees = emps.filter(
          (e) =>
            e.is_active !== false &&
            String(e.status || '').toLowerCase() !== 'inactive' &&
            String(e.status || '').toLowerCase() !== 'revoked'
        )
      }
    } catch (e) {
      console.warn('[Monthly Cron] Error reading employees table:', e.message)
    }

    // Fallback to employee_discounts table if employees table empty
    if (activeEmployees.length === 0) {
      try {
        const { data: legacyEmps } = await supabase
          .from('employee_discounts')
          .select('*')
          .eq('status', 'Active')
        if (Array.isArray(legacyEmps)) {
          activeEmployees = legacyEmps.map((l) => ({
            id: l.id,
            full_name: l.employee_name,
            work_email: l.work_email,
            shopify_customer_id: l.shopify_customer_id,
            discount_code: l.discount_code,
            discount_percentage: l.discount_percent,
            monthly_credit_amount: monthlyAmount,
            slack_user_id: l.slack_user_id,
            is_active: true,
            status: 'active',
          }))
        }
      } catch (e) {
        console.warn('[Monthly Cron] Error reading employee_discounts table:', e.message)
      }
    }

    let creditedCount = 0
    let failedCount = 0
    const results = []
    const nowIso = new Date().toISOString()

    for (const emp of activeEmployees) {
      const empName = emp.full_name || emp.work_email
      const customerId = emp.shopify_customer_id
      const rawCredit = emp.monthly_credit_amount
      const amountToCredit =
        rawCredit !== null && rawCredit !== undefined && !isNaN(Number(rawCredit))
          ? Number(rawCredit)
          : monthlyAmount

      if (amountToCredit <= 0) {
        results.push({
          email: emp.work_email,
          status: 'Skipped',
          reason: '$0 monthly credit configured for employee',
        })
        continue
      }

      if (!customerId) {
        failedCount++
        results.push({
          email: emp.work_email,
          status: 'Failed',
          error: 'Missing Shopify Customer ID',
        })
        continue
      }

      try {
        // Credit native Shopify Store Credit via GraphQL mutation
        const tx = await issueStoreCreditGraphQL({
          customerId,
          amount: amountToCredit,
          currencyCode: 'USD',
        })

        // A. Insert into credit_ledger
        try {
          await supabase.from('credit_ledger').insert({
            employee_id: emp.id,
            amount: amountToCredit,
            type: 'monthly_credit',
            shopify_transaction_id: tx.transactionId,
            created_at: nowIso,
          })
        } catch (ledgerErr) {
          console.warn('[Monthly Cron] credit_ledger insert warning:', ledgerErr.message)
        }

        // B. Insert into store_credit_logs (audit log)
        try {
          await supabase.from('store_credit_logs').insert({
            employee_id: emp.id,
            employee_name: empName,
            work_email: emp.work_email,
            amount: amountToCredit,
            reason: 'Monthly Employee Store Credit (Automated Cron)',
            shopify_transaction_id: tx.transactionId,
            status: 'Success',
            created_at: nowIso,
          })
        } catch (logErr) {
          console.warn('[Monthly Cron] store_credit_logs insert warning:', logErr.message)
        }

        // C. Update employee last_credited_at in Supabase
        try {
          await supabase
            .from('employees')
            .update({ last_credited_at: nowIso, updated_at: nowIso })
            .eq('id', emp.id)
        } catch {}

        try {
          await supabase
            .from('employee_discounts')
            .update({ last_credit_issued_at: nowIso, updated_at: nowIso })
            .eq('work_email', emp.work_email)
        } catch {}

        // D. Send Slack DM notification to employee
        let slackTarget = emp.slack_user_id
        if (!slackTarget && emp.work_email) {
          const found = await lookupUserByEmail(emp.work_email).catch(() => null)
          slackTarget = found?.id
        }
        if (slackTarget) {
          const msg =
            `✨ *Kawaii Slime Company Monthly Store Credit Deposited!* ✨\n` +
            `Hi ${empName}! Your monthly store credit of *$${amountToCredit.toFixed(2)}* has just been added to your Shopify account.\n\n` +
            `• *Discount Code:* \`${emp.discount_code || 'EMP-DISCOUNT'}\`\n` +
            `• *How to Use:* Head to *kawaiislimecompany.com* using your work email (*${emp.work_email}*). Your store credit stacks right at checkout!\n` +
            `• *Pickup/Shipping:* Select *Local Pickup* at checkout for warehouse collection, or home shipping for delivery.`
          sendDirectMessage(slackTarget, msg).catch(() => {})
        }

        creditedCount++
        results.push({
          email: emp.work_email,
          status: 'Success',
          amount: amountToCredit,
          transactionId: tx.transactionId,
        })
      } catch (creditErr) {
        failedCount++
        results.push({
          email: emp.work_email,
          status: 'Failed',
          error: creditErr.message,
        })

        try {
          await supabase.from('store_credit_logs').insert({
            employee_id: emp.id,
            employee_name: empName,
            work_email: emp.work_email,
            amount: amountToCredit,
            reason: 'Monthly Employee Store Credit (Automated Cron)',
            status: 'Failed',
            error_message: creditErr.message,
            created_at: nowIso,
          })
        } catch {}
      }
    }

    return res.status(200).json({
      success: true,
      message: `Monthly store credit run complete. Processed ${activeEmployees.length} active employees.`,
      summary: {
        totalEmployees: activeEmployees.length,
        creditedCount,
        failedCount,
        monthlyAmount,
        totalDisbursed: creditedCount * monthlyAmount,
      },
      results,
    })
  } catch (error) {
    return jsonError(res, error)
  }
}
