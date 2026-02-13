# tax-agent

AI tax form agent on Cloudflare Workers. Validates 1099-NEC data with Workers AI (GLM-4.7-Flash), files with the IRS via TaxBandits.

**Origin:** [Ben (@nurodev)](https://github.com/nurodev) asked _"But can it finally do my taxes for me?"_ — [@grok](https://x.com/grok) [drafted a spec](https://x.com/nurodev) — this repo makes it real.

```
User ─POST─▶ Worker ─validate─▶ Workers AI (GLM-4.7-Flash)
               │                        │
               │◀── issues / ok ────────┘
               │
               ├─create─▶ TaxBandits API ─▶ 1099-NEC created
               ├─transmit─▶ TaxBandits ─▶ Filed with IRS
               └─webhook◀── TaxBandits ─── IRS acknowledgment
```

## Quick start

```bash
git clone https://github.com/acoyfellow/tax-agent.git && cd tax-agent
npm install

# Get TaxBandits sandbox credentials (free): https://sandbox.taxbandits.com
cat > .dev.vars << EOF
TAXBANDITS_CLIENT_ID=your-client-id
TAXBANDITS_CLIENT_SECRET=your-client-secret
TAXBANDITS_USER_TOKEN=your-user-token
TAXBANDITS_ENV=sandbox
EOF

npm run dev   # localhost:8787
```

Validate a 1099-NEC:

```bash
curl -s http://localhost:8787/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "payer": {"name":"Acme Corp","tin":"27-1234567","tin_type":"EIN","address":"100 Main St","city":"New York","state":"NY","zip_code":"10001","phone":"2125551234","email":"payroll@acme.com"},
    "recipient": {"first_name":"Jane","last_name":"Smith","tin":"412789654","tin_type":"SSN","address":"200 Oak Ave","city":"Austin","state":"TX","zip_code":"78701"},
    "nonemployee_compensation": 5000.00,
    "is_federal_tax_withheld": false,
    "is_state_filing": false
  }' | jq
```

## Deploy

```bash
npx wrangler secret put TAXBANDITS_CLIENT_ID
npx wrangler secret put TAXBANDITS_CLIENT_SECRET
npx wrangler secret put TAXBANDITS_USER_TOKEN
npx wrangler secret put TAX_AGENT_API_KEY        # Legacy Bearer auth (optional)
npx wrangler secret put BETTER_AUTH_SECRET       # better-auth signing secret (32+ chars)
npm run deploy

# Run D1 migrations (once)
curl -X POST https://tax-agent.coey.dev/api/auth/migrate \
  -H 'Authorization: Bearer YOUR_ADMIN_KEY'
```

## Documentation

| | |
|---|---|
| 🏫 **[Tutorial: First Filing](docs/tutorial-first-filing.md)** | Step-by-step from zero to IRS submission |
| 🛠️ **[How to: Authentication](docs/howto-authentication.md)** | Set up better-auth API keys or legacy Bearer |
| 🛠️ **[How to: Webhooks](docs/howto-webhooks.md)** | Receive IRS status callbacks |
| 🛠️ **[How to: QuickBooks](docs/howto-quickbooks.md)** | Connect QB, auto-generate 1099s |
| 📖 **[API Reference](docs/reference-api.md)** | Complete endpoint docs, request/response schemas |
| 📐 **[Architecture](docs/explanation-architecture.md)** | Effect pipeline, bindings, auth flow, why TaxBandits |
| 🛡️ **[Security](docs/explanation-security.md)** | Prompt injection defenses, PII masking |
| 🏗️ **[Competitive Landscape](docs/competitive-landscape.md)** | Feature matrix vs TaxBandits, Abound, Tax1099, etc. |
| 📝 **[Changelog](CHANGELOG.md)** | Release history |

## API overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | No | API overview |
| `GET` | `/health` | No | Service health check |
| `POST` | `/validate` | 🔑 `filings:validate` | AI + structural validation |
| `POST` | `/file` | 🔑 `filings:create` | Validate → create in TaxBandits |
| `POST` | `/file/batch` | 🔑 `filings:create` | Batch create (up to 100) |
| `POST` | `/transmit/:id` | 🔑 `filings:transmit` | Transmit to IRS |
| `GET` | `/status/:id` | 🔑 `status:read` | Poll filing status |
| `GET` | `/openapi.json` | No | OpenAPI 3.1 spec |
| `POST` | `/webhook/status` | HMAC | TaxBandits callback |
| `GET` | `/webhook/submissions` | 🔑 `webhooks:read` | List submissions |
| `POST` | `/api/auth/admin/create-key` | Bearer (admin) | Create API key with custom permissions |
| `GET` | `/quickbooks/vendors` | 🔑 `filings:validate` | List 1099 vendors from QB |
| `POST` | `/quickbooks/generate` | 🔑 `filings:create` | Generate 1099s from QB data |
| `*` | `/api/auth/*` | Varies | Auth handler (signup, keys) |

Auth: `x-api-key` header (better-auth) or `Authorization: Bearer` (legacy). [Details →](docs/howto-authentication.md)

## Project structure

```
src/
├── index.ts              # Hono router, middleware, Effect.runPromise boundary
├── auth.ts               # better-auth + D1, API key verification, permissions
├── agent.ts              # Structural + AI validation (Effect)
├── taxbandits.ts         # TaxBandits API client (Effect, typed errors, auto-retry)
├── webhook.ts            # Webhook HMAC verification
├── webhook-state.ts      # Durable Object — SQLite for submission tracking
├── audit.ts              # Analytics Engine audit logging
├── pii.ts                # TIN masking
├── ratelimit.ts          # CF native rate limit
├── openapi.ts            # OpenAPI 3.1 spec
└── types.ts              # Types + Effect error classes
docs/                     # Diátaxis-structured documentation
```

**181 tests** · 4,253 LOC · strict TypeScript · zero `any` · 160KB gzipped

Built on [Cloudflare Workers](https://developers.cloudflare.com/workers/) + [Workers AI](https://developers.cloudflare.com/workers-ai/) + [Hono](https://hono.dev) + [Effect](https://effect.website) + [better-auth](https://better-auth.com) + [TaxBandits](https://developer.taxbandits.com)

## Credits

- **[Ben (@nurodev)](https://github.com/nurodev)** — sparked the idea
- **[@grok](https://x.com/grok)** — drafted the first spec
- **[Jordan (@acoyfellow)](https://github.com/acoyfellow)** — implementation

## License

MIT
