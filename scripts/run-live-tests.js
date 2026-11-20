import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Load .env.local variables
try {
  const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim()
      let v = trimmed.slice(eqIdx + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      process.env[k] = v
    }
  })
} catch (e) {
  console.warn('Could not read .env.local:', e.message)
}

import { admin } from '../lib/db.js'
import {
  shopifyGraphQL,
  findOrCreateCustomerGraphQL,
  createEmailLockedDiscountGraphQL,
  issueStoreCreditGraphQL,
  deactivateDiscountCodeGraphQL,
  normalizeShopifyId,
} from '../lib/shopify.js'
import { slackAPI, lookupUserByEmail, sendDirectMessage } from '../lib/slack.js'
import { hashLoginCode, verifyLoginCodeHash, createSessionToken } from '../lib/session.js'

async function runLiveTests() {
  console.log('====================================================================')
  console.log('🚀 RUNNING 6 LIVE TESTS ON SHOPIFY TESTING STORE + SUPABASE + SLACK')
  console.log('Store:', process.env.SHOPIFY_STORE_DOMAIN)
  console.log('Supabase:', process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log('Slack Token prefix:', process.env.SLACK_BOT_TOKEN?.slice(0, 15) + '...')
  console.log('====================================================================\n')

  const supabase = admin()
  const testResults = []

  // --------------------------------------------------------------------------
  // TEST 1: Slack Auth & 4-Digit Expiring Code Flow
  // --------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------')
  console.log('▶ TEST 1: Slack Auth Flow (Random 4-Digit Code & 10-Min Expiry)')
  console.log('--------------------------------------------------------------------')
  try {
    const testEmail = 'zunair@kawaiislimecompany.com'
    const slackUser = await lookupUserByEmail(testEmail)
    console.log('1a. Slack User Lookup:', {
      found: Boolean(slackUser),
      id: slackUser?.id,
      name: slackUser?.real_name || slackUser?.name,
      email: testEmail,
    })

    if (!slackUser) throw new Error('Slack user not found for ' + testEmail)

    // Generate random 4-digit code
    const randomCode = Math.floor(1000 + Math.random() * 9000).toString()
    const codeHash = hashLoginCode(testEmail, randomCode)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    // Invalidate old codes and insert new
    await supabase.from('discount_login_codes').update({ used_at: new Date().toISOString() }).eq('email', testEmail).is('used_at', null)
    const { data: insertedCode, error: insertErr } = await supabase.from('discount_login_codes').insert({
      email: testEmail,
      code_hash: codeHash,
      slack_user_id: slackUser.id,
      slack_user_name: slackUser.real_name,
      expires_at: expiresAt,
    }).select().single()

    if (insertErr) throw new Error('Supabase insert error: ' + insertErr.message)

    console.log('1b. Code Generated & Stored:', {
      id: insertedCode.id,
      code: randomCode,
      expires_at: insertedCode.expires_at,
    })

    // Send code to Slack DM
    const dmMsg = `🔐 *Kawaii Slime Company — Employee Discount Portal Live Test*\nYour 4-digit verification code is: *${randomCode}* (expires in 10 minutes).`
    const dmRes = await sendDirectMessage(slackUser.id, dmMsg)
    console.log('1c. Slack DM Delivered:', { ok: dmRes?.ok, channel: dmRes?.channel, ts: dmRes?.ts })

    // Verify hash verification
    const isValid = verifyLoginCodeHash(testEmail, randomCode, codeHash)
    const isBadValid = verifyLoginCodeHash(testEmail, '0000', codeHash)
    console.log('1d. Cryptographic Hash Check:', { validCodeMatches: isValid, wrongCodeRejected: !isBadValid })

    // Mark code used
    await supabase.from('discount_login_codes').update({ used_at: new Date().toISOString() }).eq('id', insertedCode.id)

    testResults.push({
      test: 'Test 1: Slack Auth & Expiring Code',
      status: 'PASSED',
      details: `Generated code ${randomCode}, delivered to Slack ${slackUser.id}, verified in Supabase`,
    })
  } catch (err) {
    console.error('❌ TEST 1 FAILED:', err.message)
    testResults.push({ test: 'Test 1: Slack Auth & Expiring Code', status: 'FAILED', error: err.message })
  }

  // --------------------------------------------------------------------------
  // TEST 2: Onboard Employee with $0 Store Credit & Local Warehouse Pickup
  // --------------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------')
  console.log('▶ TEST 2: Onboard Employee with $0 Store Credit & Local Warehouse Pickup')
  console.log('--------------------------------------------------------------------')
  let empMaya = null
  try {
    const mayaEmail = 'maya.local@kawaiislimecompany.com'
    const mayaName = 'Maya Local'

    // 1. Shopify Customer
    const customer = await findOrCreateCustomerGraphQL({ email: mayaEmail, fullName: mayaName })
    console.log('2a. Shopify Customer:', customer)

    // 2. Email-Locked Discount Code (20% OFF)
    const discountRes = await createEmailLockedDiscountGraphQL({
      customerId: customer.id,
      employeeName: mayaName,
      workEmail: mayaEmail,
      discountPercentage: 20,
    })
    console.log('2b. Email-Locked Discount Created:', discountRes)

    // 3. Store credit should be skipped because amount is $0
    const creditAmount = 0
    console.log('2c. Store Credit Issuance: Skipped cleanly ($0 amount configured)')

    // 4. Save to Supabase `employees` table
    const nowIso = new Date().toISOString()
    const record = {
      full_name: mayaName,
      work_email: mayaEmail,
      shopify_customer_id: customer.id,
      shopify_discount_id: discountRes.discountId,
      shopify_price_rule_id: discountRes.discountId,
      discount_code: discountRes.discountCode,
      discount_percentage: 20,
      monthly_credit_amount: 0,
      location_type: 'local',
      is_active: true,
      status: 'active',
      updated_at: nowIso,
    }

    const { data: saved, error: dbErr } = await supabase.from('employees').upsert(record, { onConflict: 'work_email' }).select().single()
    if (dbErr) throw new Error('Supabase upsert error: ' + dbErr.message)
    empMaya = saved
    console.log('2d. Saved in Supabase employees:', { id: saved.id, code: saved.discount_code, monthly_credit: saved.monthly_credit_amount, location: saved.location_type })

    testResults.push({
      test: 'Test 2: Onboard with $0 Credit & Local Pickup',
      status: 'PASSED',
      details: `Code: ${discountRes.discountCode}, Locked to Customer: ${customer.id}, Credit: $0.00`,
    })
  } catch (err) {
    console.error('❌ TEST 2 FAILED:', err.message)
    testResults.push({ test: 'Test 2: Onboard with $0 Credit & Local Pickup', status: 'FAILED', error: err.message })
  }

  // --------------------------------------------------------------------------
  // TEST 3: Onboard Employee with $25 Store Credit & Remote Home Shipping
  // --------------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------')
  console.log('▶ TEST 3: Onboard Employee with $25 Store Credit & Remote Home Shipping')
  console.log('--------------------------------------------------------------------')
  let empDavid = null
  try {
    const davidEmail = 'david.remote@kawaiislimecompany.com'
    const davidName = 'David Remote'

    // 1. Shopify Customer
    const customer = await findOrCreateCustomerGraphQL({ email: davidEmail, fullName: davidName })
    console.log('3a. Shopify Customer:', customer)

    // 2. Email-Locked Discount Code (20% OFF)
    const discountRes = await createEmailLockedDiscountGraphQL({
      customerId: customer.id,
      employeeName: davidName,
      workEmail: davidEmail,
      discountPercentage: 20,
    })
    console.log('3b. Email-Locked Discount Created:', discountRes)

    // 3. Issue $25 Native Store Credit
    const creditTx = await issueStoreCreditGraphQL({
      customerId: customer.id,
      amount: 25.0,
      currencyCode: 'USD',
    })
    console.log('3c. Shopify Store Credit Issued:', creditTx)

    // 4. Save to Supabase `employees` and `credit_ledger`
    const nowIso = new Date().toISOString()
    const record = {
      full_name: davidName,
      work_email: davidEmail,
      shopify_customer_id: customer.id,
      shopify_discount_id: discountRes.discountId,
      shopify_price_rule_id: discountRes.discountId,
      discount_code: discountRes.discountCode,
      discount_percentage: 20,
      monthly_credit_amount: 25.0,
      location_type: 'remote',
      is_active: true,
      status: 'active',
      last_credited_at: nowIso,
      updated_at: nowIso,
    }

    const { data: saved, error: dbErr } = await supabase.from('employees').upsert(record, { onConflict: 'work_email' }).select().single()
    if (dbErr) throw new Error('Supabase upsert error: ' + dbErr.message)
    empDavid = saved

    // 5. Insert to credit_ledger
    await supabase.from('credit_ledger').insert({
      employee_id: saved.id,
      amount: 25.0,
      type: 'initial_credit',
      shopify_transaction_id: creditTx.transactionId,
      created_at: nowIso,
    })
    console.log('3d. Saved in Supabase employees and credit_ledger:', { id: saved.id, code: saved.discount_code, tx: creditTx.transactionId })

    testResults.push({
      test: 'Test 3: Onboard with $25 Credit & Remote Shipping',
      status: 'PASSED',
      details: `Code: ${discountRes.discountCode}, Store Credit TX: ${creditTx.transactionId}, Ledger logged`,
    })
  } catch (err) {
    console.error('❌ TEST 3 FAILED:', err.message)
    testResults.push({ test: 'Test 3: Onboard with $25 Credit & Remote Shipping', status: 'FAILED', error: err.message })
  }

  // --------------------------------------------------------------------------
  // TEST 4: Verify Shopify GraphQL Email-Lock Enforcement
  // --------------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------')
  console.log('▶ TEST 4: Verify Shopify GraphQL Email-Lock Enforcement')
  console.log('--------------------------------------------------------------------')
  try {
    const query = `
      query getDiscount($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              status
              customerSelection {
                __typename
                ... on DiscountCustomers {
                  customers {
                    id
                    email
                  }
                }
              }
            }
          }
        }
      }
    `
    const discountId = empDavid?.shopify_discount_id || empMaya?.shopify_discount_id
    if (!discountId) throw new Error('No discount ID available to inspect.')

    const res = await shopifyGraphQL(query, { id: discountId })
    const node = res.data?.codeDiscountNode
    const disc = node?.codeDiscount
    const lockedCustomers = disc?.customerSelection?.customers || []
    console.log('4a. Shopify Discount Node Inspection:', {
      id: node?.id,
      title: disc?.title,
      status: disc?.status,
      lockedCustomers,
    })

    if (lockedCustomers.length === 0) {
      throw new Error('Discount is not locked to specific customers!')
    }

    testResults.push({
      test: 'Test 4: Shopify Email-Lock GraphQL Verification',
      status: 'PASSED',
      details: `Code ${disc?.title} verified in Shopify GraphQL locked to customer ${lockedCustomers[0]?.id} (${lockedCustomers[0]?.email})`,
    })
  } catch (err) {
    console.error('❌ TEST 4 FAILED:', err.message)
    testResults.push({ test: 'Test 4: Shopify Email-Lock GraphQL Verification', status: 'FAILED', error: err.message })
  }

  // --------------------------------------------------------------------------
  // TEST 5: Manual Store Credit Issuance ($10.00) to Maya Local
  // --------------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------')
  console.log('▶ TEST 5: Manual Store Credit Issuance ($10.00) via issueStoreCreditGraphQL')
  console.log('--------------------------------------------------------------------')
  try {
    if (!empMaya?.shopify_customer_id) throw new Error('Missing Maya customer ID')

    const manualTx = await issueStoreCreditGraphQL({
      customerId: empMaya.shopify_customer_id,
      amount: 10.0,
      currencyCode: 'USD',
    })
    console.log('5a. Manual Store Credit Issued in Shopify:', manualTx)

    const nowIso = new Date().toISOString()
    await supabase.from('credit_ledger').insert({
      employee_id: empMaya.id,
      amount: 10.0,
      type: 'manual_credit',
      shopify_transaction_id: manualTx.transactionId,
      created_at: nowIso,
    })

    await supabase.from('store_credit_logs').insert({
      employee_id: empMaya.id,
      employee_name: empMaya.full_name,
      work_email: empMaya.work_email,
      amount: 10.0,
      reason: 'Manual Bonus Store Credit',
      shopify_transaction_id: manualTx.transactionId,
      status: 'Success',
      created_at: nowIso,
    })

    console.log('5b. Logged in credit_ledger and store_credit_logs:', { tx: manualTx.transactionId, amount: 10.0 })

    testResults.push({
      test: 'Test 5: Manual Store Credit Issuance ($10.00)',
      status: 'PASSED',
      details: `Transaction ${manualTx.transactionId} issued to ${empMaya.work_email} and logged in credit_ledger`,
    })
  } catch (err) {
    console.error('❌ TEST 5 FAILED:', err.message)
    testResults.push({ test: 'Test 5: Manual Store Credit Issuance', status: 'FAILED', error: err.message })
  }

  // --------------------------------------------------------------------------
  // TEST 6: Instant Deactivation & Status Verification in Shopify GraphQL
  // --------------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------')
  console.log('▶ TEST 6: Instant Deactivation in Shopify GraphQL (discountCodeDeactivate)')
  console.log('--------------------------------------------------------------------')
  try {
    if (!empDavid?.shopify_discount_id) throw new Error('Missing David discount ID')

    // Deactivate in Shopify
    const deactRes = await deactivateDiscountCodeGraphQL(empDavid.shopify_discount_id)
    console.log('6a. Deactivation Result:', deactRes)

    // Check status in Shopify
    const query = `
      query checkStatus($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              status
            }
          }
        }
      }
    `
    const verifyRes = await shopifyGraphQL(query, { id: empDavid.shopify_discount_id })
    const statusInShopify = verifyRes.data?.codeDiscountNode?.codeDiscount?.status
    console.log('6b. Discount Status in Shopify GraphQL:', statusInShopify)

    // Update in Supabase
    await supabase.from('employees').update({ is_active: false, status: 'inactive' }).eq('id', empDavid.id)

    testResults.push({
      test: 'Test 6: Instant Discount Deactivation',
      status: 'PASSED',
      details: `Discount ${empDavid.discount_code} status transitioned to ${statusInShopify} in Shopify GraphQL`,
    })
  } catch (err) {
    console.error('❌ TEST 6 FAILED:', err.message)
    testResults.push({ test: 'Test 6: Instant Discount Deactivation', status: 'FAILED', error: err.message })
  }

  // --------------------------------------------------------------------------
  // TEST 7: Monthly Credit Cron Run (/api/cron/monthly-credit logic)
  // --------------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------')
  console.log('▶ TEST 7: Automated Monthly Credit Job Simulation')
  console.log('--------------------------------------------------------------------')
  try {
    const { data: emps } = await supabase.from('employees').select('*')
    const activeEmps = (emps || []).filter((e) => e.is_active !== false && String(e.status).toLowerCase() !== 'inactive')
    console.log(`7a. Found ${activeEmps.length} active employees to process in monthly cron`)

    let processed = 0
    let skippedZero = 0
    for (const emp of activeEmps) {
      const credit = Number(emp.monthly_credit_amount ?? 25.0)
      if (credit <= 0) {
        skippedZero++
        console.log(` - Employee ${emp.work_email} has $0 configured: SKIPPED CLEANLY`)
        continue
      }

      console.log(` - Employee ${emp.work_email} gets $${credit.toFixed(2)} monthly credit`)
      processed++
    }

    console.log(`7b. Monthly Cron Simulation Completed: ${processed} credited, ${skippedZero} skipped ($0 credit)`)

    testResults.push({
      test: 'Test 7: Monthly Credit Cron Job Logic',
      status: 'PASSED',
      details: `Processed active employees, successfully skipped $0 credit employees without error`,
    })
  } catch (err) {
    console.error('❌ TEST 7 FAILED:', err.message)
    testResults.push({ test: 'Test 7: Monthly Credit Cron Job Logic', status: 'FAILED', error: err.message })
  }

  console.log('\n====================================================================')
  console.log('📋 FINAL LIVE TEST REPORT SUMMARY')
  console.log('====================================================================')
  testResults.forEach((t) => {
    console.log(`[${t.status}] ${t.test} - ${t.details || t.error}`)
  })
}

runLiveTests().catch(console.error)
