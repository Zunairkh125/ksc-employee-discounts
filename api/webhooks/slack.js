import { clean, admin } from '../../lib/db.js'
import { readRawBody, verifySlackSignature, sendDirectMessage, slackAPI } from '../../lib/slack.js'
import {
  findOrCreateCustomerGraphQL,
  createEmailLockedDiscountGraphQL,
  issueStoreCreditGraphQL,
  generateEmpDiscountCode,
} from '../../lib/shopify.js'

export function buildWelcomeSlackMessage({
  employeeName,
  discountCode,
  discountPercent = 20,
  creditAmount = 25,
  workEmail,
}) {
  return (
    `🎉 *Welcome to the Kawaii Slime Company Team, ${employeeName}!* 🎉\n\n` +
    `We're thrilled to have you with us! As a valued team member, here are your exclusive employee shopping perks:\n\n` +
    `• *Your Unique Discount Code:* \`${discountCode}\` (*${discountPercent}% OFF*)\n` +
    `• *Security Lock:* This code is locked strictly to your Slack/work email (*${workEmail}*) at checkout and cannot be used by anyone else.\n` +
    (creditAmount > 0
      ? `• *Monthly Store Credit ("Free Money"):* We've deposited *$${Number(creditAmount).toFixed(2)}* in Store Credit directly to your Shopify account to get you started! This automatically stacks with your ${discountPercent}% discount code at checkout.\n\n`
      : `\n`) +
    `📦 *How to Place an Order:*\n` +
    `1. Head over to *kawaiislimecompany.com* and shop using your work email (*${workEmail}*).\n` +
    `2. Enter your code \`${discountCode}\` at checkout.\n` +
    `3. *Warehouse Local Pickup (Local Staff):* Select *Local Pickup* at checkout to collect your order right here at the warehouse.\n` +
    `4. *Home Shipping (Remote / Out-of-State Staff):* Enter your home shipping address at checkout, and your discount & store credit apply automatically.\n\n` +
    `If you have any questions or need assistance, reach out to HR or Operations in Slack anytime!`
  )
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  )

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      success: true,
      message: 'Kawaii Slime Company Slack Webhook Endpoint Active',
    })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' })
  }

  try {
    const rawBody = await readRawBody(req)

    let body
    if (typeof req.body === 'object' && req.body !== null) {
      body = req.body
    } else {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = {}
      }
    }

    // 1. URL Verification Challenge from Slack App Settings
    if (body.type === 'url_verification') {
      return res.status(200).json({ challenge: body.challenge })
    }

    // 2. Verify Slack HMAC Signature (if SLACK_SIGNING_SECRET is configured)
    if (process.env.SLACK_SIGNING_SECRET) {
      const isValid = verifySlackSignature(rawBody, req.headers)
      if (!isValid) {
        console.warn('[Slack Webhook] Invalid Slack signature verification.')
        return res.status(401).json({ error: 'Invalid Slack signature.' })
      }
    }

    // 3. Process Events
    if (body.type === 'event_callback' && body.event) {
      const event = body.event

      // Handle team_join event (new employee joins Slack workspace)
      if (event.type === 'team_join' && event.user) {
        const u = event.user

        // 3a. Ignore bot users, app users, and Slackbot
        if (u.is_bot || u.is_app_user || u.id === 'USLACKBOT') {
          console.log(`[Slack Webhook] Ignoring bot/app user: ${u.id}`)
          return res.status(200).json({ ok: true, ignored: 'Bot or app user' })
        }

        const slackUserId = u.id
        let realName = u.real_name || u.profile?.real_name || u.name || 'Team Member'
        let email = u.profile?.email ? String(u.profile.email).toLowerCase() : null

        // 3b. Fetch complete profile via Slack users.info API (requires users:read + users:read.email)
        if (slackUserId && process.env.SLACK_BOT_TOKEN) {
          try {
            const infoRes = await slackAPI(`users.info?user=${encodeURIComponent(slackUserId)}`)
            const userObj = infoRes?.user
            if (userObj?.is_bot || userObj?.is_app_user) {
              console.log(`[Slack Webhook] users.info confirmed bot user: ${slackUserId}`)
              return res.status(200).json({ ok: true, ignored: 'Bot user' })
            }
            if (userObj?.profile?.email) {
              email = String(userObj.profile.email).toLowerCase()
            }
            if (userObj?.real_name || userObj?.profile?.real_name) {
              realName = userObj.real_name || userObj.profile.real_name
            }
          } catch (e) {
            console.warn('[Slack Webhook] users.info lookup warning:', e.message)
          }
        }

        if (!email) {
          console.warn(`[Slack Webhook] Could not resolve email for Slack user ${slackUserId}.`)
          return res.status(200).json({ ok: true, warning: 'No email found for user' })
        }

        const supabase = admin()

        // 3c. Idempotency & Deduplication: Check if already provisioned by email OR slack_user_id
        let existingEmp = null
        try {
          const { data: foundByEmail } = await supabase
            .from('employees')
            .select('*')
            .eq('work_email', email)
            .maybeSingle()
          if (foundByEmail) existingEmp = foundByEmail
        } catch {}

        if (!existingEmp && slackUserId) {
          try {
            const { data: foundBySlack } = await supabase
              .from('employees')
              .select('*')
              .eq('slack_user_id', slackUserId)
              .maybeSingle()
            if (foundBySlack) existingEmp = foundBySlack
          } catch {}
        }

        // Also check employee_discounts fallback table
        if (!existingEmp) {
          try {
            const { data: foundAlt } = await supabase
              .from('employee_discounts')
              .select('*')
              .eq('work_email', email)
              .maybeSingle()
            if (foundAlt) {
              existingEmp = {
                id: foundAlt.id,
                full_name: foundAlt.employee_name,
                work_email: foundAlt.work_email,
                discount_code: foundAlt.discount_code,
                discount_percentage: foundAlt.discount_percent,
                monthly_credit_amount: 25.0,
                slack_user_id: foundAlt.slack_user_id,
              }
            }
          } catch {}
        }

        // If employee already provisioned, resend welcome DM without creating duplicate codes
        if (existingEmp && existingEmp.discount_code) {
          if (!existingEmp.slack_user_id && slackUserId) {
            try {
              await supabase
                .from('employees')
                .update({ slack_user_id: slackUserId })
                .eq('id', existingEmp.id)
            } catch {}
          }

          const dmText = buildWelcomeSlackMessage({
            employeeName: existingEmp.full_name || realName,
            discountCode: existingEmp.discount_code,
            discountPercent: existingEmp.discount_percentage || 20,
            creditAmount:
              existingEmp.monthly_credit_amount !== undefined && existingEmp.monthly_credit_amount !== null
                ? existingEmp.monthly_credit_amount
                : 25,
            workEmail: email,
          })
          await sendDirectMessage(slackUserId, dmText).catch(() => {})

          return res.status(200).json({
            ok: true,
            message: 'Employee already provisioned. Resent welcome DM.',
            discount_code: existingEmp.discount_code,
          })
        }

        // 3d. Fetch Benefit Settings from Supabase
        let discountPercent = 20
        let initialCredit = 25.0
        try {
          const { data: settings } = await supabase
            .from('discount_settings')
            .select('*')
            .eq('id', 'default')
            .maybeSingle()
          if (settings) {
            discountPercent = Number(settings.employee_discount_percent ?? 20)
            initialCredit = Number(settings.monthly_store_credit_amount ?? 25.0)
          }
        } catch {}

        // 3e. 1. Find or create customer in Shopify via GraphQL (customerCreate)
        const customer = await findOrCreateCustomerGraphQL({
          email,
          fullName: realName,
        })
        const shopifyCustomerId = String(customer.id)

        // 3f. 2. Generate Unique Code & create email-locked discount via GraphQL (discountCodeBasicCreate)
        const uniqueCode = generateEmpDiscountCode(realName)
        const discountRes = await createEmailLockedDiscountGraphQL({
          customerId: shopifyCustomerId,
          employeeName: realName,
          workEmail: email,
          discountPercentage: discountPercent,
          uniqueCode,
        })
        const shopifyDiscountId = String(discountRes.discountId)

        // 3g. 3. Deposit initial Store Credit via Shopify GraphQL (storeCreditAccountCredit)
        let txResult = null
        if (initialCredit > 0) {
          try {
            txResult = await issueStoreCreditGraphQL({
              customerId: shopifyCustomerId,
              amount: initialCredit,
              currencyCode: 'USD',
            })
          } catch (creditErr) {
            console.error('[Slack Webhook team_join] Store credit error:', creditErr.message)
          }
        }

        const nowIso = new Date().toISOString()

        // 3h. 4. Save to Supabase `employees` table
        let savedEmp = null
        const employeeRecord = {
          full_name: realName,
          work_email: email,
          discount_code: uniqueCode,
          discount_percentage: discountPercent,
          monthly_credit_amount: initialCredit,
          shopify_customer_id: shopifyCustomerId,
          shopify_discount_id: shopifyDiscountId,
          shopify_price_rule_id: shopifyDiscountId,
          slack_user_id: slackUserId,
          is_active: true,
          status: 'active',
          location_type: 'local',
          last_credited_at: txResult ? nowIso : null,
          created_at: nowIso,
          updated_at: nowIso,
        }

        try {
          const { data: newEmp } = await supabase
            .from('employees')
            .insert(employeeRecord)
            .select()
            .single()
          savedEmp = newEmp
        } catch (e) {
          console.warn('[Slack Webhook] employees insert warning:', e.message)
        }

        const empId = savedEmp?.id

        // 3i. 5. Record initial credit in `credit_ledger`
        if (txResult && empId) {
          try {
            await supabase.from('credit_ledger').insert({
              employee_id: empId,
              amount: initialCredit,
              type: 'initial_credit',
              shopify_transaction_id: txResult.transactionId,
              created_at: nowIso,
            })
          } catch (ledgerErr) {
            console.warn('[Slack Webhook] credit_ledger insert warning:', ledgerErr.message)
          }
        }

        // 3j. 6. Record in store_credit_logs (audit log)
        if (txResult) {
          try {
            await supabase.from('store_credit_logs').insert({
              employee_id: empId,
              employee_name: realName,
              work_email: email,
              amount: initialCredit,
              reason: 'Initial Onboarding Store Credit (Slack team_join)',
              shopify_transaction_id: txResult.transactionId,
              status: 'Success',
              created_at: nowIso,
            })
          } catch (logErr) {
            console.warn('[Slack Webhook] store_credit_logs insert warning:', logErr.message)
          }
        }

        // 3k. 7. Sync with employee_discounts for redundancy
        try {
          await supabase.from('employee_discounts').upsert(
            {
              employee_name: realName,
              work_email: email,
              slack_user_id: slackUserId,
              shopify_customer_id: shopifyCustomerId,
              shopify_discount_id: shopifyDiscountId,
              discount_code: uniqueCode,
              discount_percent: discountPercent,
              total_credit_issued: txResult ? initialCredit : 0,
              last_credit_issued_at: txResult ? nowIso : null,
              status: 'Active',
            },
            { onConflict: 'work_email' }
          )
        } catch {}

        // 3l. 8. Send Welcome Slack DM with all perk details
        const dmText = buildWelcomeSlackMessage({
          employeeName: realName,
          discountCode: uniqueCode,
          discountPercent,
          creditAmount: initialCredit,
          workEmail: email,
        })
        await sendDirectMessage(slackUserId, dmText)

        return res.status(200).json({
          ok: true,
          success: true,
          message: `Onboarded ${realName} with code ${uniqueCode}`,
          discount_code: uniqueCode,
        })
      }
    }

    return res.status(200).json({ ok: true, success: true })
  } catch (err) {
    console.error('[Slack Webhook] Handler error:', err)
    return res.status(200).json({ ok: false, error: err.message })
  }
}
