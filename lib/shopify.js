import crypto from 'node:crypto'
import { clean } from './db.js'

export function getShopifyConfig() {
  let domain = clean(
    process.env.SHOPIFY_STORE_DOMAIN ||
    process.env.SHOPIFY_SHOP ||
    process.env.VITE_SHOPIFY_STORE_DOMAIN
  )
  if (domain && !domain.includes('.')) {
    domain = `${domain}.myshopify.com`
  }
  if (domain) {
    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  }
  const token = clean(
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
    process.env.SHOPIFY_ACCESS_TOKEN
  )
  const apiVersion = clean(process.env.SHOPIFY_API_VERSION) || '2026-01'

  const isConfigured = Boolean(
    domain &&
    token &&
    !token.includes('placeholder') &&
    !token.includes('your-shopify')
  )

  return { domain, token, apiVersion, isConfigured }
}

export function normalizeShopifyId(id, type = 'Customer') {
  if (!id) return null
  const strId = String(id).trim()
  if (strId.startsWith('gid://shopify/')) return strId
  const numericOnly = strId.replace(/\D/g, '')
  if (!numericOnly) return strId
  return `gid://shopify/${type}/${numericOnly}`
}

export function extractNumericShopifyId(id) {
  if (!id) return null
  const strId = String(id).trim()
  const match = strId.match(/(\d+)$/)
  return match ? match[1] : strId.replace(/\D/g, '')
}

/**
 * Format: EMP-{FIRSTNAME_UPPERCASE}-{4_DIGIT_RANDOM} (e.g. EMP-ZUNAIR-4821)
 * Strictly removes special characters and spaces.
 */
export function generateEmpDiscountCode(fullName = '') {
  const parts = String(fullName || '').trim().split(/\s+/)
  const firstName = parts[0] || 'STAFF'
  const cleanName = firstName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 15) || 'STAFF'
  const random4Digit = Math.floor(1000 + Math.random() * 9000).toString()
  return `EMP-${cleanName}-${random4Digit}`
}

export function generateDiscountCode(employeeName = '') {
  const parts = String(employeeName || '').trim().split(/\s+/)
  const firstName = parts[0] || 'STAFF'
  const cleanName = firstName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10) || 'STAFF'
  const randomChars = crypto.randomBytes(2).toString('hex').toUpperCase()
  return `KSC-${cleanName}-${randomChars}`
}

/**
 * Generic Shopify GraphQL Admin API Helper
 */
export async function shopifyGraphQL(query, variables = {}) {
  const { domain, token, apiVersion, isConfigured } = getShopifyConfig()

  if (!isConfigured) {
    console.warn('[Shopify GraphQL] Credentials not configured, returning simulated response.')
    return { isMock: true, data: null }
  }

  const endpoint = `https://${domain}/admin/api/${apiVersion}/graphql.json`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`Shopify API HTTP ${res.status}: ${errorText}`)
  }

  const json = await res.json()
  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message).join(', ')
    throw new Error(`Shopify GraphQL error: ${messages}`)
  }

  return { isMock: false, data: json.data }
}

/**
 * Generic Shopify REST API Helper (Fallback)
 */
export async function shopifyRest(path, { method = 'GET', body = null } = {}) {
  const { domain, token, apiVersion, isConfigured } = getShopifyConfig()

  if (!isConfigured) {
    console.warn(`[Shopify REST] Credentials not configured. Simulating ${method} ${path}`)
    return { isMock: true, data: null }
  }

  const endpoint = `https://${domain}/admin/api/${apiVersion}/${path.replace(/^\//, '')}`
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
  }

  const options = {
    method,
    headers,
  }
  if (body) {
    options.body = JSON.stringify(body)
  }

  const res = await fetch(endpoint, options)
  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`Shopify REST API HTTP ${res.status}: ${errorText}`)
  }

  const json = await res.json().catch(() => ({}))
  return { isMock: false, data: json }
}

/**
 * 1. Find or Create Shopify Customer via GraphQL Admin API
 */
