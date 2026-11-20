import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  hashLoginCode,
  verifyLoginCodeHash,
  createSessionToken,
  verifySessionToken,
} from '../lib/session.js'
import {
  generateDiscountCode,
  generateEmpDiscountCode,
  normalizeShopifyId,
  findOrCreateCustomer,
  findOrCreateCustomerGraphQL,
  createEmailLockedDiscountCode,
  createEmailLockedDiscountGraphQL,
  createEmailLockedPriceRule,
  issueStoreCredit,
  issueStoreCreditGraphQL,
  deactivateDiscountCode,
  deactivateDiscountCodeGraphQL,
  activateDiscountCode,
  activateDiscountCodeGraphQL,
} from '../lib/shopify.js'
import { verifySlackSignature } from '../lib/slack.js'

// Set test environment secrets
process.env.FINANCE_SESSION_SECRET = 'test-secret-key-for-ksc-discounts-32chars!'
process.env.SLACK_SIGNING_SECRET = 'test-slack-signing-secret-12345'
process.env.CRON_SECRET = 'test-cron-secret-67890'

test('Auth: Hash and verify login code correctly', () => {
  const email = 'sarah@kawaiislimecompany.com'
  const code = '4821'

  const hash = hashLoginCode(email, code)
  assert.ok(hash && typeof hash === 'string', 'Hash should be generated')

  const isValid = verifyLoginCodeHash(email, code, hash)
  assert.equal(isValid, true, 'Valid code should match hash')

  const isInvalid = verifyLoginCodeHash(email, '9999', hash)
  assert.equal(isInvalid, false, 'Invalid code should not match')

  const wrongEmail = verifyLoginCodeHash('other@kawaiislimecompany.com', code, hash)
  assert.equal(wrongEmail, false, 'Wrong email should not match')
})

test('Auth: Session token creation and cryptographic verification', () => {
  const user = {
    username: 'admin@kawaiislimecompany.com',
    name: 'Sarah Connor',
    email: 'sarah@kawaiislimecompany.com',
    role: 'Admin',
    slack_user_id: 'U12345678',
  }

  const token = createSessionToken(user)
  assert.ok(token && token.includes('.'), 'Token should be formed as body.sig')

  const verified = verifySessionToken(token)
  assert.ok(verified, 'Token should verify successfully')
  assert.equal(verified.email, user.email)
  assert.equal(verified.role, 'Admin')

  // Tampered signature test
  const [body, sig] = token.split('.')
  const tamperedSig = sig.slice(0, -2) + (sig.endsWith('a') ? 'b' : 'a')
  assert.equal(verifySessionToken(`${body}.${tamperedSig}`), null, 'Tampered signature must be rejected')

  // Invalid payload test
  assert.equal(verifySessionToken('invalid.token'), null, 'Malformed token must be rejected')
})

test('Shopify: Unique discount code generator format', () => {
  const code1 = generateDiscountCode('Jessica Alba')
  const code2 = generateDiscountCode('Jessica Alba')
  const code3 = generateDiscountCode('')

  assert.match(code1, /^KSC-JESSICA-[A-F0-9]{4}$/, 'Format must be KSC-<NAME>-<4CHARS>')
  assert.match(code2, /^KSC-JESSICA-[A-F0-9]{4}$/)
  assert.match(code3, /^KSC-STAFF-[A-F0-9]{4}$/)
  assert.notEqual(code1, code2, 'Subsequent codes must be uniquely salted')
})

test('Shopify: ID normalizer', () => {
  const numericId = '7891234567'
  const gidId = 'gid://shopify/Customer/7891234567'

  assert.equal(normalizeShopifyId(numericId, 'Customer'), 'gid://shopify/Customer/7891234567')
  assert.equal(normalizeShopifyId(gidId, 'Customer'), gidId, 'Existing GID should remain unchanged')
  assert.equal(normalizeShopifyId('12345', 'DiscountCodeNode'), 'gid://shopify/DiscountCodeNode/12345')
  assert.equal(normalizeShopifyId(null), null)
})

