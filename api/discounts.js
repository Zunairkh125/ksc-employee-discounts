import { clean, admin, jsonError } from '../lib/db.js'
import { getSession } from '../lib/session.js'
import { lookupUserByEmail, sendDirectMessage } from '../lib/slack.js'
import {
  findOrCreateCustomer,
  createEmailLockedDiscountCode,
  issueStoreCredit,
  deactivateDiscountCode,
  activateDiscountCode,
} from '../lib/shopify.js'

function getAuth(req) {
  const cronSecret = clean(process.env.CRON_SECRET)
  const authHeader = clean(req.headers?.authorization || req.headers?.Authorization)
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { isCron: true, user: { name: 'Vercel Cron Service', role: 'System' } }
  }
  const session = getSession(req)
  if (session) return { isCron: false, user: session }

  // Allow fallback in development if no Supabase configured yet
  const hasSupabase = Boolean(process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('your-supabase'))
  if (!hasSupabase) {
    return { isDev: true, user: { name: 'KSC Dev Admin', role: 'Admin' } }
  }
  return null
}

function buildWelcomeSlackMessage({ employeeName, discountCode, discountPercent, creditAmount, workEmail }) {
  return (
    `🎉 *Welcome to the Kawaii Slime Company Team, ${employeeName}!* 🎉\n\n` +
    `Here are your exclusive employee shopping perks:\n\n` +
    `• *Your Unique Discount Code:* \`${discountCode}\` (*${discountPercent}% OFF*)\n` +
    `• *Email Lock:* This code is locked strictly to your work email (*${workEmail}*) at checkout.\n` +
    (creditAmount > 0
      ? `• *Store Credit Added:* We have also added *$${Number(creditAmount).toFixed(2)}* in Store Credit to your Shopify account!\n\n`
      : `\n`) +
    `📦 *How to Order:*\n` +
    `1. Visit *kawaiislimecompany.com* and shop with your email (*${workEmail}*).\n` +
    `2. Apply your code \`${discountCode}\` at checkout.\n` +
    `3. *Local Staff (Warehouse Pickup):* Select *Local Pickup* at checkout to pick up directly at the warehouse.\n` +
    `4. *Out-of-State / International Staff (Home Shipping):* Enter your home shipping address at checkout.\n\n` +
    `Enjoy your employee perks! If you have any questions, reach out to HR or Operations.`
  )
}

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

  const route = clean(req.query?.route || 'data').toLowerCase()
  const auth = getAuth(req)

  if (!auth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: valid session or secret required.' })
  }

  try {
    const supabase = admin()

    // ------------------------------------------------------------------------
    // 1. Fetch Dashboard Data (Settings, Employees, Recent Logs)
    // ------------------------------------------------------------------------
    if (route === 'data') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

      // Fetch or initialize settings
      let { data: settings, error: settingsErr } = await supabase
        .from('discount_settings')
        .select('*')
        .eq('id', 'default')
        .single()

      if (settingsErr || !settings) {
        settings = {
          id: 'default',
          employee_discount_percent: 20,
          monthly_store_credit_amount: 25.0,
          updated_at: new Date().toISOString(),
          updated_by: 'System',
        }
        try {
          await supabase.from('discount_settings').upsert(settings)
        } catch (e) {
          console.warn('Settings upsert warning:', e.message)
        }
      }

      // Fetch all employees
      const { data: employees, error: empErr } = await supabase
        .from('employee_discounts')
        .select('*')
        .order('created_at', { ascending: false })

      if (empErr) {
        console.error('[/api/discounts data] Employee select error:', empErr)
      }

      // Fetch recent store credit logs
      const { data: recentLogs, error: logErr } = await supabase
        .from('store_credit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(25)

      if (logErr) {
        console.error('[/api/discounts data] Store credit log select error:', logErr)
      }

      return res.status(200).json({
        ok: true,
        settings,
        employees: employees || [],
        recentLogs: recentLogs || [],
      })
    }

    // ------------------------------------------------------------------------
    // 2. Update Settings (Discount % and Monthly Store Credit $)
    // ------------------------------------------------------------------------
    if (route === 'update-settings') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

      const discountPercent = Number(req.body?.employee_discount_percent)
      const monthlyCredit = Number(req.body?.monthly_store_credit_amount)

      if (!Number.isFinite(discountPercent) || discountPercent < 1 || discountPercent > 100) {
        return res.status(400).json({ ok: false, error: 'Employee Discount % must be between 1 and 100.' })
      }
      if (!Number.isFinite(monthlyCredit) || monthlyCredit < 0) {
        return res.status(400).json({ ok: false, error: 'Monthly Store Credit must be a non-negative number.' })
      }

      const updatedRow = {
        id: 'default',
        employee_discount_percent: discountPercent,
        monthly_store_credit_amount: monthlyCredit,
        updated_at: new Date().toISOString(),
        updated_by: auth.user.name || auth.user.email || 'Admin',
      }

      const { data: settings, error: updateErr } = await supabase
        .from('discount_settings')
        .upsert(updatedRow)
        .select()
        .single()

      if (updateErr) {
        console.error('[/api/discounts update-settings] Error:', updateErr)
        return res.status(500).json({ ok: false, error: 'Failed to update settings in Supabase.' })
      }

      return res.status(200).json({ ok: true, settings })
    }

    // ------------------------------------------------------------------------
    // 3. Manual Onboard Employee (Form: Full Name + Work Email)
    // ------------------------------------------------------------------------
    if (route === 'onboard') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

      const name = clean(req.body?.name)
      const email = clean(req.body?.email).toLowerCase()

      if (!name || name.length < 2) {
        return res.status(400).json({ ok: false, error: 'Employee full name is required.' })
      }
      if (!email || !email.includes('@')) {
        return res.status(400).json({ ok: false, error: 'Valid work email address is required.' })
      }

      // Check if employee already onboarded
      const { data: existing } = await supabase
        .from('employee_discounts')
        .select('id, discount_code, work_email')
        .eq('work_email', email)
        .maybeSingle()

      if (existing) {
        return res.status(400).json({
          ok: false,
          error: `Employee with email ${email} is already onboarded (Code: ${existing.discount_code}).`,
        })
      }

      // Fetch current settings
      const { data: settings } = await supabase
        .from('discount_settings')
        .select('*')
        .eq('id', 'default')
        .maybeSingle()

      const discountPercent = settings?.employee_discount_percent ?? 20
      const initialCredit = settings?.monthly_store_credit_amount ?? 25.0

      // Optional: lookup Slack user ID
      let slackUser = null
      try {
        slackUser = await lookupUserByEmail(email)
      } catch (e) {
        console.warn('[/api/discounts onboard] Slack lookup:', e.message)
      }

      // 1. Shopify: Find or Create Customer
      const customer = await findOrCreateCustomer({ email, name })

      // 2. Shopify: Create Email-Locked Unique Discount Code
      const discountResult = await createEmailLockedDiscountCode({
        customerId: customer.id,
        employeeName: name,
        workEmail: email,
        discountPercent,
      })

      // 3. Shopify: Issue Initial Store Credit
      let creditTx = null
      if (initialCredit > 0) {
        try {
          creditTx = await issueStoreCredit({
            customerId: customer.id,
            amount: initialCredit,
          })
        } catch (creditErr) {
          console.error('[/api/discounts onboard] Store credit creation warning:', creditErr.message)
        }
      }

      // 4. Save to Supabase public.employee_discounts
      const newEmployeeRow = {
        employee_name: name,
        work_email: email,
        slack_user_id: slackUser?.id || null,
        shopify_customer_id: customer.id,
        shopify_discount_id: discountResult.discountId,
        discount_code: discountResult.discountCode,
        discount_percent: discountPercent,
        total_credit_issued: creditTx ? initialCredit : 0,
        last_credit_issued_at: creditTx ? new Date().toISOString() : null,
        status: 'Active',
      }

      const { data: employee, error: insertErr } = await supabase
        .from('employee_discounts')
        .insert(newEmployeeRow)
        .select()
        .single()

      if (insertErr) {
        console.error('[/api/discounts onboard] DB insert error:', insertErr)
        return res.status(500).json({ ok: false, error: 'Database save failed: ' + insertErr.message })
      }

      // 5. Log store credit transaction
      if (creditTx) {
        try {
          await supabase.from('store_credit_logs').insert({
            employee_discount_id: employee.id,
            employee_name: name,
            work_email: email,
            amount: initialCredit,
            reason: 'Initial Onboarding Store Credit',
            shopify_transaction_id: creditTx.transactionId,
            status: 'Success',
          })
        } catch (logErr) {
          console.error('Credit log error:', logErr.message)
        }
      }

      // 6. Send Slack DM with instructions
      let dmSent = false
      if (slackUser?.id) {
        try {
          const dmText = buildWelcomeSlackMessage({
            employeeName: name,
            discountCode: discountResult.discountCode,
            discountPercent,
            creditAmount: initialCredit,
            workEmail: email,
          })
          await sendDirectMessage(slackUser.id, dmText)
          dmSent = true
        } catch (dmErr) {
          console.warn('[/api/discounts onboard] Slack DM send failed:', dmErr.message)
        }
      }

      return res.status(200).json({
        ok: true,
        employee,
        dmSent,
        message: `Successfully onboarded ${name}! Code: ${discountResult.discountCode}`,
      })
    }

    // ------------------------------------------------------------------------
    // 4. Issue Store Credit to Single Employee
    // ------------------------------------------------------------------------
    if (route === 'issue-credit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

      const employeeId = clean(req.body?.id)
      const amount = Number(req.body?.amount)
      const reason = clean(req.body?.reason) || 'Manual Employee Store Credit'

      if (!employeeId) {
        return res.status(400).json({ ok: false, error: 'Employee ID is required.' })
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: 'Credit amount must be greater than 0.' })
      }

      const { data: employee, error: empErr } = await supabase
        .from('employee_discounts')
        .select('*')
        .eq('id', employeeId)
        .single()

      if (empErr || !employee) {
        return res.status(404).json({ ok: false, error: 'Employee not found.' })
      }

      if (employee.status !== 'Active') {
        return res.status(400).json({ ok: false, error: 'Cannot issue credit to a revoked employee.' })
      }

      // Call Shopify GraphQL
      let txResult
      try {
        txResult = await issueStoreCredit({
          customerId: employee.shopify_customer_id,
          amount,
        })
      } catch (shopifyErr) {
        // Log failure
        try {
          await supabase.from('store_credit_logs').insert({
            employee_discount_id: employee.id,
            employee_name: employee.employee_name,
            work_email: employee.work_email,
            amount,
            reason,
            status: 'Failed',
            error_message: shopifyErr.message,
          })
        } catch (logErr) {
          console.error('Store credit failure log error:', logErr.message)
        }

        return res.status(500).json({ ok: false, error: `Shopify error: ${shopifyErr.message}` })
      }

      // Update employee totals
      const newTotal = Number(employee.total_credit_issued || 0) + amount
      const nowIso = new Date().toISOString()

      const { data: updatedEmployee } = await supabase
        .from('employee_discounts')
        .update({
          total_credit_issued: newTotal,
          last_credit_issued_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', employee.id)
        .select()
        .single()

      // Log success in store_credit_logs and credit_ledger
      try {
        await supabase.from('credit_ledger').insert({
          employee_id: employee.id,
          amount,
          type: 'manual_credit',
          shopify_transaction_id: txResult.transactionId,
          created_at: nowIso,
        })
      } catch {}

      await supabase.from('store_credit_logs').insert({
        employee_discount_id: employee.id,
        employee_id: employee.id,
        employee_name: employee.employee_name,
        work_email: employee.work_email,
        amount,
        reason,
        shopify_transaction_id: txResult.transactionId,
        status: 'Success',
      })

      // Send Slack notification if possible
      let slackTarget = employee.slack_user_id
      if (!slackTarget) {
        const found = await lookupUserByEmail(employee.work_email).catch(() => null)
        slackTarget = found?.id
      }
      if (slackTarget) {
        const text =
          `✨ *Kawaii Slime Company Store Credit Added!* ✨\n` +
          `Hello ${employee.employee_name}, *$${amount.toFixed(2)}* in Store Credit has been added to your account (${reason})!\n` +
          `Use it alongside your ${employee.discount_percent}% discount code \`${employee.discount_code}\` at checkout.`
        await sendDirectMessage(slackTarget, text).catch(() => {})
      }

      return res.status(200).json({
        ok: true,
        employee: updatedEmployee,
        transactionId: txResult.transactionId,
        message: `Successfully issued $${amount.toFixed(2)} store credit to ${employee.employee_name}.`,
      })
    }

    // ------------------------------------------------------------------------
    // 5. Toggle Employee Status (Revoke / Reactivate)
    // ------------------------------------------------------------------------
    if (route === 'toggle-status') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

      const employeeId = clean(req.body?.id)
      const targetStatus = clean(req.body?.status)

      if (!['Active', 'Revoked'].includes(targetStatus)) {
        return res.status(400).json({ ok: false, error: 'Status must be Active or Revoked.' })
      }

      const { data: employee, error: empErr } = await supabase
        .from('employee_discounts')
        .select('*')
        .eq('id', employeeId)
        .single()

      if (empErr || !employee) {
        return res.status(404).json({ ok: false, error: 'Employee not found.' })
      }

      // Update in Shopify
      if (targetStatus === 'Revoked') {
        await deactivateDiscountCode(employee.shopify_discount_id).catch((err) => {
          console.warn('[toggle-status] Deactivation warning:', err.message)
        })
      } else {
        await activateDiscountCode(employee.shopify_discount_id).catch((err) => {
          console.warn('[toggle-status] Activation warning:', err.message)
        })
      }

      const { data: updated, error: updErr } = await supabase
        .from('employee_discounts')
        .update({
          status: targetStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', employee.id)
        .select()
        .single()

      if (updErr) {
        return res.status(500).json({ ok: false, error: 'Failed to update employee status in database.' })
      }

      return res.status(200).json({
        ok: true,
        employee: updated,
        message: `Employee ${employee.employee_name} is now ${targetStatus}.`,
      })
    }

    // ------------------------------------------------------------------------
    // 6. Resend Slack DM
    // ------------------------------------------------------------------------
    if (route === 'resend-dm') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

      const employeeId = clean(req.body?.id)
      const { data: employee, error: empErr } = await supabase
        .from('employee_discounts')
        .select('*')
        .eq('id', employeeId)
        .single()

      if (empErr || !employee) {
        return res.status(404).json({ ok: false, error: 'Employee not found.' })
      }

      let slackUserId = employee.slack_user_id
      if (!slackUserId) {
        const found = await lookupUserByEmail(employee.work_email).catch(() => null)
        slackUserId = found?.id
      }

      if (!slackUserId) {
        return res.status(400).json({
          ok: false,
          error: `Could not find Slack user for ${employee.work_email}. Ensure their work email matches Slack.`,
        })
      }

      const dmText = buildWelcomeSlackMessage({
        employeeName: employee.employee_name,
        discountCode: employee.discount_code,
        discountPercent: employee.discount_percent,
        creditAmount: employee.total_credit_issued || 0,
        workEmail: employee.work_email,
      })

      await sendDirectMessage(slackUserId, dmText)

      // Save slack_user_id if not previously saved
      if (!employee.slack_user_id) {
        try {
          await supabase
            .from('employee_discounts')
            .update({ slack_user_id: slackUserId })
            .eq('id', employee.id)
        } catch (updErr) {
          console.warn('Slack user ID update warning:', updErr.message)
        }
      }

      return res.status(200).json({
        ok: true,
        message: `Resent Slack DM with discount code ${employee.discount_code} to ${employee.employee_name}.`,
      })
    }

    // ------------------------------------------------------------------------
    // 7. Monthly Store Credit Run (Credits all Active employees)
    // ------------------------------------------------------------------------
    if (route === 'monthly-credit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

      // Fetch settings
      const { data: settings } = await supabase
        .from('discount_settings')
        .select('*')
        .eq('id', 'default')
        .single()

      const monthlyAmount = Number(settings?.monthly_store_credit_amount ?? 25.0)
      if (monthlyAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'Configured monthly store credit is $0.00.' })
      }

      // Fetch all Active employees
      const { data: activeEmployees, error: fetchErr } = await supabase
        .from('employee_discounts')
        .select('*')
        .eq('status', 'Active')

      if (fetchErr) {
        return res.status(500).json({ ok: false, error: 'Failed to fetch active employees.' })
      }

      const employees = activeEmployees || []
      let successful = 0
      let failed = 0
      const results = []

      for (const emp of employees) {
        try {
          const tx = await issueStoreCredit({
            customerId: emp.shopify_customer_id,
            amount: monthlyAmount,
          })

          const newTotal = Number(emp.total_credit_issued || 0) + monthlyAmount
          const nowIso = new Date().toISOString()

          await supabase
            .from('employee_discounts')
            .update({
              total_credit_issued: newTotal,
              last_credit_issued_at: nowIso,
              updated_at: nowIso,
            })
            .eq('id', emp.id)

          try {
            await supabase.from('credit_ledger').insert({
              employee_id: emp.id,
              amount: monthlyAmount,
              type: 'monthly_credit',
              shopify_transaction_id: tx.transactionId,
              created_at: nowIso,
            })
          } catch {}

          await supabase.from('store_credit_logs').insert({
            employee_discount_id: emp.id,
            employee_id: emp.id,
            employee_name: emp.employee_name,
            work_email: emp.work_email,
            amount: monthlyAmount,
            reason: 'Monthly Employee Store Credit',
            shopify_transaction_id: tx.transactionId,
            status: 'Success',
          })

          // Notify employee via Slack DM
          let slackId = emp.slack_user_id
          if (!slackId) {
            const found = await lookupUserByEmail(emp.work_email).catch(() => null)
            slackId = found?.id
          }
          if (slackId) {
            const text =
              `✨ *Kawaii Slime Company Monthly Store Credit!* ✨\n` +
              `Hi ${emp.employee_name}! Your monthly employee store credit of *$${monthlyAmount.toFixed(2)}* has been credited to your account.\n` +
              `Use it alongside your ${emp.discount_percent}% employee discount code \`${emp.discount_code}\` at checkout on kawaiislimecompany.com.`
            sendDirectMessage(slackId, text).catch(() => {})
          }

          successful++
          results.push({ email: emp.work_email, status: 'Success', amount: monthlyAmount })
        } catch (err) {
          failed++
          results.push({ email: emp.work_email, status: 'Failed', error: err.message })
          try {
            await supabase.from('store_credit_logs').insert({
              employee_discount_id: emp.id,
              employee_name: emp.employee_name,
              work_email: emp.work_email,
              amount: monthlyAmount,
              reason: 'Monthly Employee Store Credit',
              status: 'Failed',
              error_message: err.message,
            })
          } catch (logErr) {
            console.error('Store credit log error:', logErr.message)
          }
        }
      }

      return res.status(200).json({
        ok: true,
        summary: {
          totalEmployees: employees.length,
          successful,
          failed,
          monthlyAmountPerEmployee: monthlyAmount,
          totalAmountIssued: successful * monthlyAmount,
        },
        results,
      })
    }

    return res.status(400).json({ ok: false, error: `Unknown route: ${route}` })
  } catch (error) {
    return jsonError(res, error)
  }
}