export async function findOrCreateCustomerGraphQL({ email, fullName = '' }) {
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanEmail) throw new Error('Customer email is required.')

  const parts = String(fullName || '').trim().split(/\s+/)
  const firstName = parts[0] || 'Team'
  const lastName = parts.slice(1).join(' ') || 'Member'

  const { isConfigured } = getShopifyConfig()
  if (!isConfigured) {
    const mockNumericId = String(Math.floor(1000000000 + Math.random() * 9000000000))
    return {
      id: `gid://shopify/Customer/${mockNumericId}`,
      email: cleanEmail,
      firstName,
      lastName,
      isMock: true,
    }
  }

  // 1a. Query customer by email via GraphQL
  const searchQuery = `
    query findCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            email
            firstName
            lastName
          }
        }
      }
    }
  `

  try {
    const searchRes = await shopifyGraphQL(searchQuery, { query: `email:${cleanEmail}` })
    const existing = searchRes.data?.customers?.edges?.[0]?.node
    if (existing?.id) {
      return {
        id: existing.id,
        email: existing.email || cleanEmail,
        firstName: existing.firstName || firstName,
        lastName: existing.lastName || lastName,
      }
    }
  } catch (searchErr) {
    console.warn('[Shopify GraphQL] Customer search warning, proceeding to customerCreate:', searchErr.message)
  }

  // 1b. Create customer via GraphQL mutation
  const createMutation = `
    mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          firstName
          lastName
        }
        userErrors {
          field
          message
        }
      }
    }
  `

  const input = {
    email: cleanEmail,
    firstName,
    lastName,
    tags: ['employee', 'staff-discount'],
    note: 'Kawaii Slime Company Verified Staff',
  }

  try {
    const createRes = await shopifyGraphQL(createMutation, { input })
    const userErrors = createRes.data?.customerCreate?.userErrors || []
    const customer = createRes.data?.customerCreate?.customer

    if (customer?.id) {
      return {
        id: customer.id,
        email: customer.email || cleanEmail,
        firstName: customer.firstName || firstName,
        lastName: customer.lastName || lastName,
      }
    }

    // Check if error is because email already exists, then fetch again
    const emailTaken = userErrors.some((e) =>
      String(e.message).toLowerCase().includes('already been taken') ||
      String(e.message).toLowerCase().includes('already exists')
    )

    if (emailTaken) {
      const retryRes = await shopifyGraphQL(searchQuery, { query: `email:${cleanEmail}` })
      const found = retryRes.data?.customers?.edges?.[0]?.node
      if (found?.id) {
        return {
          id: found.id,
          email: found.email || cleanEmail,
          firstName: found.firstName || firstName,
          lastName: found.lastName || lastName,
        }
      }
    }

    if (userErrors.length > 0) {
      const errMsgs = userErrors.map((e) => e.message).join(', ')
      throw new Error(`Shopify customerCreate user error: ${errMsgs}`)
    }
  } catch (err) {
    console.warn('[Shopify GraphQL customerCreate error, falling back to REST]:', err.message)
    const restCust = await findOrCreateCustomerRest({ email: cleanEmail, fullName })
    return {
      id: normalizeShopifyId(restCust.id, 'Customer'),
      email: restCust.email,
      firstName: restCust.first_name,
      lastName: restCust.last_name,
    }
  }
}

/**
 * Find or Create Customer (Unified function)
 */
export async function findOrCreateCustomer({ email, name = '', fullName = '' }) {
  const nameToUse = fullName || name
  return findOrCreateCustomerGraphQL({ email, fullName: nameToUse })
}

/**
 * Find or Create Customer via REST API (Fallback)
 */