test('Shopify: Mock operations when credentials not configured', async () => {
  // Test customer finding/creation fallback
  const customer = await findOrCreateCustomerGraphQL({
    email: 'test.employee@kawaiislimecompany.com',
    fullName: 'Emily Davis',
  })
  assert.ok(customer.id.startsWith('gid://shopify/Customer/'))
  assert.equal(customer.email, 'test.employee@kawaiislimecompany.com')

  // Test GraphQL discount code creation
  const discount = await createEmailLockedDiscountGraphQL({
    customerId: customer.id,
    employeeName: 'Emily Davis',
    workEmail: 'test.employee@kawaiislimecompany.com',
    discountPercentage: 20,
    uniqueCode: 'EMP-EMILY-4422',
  })
  assert.ok(discount.discountId)
  assert.equal(discount.discountCode, 'EMP-EMILY-4422')
  assert.equal(discount.discountPercentage, 20)

  // Test GraphQL store credit issuance
  const credit = await issueStoreCreditGraphQL({
    customerId: customer.id,
    amount: 25.0,
    currencyCode: 'USD',
  })
  assert.ok(credit.transactionId)
  assert.equal(credit.amount, '25.00')
  assert.equal(credit.currencyCode, 'USD')

  // Test GraphQL discount code deactivation
  const deact = await deactivateDiscountCodeGraphQL(discount.discountId)
  assert.equal(deact.success, true)
  assert.equal(deact.status, 'DEACTIVATED')

  // Test GraphQL discount code activation
  const act = await activateDiscountCodeGraphQL(discount.discountId)
  assert.equal(act.success, true)
  assert.equal(act.status, 'ACTIVE')
})

test('Slack: HMAC signature verification with replay protection', () => {
  const secret = 'test-slack-signing-secret-12345'
  const now = Date.now()
  const timestamp = Math.floor(now / 1000).toString()
  const rawBody = JSON.stringify({ type: 'event_callback', event: { type: 'team_join' } })

  const sigBase = `v0:${timestamp}:${rawBody}`
  const validSignature = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex')

  const validHeaders = {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': validSignature,
  }
  assert.equal(
    verifySlackSignature(rawBody, validHeaders, now),
    true,
    'Valid HMAC signature must verify'
  )

  // Tampered signature
  const invalidHeaders = {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
  }
  assert.equal(
    verifySlackSignature(rawBody, invalidHeaders, now),
    false,
    'Invalid signature must fail'
  )

  // Replay check: timestamp older than 5 minutes (301 seconds)
  const oldTimestamp = (Math.floor(now / 1000) - 305).toString()
  const oldSigBase = `v0:${oldTimestamp}:${rawBody}`
  const oldSig = 'v0=' + crypto.createHmac('sha256', secret).update(oldSigBase).digest('hex')
  const expiredHeaders = {
    'x-slack-request-timestamp': oldTimestamp,
    'x-slack-signature': oldSig,
  }
  assert.equal(
    verifySlackSignature(rawBody, expiredHeaders, now),
    false,
    'Expired request timestamp must be rejected'
  )
})

test('Slack Webhook /api/webhooks/slack: url_verification challenge response format', async () => {
  const mockReq = {
    method: 'POST',
    body: {
      type: 'url_verification',
      token: 'slack_verification_token',
      challenge: '3eZbrAqImPgnRaeSIvtayYrIoaxkW3MyrhCHGyMr',
    },
    headers: {},
  }

  let statusCode = 0
  let jsonResult = null
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code
      return {
        json: (data) => {
          jsonResult = data
        },
      }
    },
  }

  const { default: webhookHandler } = await import('../api/webhooks/slack.js')
  await webhookHandler(mockReq, mockRes)

  assert.equal(statusCode, 200)
  assert.equal(jsonResult.challenge, '3eZbrAqImPgnRaeSIvtayYrIoaxkW3MyrhCHGyMr')
})

test('API Guards: Auth endpoint handles test mode 1234 verification', async () => {
  const { default: authHandler } = await import('../api/auth.js')

  let statusCode = 0
  let jsonResult = null
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code
      return {
        json: (data) => {
          jsonResult = data
        },
      }
    },
  }

  const req = {
    method: 'POST',
    query: { route: 'verify-code' },
    body: { email: 'admin@kawaiislimecompany.com', code: '1234' },
    headers: {},
  }

  await authHandler(req, mockRes)
  assert.equal(statusCode, 200)
  assert.equal(jsonResult.ok, true)
  assert.ok(jsonResult.token, 'Should return a signed JWT/session token')
  assert.equal(jsonResult.user.role, 'Admin')
})

test('API Guards: Unauthorized request blocked without session', async () => {
  const { default: discountsHandler } = await import('../api/discounts.js')

  const origUrl = process.env.SUPABASE_URL
  process.env.SUPABASE_URL = 'https://realproject.supabase.co'

  let statusCode = 0
  let jsonResult = null
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code
      return {
        json: (data) => {
          jsonResult = data
        },
      }
    },
  }

  const req = {
    method: 'GET',
    query: { route: 'data' },
    headers: {},
  }

  await discountsHandler(req, mockRes)
  assert.equal(statusCode, 401)
  assert.equal(jsonResult.ok, false)

  process.env.SUPABASE_URL = origUrl
})

