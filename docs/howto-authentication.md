# How to: Set Up Authentication

> **Goal:** Secure your tax-agent deployment with API keys.

tax-agent supports two auth modes that run simultaneously.

## Option A: better-auth API keys (recommended)

Scoped, per-user keys stored in Cloudflare D1. Supports permissions, expiration, and rate limiting per key.

### 1. Configure secrets

```bash
# Generate a 32+ character secret
openssl rand -base64 32

npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put BETTER_AUTH_URL
# Enter: https://your-domain.com
```

### 2. Deploy and run migrations

```bash
npm run deploy

curl -X POST https://your-domain.com/api/auth/migrate \
  -H 'Authorization: Bearer YOUR_ADMIN_KEY'
```

### 3. Create an account

```bash
curl -X POST https://your-domain.com/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@company.com","password":"SecurePass123!","name":"Your Name"}'
```

### 4. Create an API key

**Self-service** (gets default permissions: `filings:validate`, `status:read`, `webhooks:read`):

```bash
# Sign in first to get a session cookie
curl -c cookies.txt -X POST https://your-domain.com/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@company.com","password":"SecurePass123!"}'

# Create key (uses default permissions)
curl -b cookies.txt -X POST https://your-domain.com/api/auth/api-key/create \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://your-domain.com' \
  -d '{"name": "my-key"}'
```

**Admin** (custom permissions via `TAX_AGENT_API_KEY`):

```bash
curl -X POST https://your-domain.com/api/auth/admin/create-key \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ADMIN_KEY' \
  -d '{
    "userId": "USER_ID_FROM_SIGNUP",
    "name": "production-key",
    "permissions": {
      "filings": ["validate", "create", "transmit"],
      "status": ["read"],
      "webhooks": ["read"]
    }
  }'
```

### 5. Use the key

```bash
curl https://your-domain.com/validate \
  -H 'x-api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{...}'
```

### Permissions reference

| Scope      | Actions                          | Routes                             |
|------------|----------------------------------|------------------------------------|
| `filings`  | `validate`, `create`, `transmit` | `/validate`, `/file*`, `/transmit/*` |
| `status`   | `read`                           | `/status/*`                        |
| `webhooks` | `read`                           | `/webhook/submissions*`            |

A key with `filings: ["validate"]` can only call `/validate` — it cannot file or transmit.

## Option B: Legacy Bearer token

Simple shared secret. All protected routes accept `Authorization: Bearer <token>`.

```bash
npx wrangler secret put TAX_AGENT_API_KEY
# Enter any strong token
```

Then:

```bash
curl https://your-domain.com/validate \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{...}'
```

## Dev mode

If neither `BETTER_AUTH_SECRET` + `AUTH_DB` nor `TAX_AGENT_API_KEY` is configured, all routes are open. This is intentional for local development.