export async function findOrCreateCustomerRest({ email, fullName = '' }) {
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanEmail) throw new Error('Customer email is required.')

  const parts = String(fullName || '').trim().split(/\s+/)
  const firstName = parts[0] || 'Team'
  const lastName = parts.slice(1).join(' ') || 'Member'

  const { isConfigured } = getShopifyConfig()
  if (!isConfigured) {
    const mockNumericId = String(Math.floor(1000000000 + Math.random() * 9000000000))
    return {
      id: mockNumericId,
      email: cleanEmail,
      first_name: firstName,
      last_name: lastName,
      isMock: true,
    }
  }

  const searchPath = `customers/search.json?query=email:${encodeURIComponent(cleanEmail)}`
  const searchResult = await shopifyRest(searchPath, { method: 'GET' })

  const existing = searchResult.data?.customers?.[0]
  if (existing) {
    return {
      id: String(existing.id),
      email: existing.email,
      first_name: existing.first_name,
      last_name: existing.last_name,
    }
  }

  const createPath = 'customers.json'
  const createBody = {
    customer: {
      first_name: firstName,
      last_name: lastName,
      email: cleanEmail,
      tags: 'employee, staff-discount',
      verified_email: true,
      note: 'Kawaii Slime Company Verified Staff',
    },
  }

  const createResult = await shopifyRest(createPath, { method: 'POST', body: createBody })
  const newCustomer = createResult.data?.customer
  if (!newCustomer?.id) {
    throw new Error('Failed to create customer in Shopify: Invalid response')
  }

  return {
    id: String(newCustomer.id),
    email: newCustomer.email,
    first_name: newCustomer.first_name,
    last_name: newCustomer.last_name,
  }
}

/**
 * 2. Create Email-Locked Discount Code via GraphQL Admin API (discountCodeBasicCreate)
 * Strictly locks to prerequisite customer GID so code cannot be shared or abused.
 */