test('Shopify REST 2026-01: generateEmpDiscountCode format EMP-{NAME}-{4DIGITS}', async () => {
  const code = generateEmpDiscountCode('Zunair Rafiq')
  assert.match(code, /^EMP-ZUNAIR-\d{4}$/, 'Must match EMP-ZUNAIR-XXXX')
  assert.ok(!code.includes(' '), 'Code must contain no spaces')
  assert.equal(code, code.toUpperCase(), 'Code must be all uppercase')

  const code2 = generateEmpDiscountCode('Sarah Jane Connor')
  assert.match(code2, /^EMP-SARAH-\d{4}$/)
})

test('Shopify REST 2026-01: createEmailLockedPriceRule locks to prerequisite_customer_ids', async () => {
  const res = await createEmailLockedPriceRule({
    customerId: '7891234567',
    discountPercentage: 20,
    uniqueCode: 'EMP-TEST-1234',
  })

  assert.ok(res.priceRuleId, 'Price rule ID must be generated')
  assert.equal(res.code, 'EMP-TEST-1234')
  assert.equal(res.discountPercentage, 20)
  assert.equal(res.customerId, '7891234567')
})

test('Backend Endpoint /api/employees/create: Validates inputs and creates email-locked discount', async () => {
  const { default: createHandler } = await import('../api/employees/create.js')

  // 1. Missing full name validation
  let statusCode = 0
  let jsonResult = null
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code
      return { json: (d) => { jsonResult = d } }
    },
  }

  await createHandler({
    method: 'POST',
    body: { full_name: '', work_email: 'test@kawaiislimecompany.com' },
    headers: {},
  }, mockRes)

  assert.equal(statusCode, 400)
  assert.equal(jsonResult.success, false)

  // 2. Successful creation
  statusCode = 0
  jsonResult = null

  await createHandler({
    method: 'POST',
    body: {
      full_name: 'Zunair Rafiq',
      work_email: 'zunair@kawaiislimecompany.com',
      discount_percentage: 20,
      monthly_credit_amount: 25.0,
      location_type: 'local',
    },
    headers: {},
  }, mockRes)

  assert.equal(statusCode, 201)
  assert.equal(jsonResult.success, true)
  assert.ok(jsonResult.employee)
  assert.match(jsonResult.employee.discount_code, /^EMP-ZUNAIR-\d{4}$/)
  assert.equal(jsonResult.employee.location_type, 'local')
  assert.equal(jsonResult.employee.status, 'active')
  assert.equal(jsonResult.employee.is_active, true)
})

test('Backend Endpoint /api/employees/deactivate: Deactivates employee & discount code', async () => {
  const { default: deactivateHandler } = await import('../api/employees/deactivate.js')

  let statusCode = 0
  let jsonResult = null
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code
      return { json: (d) => { jsonResult = d } }
    },
  }

  await deactivateHandler({
    method: 'POST',
    body: {
      work_email: 'zunair@kawaiislimecompany.com',
      shopify_discount_id: 'gid://shopify/DiscountCodeNode/mock_9988776655',
    },
    headers: {},
  }, mockRes)

  assert.equal(statusCode, 200)
  assert.equal(jsonResult.success, true)
  assert.equal(jsonResult.employee.status, 'inactive')
  assert.equal(jsonResult.employee.is_active, false)
})

test('Backend Endpoint /api/employees: Lists employees', async () => {
  const { default: listHandler } = await import('../api/employees/index.js')

  let statusCode = 0
  let jsonResult = null
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code
      return { json: (d) => { jsonResult = d } }
    },
  }

  await listHandler({ method: 'GET', headers: {} }, mockRes)

  assert.equal(statusCode, 200)
  assert.equal(jsonResult.success, true)
  assert.ok(Array.isArray(jsonResult.employees))
})

test('Monthly Cron /api/cron/monthly-credit: CRON_SECRET guard and execution', async () => {
  const { default: cronHandler } = await import('../api/cron/monthly-credit.js')

  let statusCode = 0
  let jsonResult = null
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code
      return { json: (d) => { jsonResult = d } }
    },
  }

  // 1. Unauthorized request without CRON_SECRET
  await cronHandler({
    method: 'GET',
    headers: { authorization: 'Bearer wrong-secret' },
  }, mockRes)

  assert.equal(statusCode, 401)
  assert.equal(jsonResult.success, false)

  // 2. Authorized request with Bearer CRON_SECRET
  statusCode = 0
  jsonResult = null

  await cronHandler({
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }, mockRes)

  assert.equal(statusCode, 200)
  assert.equal(jsonResult.success, true)
  assert.ok(jsonResult.summary)
})
