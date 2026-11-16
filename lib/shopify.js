import crypto from 'node:crypto'
import { clean } from './db.js'

function getShopifyConfig() {
  let domain = clean(process.env.SHOPIFY_STORE_DOMAIN || process.env.VITE_SHOPIFY_STORE_DOMAIN)
  if (domain && !domain.includes('.')) {
    domain = `${domain}.myshopify.com`
  }
  if (domain) {
    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  }
  const token = clean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN)
  const apiVersion = clean(process.env.SHOPIFY_API_VERSION) || '2025-01'

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

export async function shopifyGraphQL(query, variables = {}) {
  const { domain, token, apiVersion, isConfigured } = getShopifyConfig()

  if (!isConfigured) {
    console.warn('[Shopify GraphQL] Shopify credentials not configured, returning simulated response.')
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
 * 1. Find or Create Shopify Customer by work email
 */
export async function findOrCreateCustomer({ email, name = '' }) {
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanEmail) throw new Error('Customer email is required.')

  const parts = name.trim().split(/\s+/)
  const firstName = parts[0] || 'Team'
  const lastName = parts.slice(1).join(' ') || 'Member'

  const { isConfigured } = getShopifyConfig()
  if (!isConfigured) {
    const mockId = `gid://shopify/Customer/mock_${Buffer.from(cleanEmail).toString('hex').slice(0, 10)}`
    return {
      id: mockId,
      email: cleanEmail,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      isMock: true,
    }
  }

  // 1a. Query existing customer
  const findQuery = `
    query FindCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            email
            firstName
            lastName
            displayName
          }
        }
      }
    }
  `
  const findRes = await shopifyGraphQL(findQuery, { query: `email:${cleanEmail}` })
  const existing = findRes.data?.customers?.edges?.[0]?.node
  if (existing) {
    return existing
  }

  // 1b. Create customer if not found
  const createMutation = `
    mutation CreateCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          firstName
          lastName
          displayName
        }
        userErrors {
          field
          message
        }
      }
    }
  `
  const createRes = await shopifyGraphQL(createMutation, {
    input: {
      email: cleanEmail,
      firstName,
      lastName,
      note: 'Kawaii Slime Company Verified Employee',
      tags: ['KSC Employee', 'Staff Discount'],
    },
  })

  const userErrors = createRes.data?.customerCreate?.userErrors || []
  if (userErrors.length > 0) {
    const errText = userErrors.map((e) => e.message).join(' ')
    // In case customer was created concurrently, try querying again
    if (errText.toLowerCase().includes('already taken') || errText.toLowerCase().includes('has already been taken')) {
      const retryRes = await shopifyGraphQL(findQuery, { query: `email:${cleanEmail}` })
      const found = retryRes.data?.customers?.edges?.[0]?.node
      if (found) return found
    }
    throw new Error(`Failed to create Shopify customer: ${errText}`)
  }

  return createRes.data.customerCreate.customer
}

/**
 * 2. Create Email-Locked Unique Discount Code (discountCodeBasicCreate)
 * Strictly email/customer-locked using customerSelection: { customers: { add: [customerId] } }
 */
export async function createEmailLockedDiscountCode({
  customerId,
  employeeName,
  workEmail,
  discountPercent = 20,
  code = null,
}) {
  const normCustomerId = normalizeShopifyId(customerId, 'Customer')
  const discountCode = code || generateDiscountCode(employeeName)
  const percentDecimal = Number(discountPercent) / 100

  const { isConfigured } = getShopifyConfig()
  if (!isConfigured) {
    return {
      discountId: `gid://shopify/DiscountCodeNode/mock_${discountCode}`,
      discountCode,
      discountPercent: Number(discountPercent),
      customerId: normCustomerId,
      isMock: true,
    }
  }

  const mutation = `
    mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
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
      title: `Employee Discount (${discountPercent}%) - ${employeeName || workEmail}`,
      code: discountCode,
      startsAt: new Date().toISOString(),
      customerSelection: {
        customers: {
          add: [normCustomerId],
        },
      },
      customerGets: {
        value: {
          percentage: percentDecimal,
        },
        items: {
          all: true,
        },
      },
      appliesOncePerCustomer: false,
    },
  }

  const res = await shopifyGraphQL(mutation, variables)
  const userErrors = res.data?.discountCodeBasicCreate?.userErrors || []
  if (userErrors.length > 0) {
    const errText = userErrors.map((e) => `${e.field ? e.field + ': ' : ''}${e.message}`).join(', ')
    throw new Error(`Shopify discount creation failed: ${errText}`)
  }

  const node = res.data?.discountCodeBasicCreate?.codeDiscountNode
  return {
    discountId: node?.id,
    discountCode,
    discountPercent: Number(discountPercent),
    customerId: normCustomerId,
  }
}

/**
 * 3. Issue Store Credit (storeCreditAccountCredit)
 */
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
      transactionId: `gid://shopify/StoreCreditAccountCreditTransaction/mock_${Date.now()}`,
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
 * 4. Revoke / Deactivate Discount Code (discountCodeDeactivate)
 */
export async function deactivateDiscountCode(discountId) {
  const normDiscountId = normalizeShopifyId(discountId, 'DiscountCodeNode')
  const { isConfigured } = getShopifyConfig()
  if (!isConfigured || !normDiscountId) {
    return { success: true, isMock: true, status: 'DEACTIVATED' }
  }

  const mutation = `
    mutation DiscountCodeDeactivate($id: ID!) {
      discountCodeDeactivate(id: $id) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
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

  const res = await shopifyGraphQL(mutation, { id: normDiscountId })
  const userErrors = res.data?.discountCodeDeactivate?.userErrors || []
  if (userErrors.length > 0) {
    const errText = userErrors.map((e) => e.message).join(', ')
    throw new Error(`Shopify discount deactivation failed: ${errText}`)
  }

  return { success: true, status: 'DEACTIVATED' }
}

/**
 * 5. Reactivate Discount Code (discountCodeActivate)
 */
export async function activateDiscountCode(discountId) {
  const normDiscountId = normalizeShopifyId(discountId, 'DiscountCodeNode')
  const { isConfigured } = getShopifyConfig()
  if (!isConfigured || !normDiscountId) {
    return { success: true, isMock: true, status: 'ACTIVE' }
  }

  const mutation = `
    mutation DiscountCodeActivate($id: ID!) {
      discountCodeActivate(id: $id) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
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

  const res = await shopifyGraphQL(mutation, { id: normDiscountId })
  const userErrors = res.data?.discountCodeActivate?.userErrors || []
  if (userErrors.length > 0) {
    const errText = userErrors.map((e) => e.message).join(', ')
    throw new Error(`Shopify discount activation failed: ${errText}`)
  }

  return { success: true, status: 'ACTIVE' }
}