export async function createEmailLockedDiscountGraphQL({
  customerId,
  employeeName,
  workEmail,
  discountPercentage = 20,
  uniqueCode = null,
}) {
  const code = uniqueCode || generateEmpDiscountCode(employeeName)
  const normCustomerId = normalizeShopifyId(customerId, 'Customer')
  const decimalPercent = Number((Math.abs(discountPercentage) / 100).toFixed(4))
  const { isConfigured } = getShopifyConfig()

  if (!isConfigured) {
    const mockDiscountId = `gid://shopify/DiscountCodeNode/mock_${code}`
    return {
      discountId: mockDiscountId,
      discountCode: code,
      discountPercentage: Number(discountPercentage),
      customerId: normCustomerId,
      isMock: true,
    }
  }

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              summary
              status
              codes(first: 1) {
                nodes {
                  code
                }
              }
            }
          }
        }
        userErrors {
          field
          code
          message
        }
      }
    }
  `

  const variables = {
    basicCodeDiscount: {
      title: code,
      code,
      startsAt: new Date().toISOString(),
      customerSelection: {
        customers: {
          add: [normCustomerId],
        },
      },
      customerGets: {
        value: {
          percentage: decimalPercent,
        },
        items: {
          all: true,
        },
      },
      appliesOncePerCustomer: false,
    },
  }

  try {
    const res = await shopifyGraphQL(mutation, variables)
    const userErrors = res.data?.discountCodeBasicCreate?.userErrors || []
    if (userErrors.length > 0) {
      const errMsgs = userErrors.map((e) => e.message).join(', ')
      throw new Error(`Shopify discountCodeBasicCreate error: ${errMsgs}`)
    }

    const node = res.data?.discountCodeBasicCreate?.codeDiscountNode
    if (!node?.id) {
      throw new Error('Failed to create discountCodeBasic: Missing codeDiscountNode ID')
    }

    return {
      discountId: node.id,
      discountCode: code,
      discountPercentage: Number(discountPercentage),
      customerId: normCustomerId,
    }
  } catch (err) {
    console.warn('[Shopify GraphQL discountCodeBasicCreate warning, attempting REST price rule]:', err.message)
    const restRes = await createEmailLockedPriceRule({
      customerId: normCustomerId,
      discountPercentage,
      uniqueCode: code,
    })
    return {
      discountId: restRes.priceRuleId,
      discountCode: restRes.code,
      discountPercentage: Number(discountPercentage),
      customerId: normCustomerId,
    }
  }
}

/**
 * Backward compatibility alias for createEmailLockedDiscountCode
 */
export async function createEmailLockedDiscountCode({
  customerId,
  employeeName,
  workEmail,
  discountPercent = 20,
  code = null,
}) {
  return createEmailLockedDiscountGraphQL({
    customerId,
    employeeName,
    workEmail,
    discountPercentage: discountPercent,
    uniqueCode: code,
  })
}

/**
 * Create Email-Locked Price Rule via REST API (Fallback)
 */
export async function createEmailLockedPriceRule({
  customerId,
  discountPercentage = 20,
  uniqueCode,
}) {
  const numericCustomerId = extractNumericShopifyId(customerId)
  if (!numericCustomerId) {
    throw new Error('Valid numeric customer ID is required to lock price rule to employee.')
  }

  const percentVal = Math.abs(Number(discountPercentage))
  const { isConfigured } = getShopifyConfig()

  if (!isConfigured) {
    const mockPriceRuleId = String(Math.floor(1000000000 + Math.random() * 9000000000))
    const mockCodeId = String(Math.floor(1000000000 + Math.random() * 9000000000))
    return {
      priceRuleId: mockPriceRuleId,
      discountCodeId: mockCodeId,
      code: uniqueCode,
      discountPercentage: percentVal,
      customerId: numericCustomerId,
      isMock: true,
    }
  }

  const priceRuleBody = {
    price_rule: {
      title: uniqueCode,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: 'percentage',
      value: `-${percentVal}`,
      customer_selection: 'prerequisite',
      prerequisite_customer_ids: [Number(numericCustomerId)],
      starts_at: new Date().toISOString(),
    },
  }

  const ruleResult = await shopifyRest('price_rules.json', {
    method: 'POST',
    body: priceRuleBody,
  })

  const priceRule = ruleResult.data?.price_rule
  if (!priceRule?.id) {
    throw new Error('Failed to create Shopify price rule: Missing ID')
  }

  const priceRuleId = String(priceRule.id)

  const codeBody = {
    discount_code: {
      code: uniqueCode,
    },
  }

  const codeResult = await shopifyRest(`price_rules/${priceRuleId}/discount_codes.json`, {
    method: 'POST',
    body: codeBody,
  })

  const discountCode = codeResult.data?.discount_code
  const discountCodeId = discountCode ? String(discountCode.id) : null

  return {
    priceRuleId,
    discountCodeId,
    code: uniqueCode,
    discountPercentage: percentVal,
    customerId: numericCustomerId,
  }
}

/**
 * 3. Credit Native Store Credit Balance via GraphQL Admin API (storeCreditAccountCredit)
 */
export async function issueStoreCreditGraphQL({ customerId, amount, currencyCode = 'USD' }) {
  return issueStoreCredit({ customerId, amount, currencyCode })
}

export async function issueStoreCredit({ customerId, amount, currencyCode = 'USD' }) {
  const normCustomerId = normalizeShopifyId(customerId, 'Customer')
  const creditAmountNumber = Number(amount)
  if (!Number.isFinite(creditAmountNumber) || creditAmountNumber <= 0) {
    throw new Error('Valid credit amount greater than 0 is required.')
  }

  const formattedAmount = creditAmountNumber.toFixed(2)
  const { isConfigured } = getShopifyConfig()

  if (!isConfigured) {
    return {
      transactionId: `trans_mock_${Date.now()}`,
      amount: formattedAmount,
      currencyCode,
      customerId: normCustomerId,
      isMock: true,
    }
  }

  const mutation = `
    mutation StoreCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction {
          id
          amount {
            amount
            currencyCode
          }
          account {
            id
            balance {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `

  const variables = {
    id: normCustomerId,
    creditInput: {
      creditAmount: {
        amount: formattedAmount,
        currencyCode,
      },
    },
  }

  const res = await shopifyGraphQL(mutation, variables)
  const userErrors = res.data?.storeCreditAccountCredit?.userErrors || []
  if (userErrors.length > 0) {
    const errText = userErrors.map((e) => e.message).join(', ')
    throw new Error(`Failed to issue Shopify store credit: ${errText}`)
  }

  const transaction = res.data?.storeCreditAccountCredit?.storeCreditAccountTransaction
  return {
    transactionId: transaction?.id || `trans_${Date.now()}`,
    amount: formattedAmount,
    currencyCode,
    customerId: normCustomerId,
  }
}

/**
 * 4. Deactivate Discount Code via GraphQL Admin API (discountCodeDeactivate)
 * Fallback to REST price rule deletion if applicable.
 */
export async function deactivateDiscountCodeGraphQL(discountId) {
  if (!discountId) return { success: true, skipped: true }

  const { isConfigured } = getShopifyConfig()
  if (!isConfigured) {
    return { success: true, isMock: true, discountId, status: 'DEACTIVATED' }
  }

  const strId = String(discountId).trim()

  // If GID for DiscountCodeNode, deactivate via GraphQL
  if (strId.startsWith('gid://shopify/DiscountCodeNode/')) {
    const mutation = `
      mutation discountCodeDeactivate($id: ID!) {
        discountCodeDeactivate(id: $id) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                status
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `
    try {
      const res = await shopifyGraphQL(mutation, { id: strId })
      const userErrors = res.data?.discountCodeDeactivate?.userErrors || []
      if (userErrors.length > 0) {
        console.warn('[deactivateDiscountCodeGraphQL] User errors:', userErrors)
      } else {
        return { success: true, discountId: strId, status: 'DEACTIVATED' }
      }
    } catch (err) {
      console.warn('[deactivateDiscountCodeGraphQL error]:', err.message)
    }
  }

  // Fallback to REST price rule deletion for numeric or legacy price rules
  return deleteShopifyPriceRule(strId)
}

export async function deactivateDiscountCode(discountId) {
  return deactivateDiscountCodeGraphQL(discountId)
}

/**
 * Reactivate Discount Code via GraphQL Admin API (discountCodeActivate)
 */
export async function activateDiscountCodeGraphQL(discountId) {
  if (!discountId) return { success: true, skipped: true }

  const { isConfigured } = getShopifyConfig()
  if (!isConfigured) {
    return { success: true, isMock: true, discountId, status: 'ACTIVE' }
  }

  const strId = String(discountId).trim()

  if (strId.startsWith('gid://shopify/DiscountCodeNode/')) {
    const mutation = `
      mutation discountCodeActivate($id: ID!) {
        discountCodeActivate(id: $id) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                status
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `
    try {
      const res = await shopifyGraphQL(mutation, { id: strId })
      const userErrors = res.data?.discountCodeActivate?.userErrors || []
      if (userErrors.length > 0) {
        console.warn('[activateDiscountCodeGraphQL] User errors:', userErrors)
      } else {
        return { success: true, discountId: strId, status: 'ACTIVE' }
      }
    } catch (err) {
      console.warn('[activateDiscountCodeGraphQL error]:', err.message)
    }
  }

  return { success: true, status: 'ACTIVE' }
}

export async function activateDiscountCode(discountId) {
  return activateDiscountCodeGraphQL(discountId)
}

/**
 * Delete Shopify Price Rule by ID via REST API
 */
export async function deleteShopifyPriceRule(priceRuleId) {
  const numericRuleId = extractNumericShopifyId(priceRuleId)
  if (!numericRuleId) return { success: true, skipped: true }

  const { isConfigured } = getShopifyConfig()
  if (!isConfigured) {
    return { success: true, isMock: true, priceRuleId: numericRuleId, status: 'DEACTIVATED' }
  }

  try {
    await shopifyRest(`price_rules/${numericRuleId}.json`, {
      method: 'DELETE',
    })
    return { success: true, priceRuleId: numericRuleId }
  } catch (err) {
    if (err.message.includes('404')) {
      return { success: true, alreadyDeleted: true }
    }
    throw err
  }
}
