# Kawaii Slime Company — Employee Discount & Store Credit Portal

Production-ready web application for **Kawaii Slime Company** to manage and automate employee discounts and monthly store credits, integrating **Shopify Admin GraphQL API**, **Slack Web API & Events**, **Supabase PostgreSQL**, and **Vercel Serverless Functions**.

---

## 🌸 Key Capabilities

1. **Slack Email -> 4-Digit DM Code Authentication**
   - Clean, branded KSC login experience.
   - Looks up employee by email in Slack via `users.lookupByEmail`.
   - Generates a random 4-digit code (`1000`–`9999`) and stores an HMAC-SHA256 hash in Supabase (`public.discount_login_codes`) with 10-minute expiry.
   - Dispatches the code directly to their Slack DM (`conversations.open` + `chat.postMessage`).
   - Issues a cryptographically signed HMAC-SHA256 session token (`FINANCE_SESSION_SECRET`).

2. **Configurable Settings Bar**
   - Saved in Supabase `public.discount_settings`.
   - **Employee Discount (%)**: e.g., `20%`.
   - **Monthly Store Credit ($)**: e.g., `$25.00`.
   - Real-time updates with instantaneous propagation to onboarding & credit distributions.

3. **Shopify Admin GraphQL Integration (`lib/shopify.js`)**
   - **Find or Create Customer** by work email (`customers` query + `customerCreate` mutation).
   - **Email-Locked Unique Discount Codes (`discountCodeBasicCreate`)**:
     - Generates unique codes: `KSC-<FIRSTNAME>-<4CHARS>`.
     - Strictly sets `customerSelection: { customers: { add: [shopifyCustomerId] } }` so the code is **locked to that employee's email at checkout** and cannot be used by anyone else.
   - **Issue Store Credit (`storeCreditAccountCredit`)**:
     - Credits employee's store credit account directly in Shopify.
   - **Revoke / Reactivate**:
     - Deactivates (`discountCodeDeactivate`) or re-enables (`discountCodeActivate`) the discount code in Shopify when an employee's status changes.

4. **Auto-Onboarding on Slack Join (`POST /api/slack/events`)**
   - Slack Events API handler with `url_verification` challenge & HMAC signature verification.
   - Listens for `team_join` event when a new hire joins Slack:
     - Extracts their real name and work email.
     - Automatically creates their Shopify Customer account.
     - Generates their email-locked unique discount code.
     - Issues their initial welcome store credit.
     - Saves records to Supabase `public.employee_discounts` and `public.store_credit_logs`.
     - Sends a welcoming Slack DM detailing their code, store credit, and instructions for **local warehouse pickup** vs **home shipping**.

5. **Automated Monthly Store Credit Run**
   - Vercel Cron-ready endpoint (`POST /api/discounts?route=monthly-credit`) scheduled for the 1st of every month.
   - Credits all active employees in Shopify and delivers notification Slack DMs.

---

## 🛠️ Tech Stack

- **Frontend**: Vite 5, React 18, Plain JavaScript (`.js` / `.jsx`), KSC Custom CSS Variables & Themes
- **Backend**: Vercel Serverless Functions (`api/**/*.js`), Node.js `node:crypto`
- **Database**: Supabase PostgreSQL with Row Level Security (RLS)
- **Integrations**: Shopify Admin GraphQL API, Slack Web & Events API

---

## 🚀 Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase Project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key |
| `VITE_SUPABASE_URL` | Supabase Public URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase Anonymous Key |
| `FINANCE_SESSION_SECRET` | Secret key for session encryption & login code hashing |
| `SLACK_BOT_TOKEN` | Slack Bot Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack Signing Secret for request verification |
| `SHOPIFY_STORE_DOMAIN` | Shopify Store Domain (`kawaii-slime-company.myshopify.com`) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Shopify Admin API Access Token (`shpat_...`) |
| `SHOPIFY_API_VERSION` | Shopify API Version (`2025-01`) |
| `CRON_SECRET` | Secret token authorizing monthly store credit cron calls |

---

## 🧪 Testing

```bash
# Run automated tests
npm test

# Build production bundle
npm run build
```
