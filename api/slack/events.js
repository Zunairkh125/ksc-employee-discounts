import { clean, admin } from '../../lib/db.js'
import { readRawBody, verifySlackSignature, sendDirectMessage, slackAPI } from '../../lib/slack.js'
import {
  findOrCreateCustomer,
  createEmailLockedDiscountCode,
  issueStoreCredit,
} from '../../lib/shopify.js'

function buildWelcomeSlackMessage({ employeeName, discountCode, discountPercent, creditAmount, workEmail }) {
  return (
    `🎉 *Welcome to the Kawaii Slime Company Team, ${employeeName}!* 🎉\n\n` +
    `We're thrilled to have you with us! As a valued team member, here are your exclusive shopping perks:\n\n` +
    `• *Your Unique Discount Code:* \`${discountCode}\` (*${discountPercent}% OFF*)\n` +
    `• *Security Lock:* This code is locked strictly to your work email (*${workEmail}*) at checkout.\n` +
    (creditAmount > 0
      ? `• *Welcome Store Credit:* We've added *$${Number(creditAmount).toFixed(2)}* in Store Credit to your Shopify account to get you started!\n\n`
      : `\n`) +
    `📦 *How to Place an Order:*\n` +
    `1. Head over to *kawaiislimecompany.com* and use your work email (*${workEmail}*).\n` +
    `2. Enter your code \`${discountCode}\` at checkout.\n` +
    `3. *Local Staff (Warehouse Pickup):* Select *Local Pickup* at checkout to collect your order right here at the warehouse.\n` +
    `4. *Out-of-State / International Staff (Home Shipping):* Enter your home shipping address at checkout, and your discount applies directly.\n\n` +
    `If you have any questions or need help, reach out to HR or Operations in Slack anytime!`
  )
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'Kawaii Slime Company Slack Events Endpoint Active' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
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
        console.warn('[Slack Events] Invalid Slack signature verification.')
        return res.status(401).json({ error: 'Invalid Slack signature.' })
      }
    }

    // 3. Process Events
    if (body.type === 'event_callback' && body.event) {
      const event = body.event

      // Handle team_join event (new employee joins workspace)
      if (event.type === 'team_join' && event.user) {
        const u = event.user
        let realName = u.real_name || u.profile?.real_name || u.name || 'New Team Member'
        let email = u.profile?.email ? String(u.profile.email).toLowerCase() : null
        const slackUserId = u.id

        // If email not present in event payload, query Slack users.info
        if (!email && slackUserId && process.env.SLACK_BOT_TOKEN) {
          try {
            const infoRes = await slackAPI(`users.info?user=${encodeURIComponent(slackUserId)}`)
            if (infoRes.user?.profile?.email) {
              email = String(infoRes.user.profile.email).toLowerCase()
              realName = infoRes.user.real_name || infoRes.user.profile.real_name || realName
            }
          } catch (e) {
            console.warn('[Slack Events] users.info fallback lookup failed:', e.message)
          }
        }

        if (email) {
          try {
            const supabase = admin()

            // Check if already onboarded
            const { data: existing } = await supabase
              .from('employee_discounts')
              .select('*')
              .eq('work_email', email)
              .maybeSingle()

            if (existing) {
              // Update slack_user_id if missing
              if (!existing.slack_user_id && slackUserId) {
                await supabase
                  .from('employee_discounts')
                  .update({ slack_user_id: slackUserId })
                  .eq('id', existing.id)
              }

              // Send welcome DM with existing code
              const dmText = buildWelcomeSlackMessage({
                employeeName: existing.employee_name || realName,
                discountCode: existing.discount_code,
                discountPercent: existing.discount_percent,
                creditAmount: existing.total_credit_issued || 0,
                workEmail: email,
              })
              await sendDirectMessage(slackUserId, dmText).catch(() => {})
            } else {
              // Fetch settings
              const { data: settings } = await supabase
                .from('discount_settings')
                .select('*')
                .eq('id', 'default')
                .maybeSingle()

              const discountPercent = Number(settings?.employee_discount_percent ?? 20)
              const initialCredit = Number(settings?.monthly_store_credit_amount ?? 25.0)

              // 1. Shopify Customer
              const customer = await findOrCreateCustomer({ email, name: realName })

              // 2. Shopify Unique Discount Code
              const discountRes = await createEmailLockedDiscountCode({
                customerId: customer.id,
                employeeName: realName,
                workEmail: email,
                discountPercent,
              })

              // 3. Shopify Store Credit
              let txResult = null
              if (initialCredit > 0) {
                try {
                  txResult = await issueStoreCredit({
                    customerId: customer.id,
                    amount: initialCredit,
                  })
                } catch (creditErr) {
                  console.error('[Slack Events team_join] Credit error:', creditErr.message)
                }
              }

              // 4. Save to Supabase
              const { data: newEmp } = await supabase
                .from('employee_discounts')
                .insert({
                  employee_name: realName,
                  work_email: email,
                  slack_user_id: slackUserId,
                  shopify_customer_id: customer.id,
                  shopify_discount_id: discountRes.discountId,
                  discount_code: discountRes.discountCode,
                  discount_percent: discountPercent,
                  total_credit_issued: txResult ? initialCredit : 0,
                  last_credit_issued_at: txResult ? new Date().toISOString() : null,
                  status: 'Active',
                })
                .select()
                .single()

              if (txResult && newEmp) {
                try {
                  await supabase.from('store_credit_logs').insert({
                    employee_discount_id: newEmp.id,
                    employee_name: realName,
                    work_email: email,
                    amount: initialCredit,
                    reason: 'Initial Onboarding Store Credit (team_join)',
                    shopify_transaction_id: txResult.transactionId,
                    status: 'Success',
                  })
                } catch (logErr) {
                  console.error('team_join log error:', logErr.message)
                }
              }

              // 5. Send Welcome DM
              const dmText = buildWelcomeSlackMessage({
                employeeName: realName,
                discountCode: discountRes.discountCode,
                discountPercent,
                creditAmount: initialCredit,
                workEmail: email,
              })
              await sendDirectMessage(slackUserId, dmText)
            }
          } catch (autoErr) {
            console.error('[Slack Events team_join] Auto-onboarding error:', autoErr)
          }
        }
      }
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[Slack Events] Handler error:', err)
    return res.status(200).json({ ok: false, error: err.message })
  }
}
