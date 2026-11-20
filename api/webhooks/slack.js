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
    `We're thrilled to have you with us! As a valued team member, here are your exclusive shopping perks:\n\n` +
    `• *Your Unique Discount Code:* \`${discountCode}\` (*${discountPercent}% OFF*)\n` +
    `• *Security Lock:* This code is locked strictly to your work email (*${workEmail}*) and cannot be used by anyone else.\n` +
    (creditAmount > 0
      ? `• *Welcome Store Credit:* We've added *$${Number(creditAmount).toFixed(2)}* in Store Credit directly to your Shopify account to get you started!\n\n`
      : `\n`) +
    `📦 *How to Place an Order:*\n` +
    `1. Head over to *kawaiislimecompany.com* and shop using your work email (*${workEmail}*).\n` +
    `2. Enter your code \`${discountCode}\` at checkout.\n` +
    `3. *Local Staff (Warehouse Pickup):* Select *Local Pickup* at checkout to collect your order right here at the warehouse.\n` +
    `4. *Remote / Home Shipping Staff:* Enter your home address at checkout, and your discount & store credit apply automatically.\n\n` +
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
        let realName = u.real_name || u.profile?.real_name || u.name || 'New Team Member'
        let email = u.profile?.email ? String(u.profile.email).toLowerCase() : null
        const slackUserId = u.id

        // Fallback: If email not in event payload, query Slack users.info
        if (!email && slackUserId && process.env.SLACK_BOT_TOKEN) {
          try {
            const infoRes = await slackAPI(`users.info?user=${encodeURIComponent(slackUserId)}`)
            if (infoRes.user?.profile?.email) {
              email = String(infoRes.user.profile.email).toLowerCase()
              realName = infoRes.user.real_name || infoRes.user.profile.real_name || realName
            }
          } catch (e) {
            console.warn('[Slack Webhook] users.info fallback lookup failed:', e.message)
          }
        }

        if (email) {
          try {
            const supabase = admin()

            // Check if already in employees table
            let existingEmp = null
            try {
              const { data: found } = await supabase
                .from('employees')
                .select('*')
                .eq('work_email', email)
                .maybeSingle()
              existingEmp = found
            } catch {}

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

            if (existingEmp) {
              // Update slack_user_id if missing
              if (!existingEmp.slack_user_id && slackUserId) {
                try {
                  await supabase
                    .from('employees')
                    .update({ slack_user_id: slackUserId })
                    .eq('id', existingEmp.id)
                } catch {}
              }

              // Resend welcome DM with existing code
              const dmText = buildWelcomeSlackMessage({
                employeeName: existingEmp.full_name || realName,
                discountCode: existingEmp.discount_code,
                discountPercent: existingEmp.discount_percentage || 20,
                creditAmount: existingEmp.monthly_credit_amount || 25,
                workEmail: email,
              })
              await sendDirectMessage(slackUserId, dmText).catch(() => {})
            } else {
              // Fetch configured settings
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

              // 1. Find or create customer via GraphQL
              const customer = await findOrCreateCustomerGraphQL({
                email,
                fullName: realName,
              })

              // 2. Generate unique email-locked discount code via GraphQL (discountCodeBasicCreate)
              const uniqueCode = generateEmpDiscountCode(realName)
              const discountRes = await createEmailLockedDiscountGraphQL({
                customerId: customer.id,
                employeeName: realName,
                workEmail: email,
                discountPercentage: discountPercent,
                uniqueCode,
              })

              // 3. Credit initial native store credit balance via GraphQL (storeCreditAccountCredit)
              let txResult = null
              if (initialCredit > 0) {
                try {
                  txResult = await issueStoreCreditGraphQL({
                    customerId: customer.id,
                    amount: initialCredit,
                    currencyCode: 'USD',
                  })
                } catch (creditErr) {
                  console.error('[Slack Webhook team_join] Store credit error:', creditErr.message)
                }
              }

              const nowIso = new Date().toISOString()

              // 4. Save to Supabase (public.employees)
              let savedEmp = null
              const employeeRecord = {
                full_name: realName,
                work_email: email,
                discount_code: discountRes.discountCode,
                discount_percentage: discountPercent,
                monthly_credit_amount: initialCredit,
                shopify_customer_id: customer.id,
                shopify_discount_id: discountRes.discountId,
                shopify_price_rule_id: discountRes.discountId,
                slack_user_id: slackUserId,
                is_active: true,
                status: 'active',
                location_type: 'local',
                last_credited_at: txResult ? nowIso : null,
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

              // 5. Save to credit_ledger
              if (txResult && savedEmp?.id) {
                try {
                  await supabase.from('credit_ledger').insert({
                    employee_id: savedEmp.id,
                    amount: initialCredit,
                    type: 'initial_credit',
                    shopify_transaction_id: txResult.transactionId,
                    created_at: nowIso,
                  })
                } catch (ledgerErr) {
                  console.warn('[Slack Webhook] credit_ledger insert warning:', ledgerErr.message)
                }
              }

              // 6. Save to store_credit_logs (audit log)
              if (txResult) {
                try {
                  await supabase.from('store_credit_logs').insert({
                    employee_id: savedEmp?.id,
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

              // 7. Backward compatibility sync to employee_discounts
              try {
                await supabase.from('employee_discounts').upsert(
                  {
                    employee_name: realName,
                    work_email: email,
                    slack_user_id: slackUserId,
                    shopify_customer_id: customer.id,
                    shopify_discount_id: discountRes.discountId,
                    discount_code: discountRes.discountCode,
                    discount_percent: discountPercent,
                    total_credit_issued: txResult ? initialCredit : 0,
                    last_credit_issued_at: txResult ? nowIso : null,
                    status: 'Active',
                  },
                  { onConflict: 'work_email' }
                )
              } catch {}

              // 8. Send Welcome Slack DM
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
            console.error('[Slack Webhook team_join] Provisioning error:', autoErr)
          }
        }
      }
    }

    return res.status(200).json({ ok: true, success: true })
  } catch (err) {
    console.error('[Slack Webhook] Handler error:', err)
    return res.status(200).json({ ok: false, error: err.message })
  }
}
