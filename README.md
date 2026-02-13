# tax-agent

AI tax form agent on Cloudflare Workers. Validates 1099-NEC data with Workers AI (Llama 3.1 8B), files with the IRS via TaxBandits.

**Origin:** [Ben (@nurodev)](https://github.com/nurodev) asked _"But can it finally do my taxes for me?"_ — [@grok](https://x.com/grok) [drafted a spec](https://x.com/nurodev) — this repo makes it real.

```
You ─POST─▶ Worker ─validate─▶ Workers AI (Llama 3.1 8B)
               │                        │
               │◀── issues / ok ────────┘
               │
               ├─create─▶ TaxBandits API ─▶ 1099-NEC created
               ├─transmit─▶ TaxBandits ─▶ Filed with IRS
               └─status─▶ TaxBandits ─▶ TRANSMITTED / ACCEPTED
```

## Quick start

```bash
git clone https://github.com/acoyfellow/tax-agent.git
cd tax-agent
npm install
```

Get TaxBandits sandbox credentials (free, self-serve): https://sandbox.taxbandits.com

```bash
# Local dev — create .dev.vars:
cat > .dev.vars << EOF
TAXBANDITS_CLIENT_ID=your-client-id
TAXBANDITS_CLIENT_SECRET=your-client-secret
TAXBANDITS_USER_TOKEN=your-user-token
TAXBANDITS_ENV=sandbox
EOF

npm run dev          # starts on localhost:8787
```

Deploy:

```bash
npx wrangler secret put TAXBANDITS_CLIENT_ID
npx wrangler secret put TAXBANDITS_CLIENT_SECRET
npx wrangler secret put TAXBANDITS_USER_TOKEN
npx wrangler secret put TAX_AGENT_API_KEY   # Bearer token for API auth
npm run deploy
```

## Validate a 1099-NEC

```bash
curl -s http://localhost:8787/validate \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "payer": {
      "name": "Acme Corp",
      "tin": "27-1234567",
      "tin_type": "EIN",
      "address": "100 Main St",
      "city": "New York",
      "state": "NY",
      "zip_code": "10001",
      "phone": "2125551234",
      "email": "payroll@acme.com",
      "business_type": "LLC"
    },
    "recipient": {
      "first_name": "Jane",
      "last_name": "Smith",
      "tin": "412789654",
      "tin_type": "SSN",
      "address": "200 Oak Ave",
      "city": "Austin",
      "state": "TX",
      "zip_code": "78701"
    },
    "nonemployee_compensation": 5000.00,
    "is_federal_tax_withheld": false,
    "is_state_filing": false,
    "tax_year": "2024"
  }' | jq
```

All request bodies are validated with [Zod](https://zod.dev) (64KB limit). Validation then runs in two passes: structural checks (TIN format, state codes, amounts) then Workers AI semantic review (withholding ratios, red flags, consistency). PII is masked before being sent to the AI (TINs show last 4 only).

## File with the IRS

```bash
# Step 1: Create the form
curl -s http://localhost:8787/file -H 'Content-Type: application/json' \
  -d '{ ... same body ... }' | jq
# Returns SubmissionId

# Step 2: Transmit to IRS
curl -s -X POST http://localhost:8787/transmit/SUBMISSION_ID | jq

# Step 3: Check status
curl -s http://localhost:8787/status/SUBMISSION_ID | jq
```

The three-step flow (create → transmit → poll status) mirrors TaxBandits' own lifecycle. The form stays in `CREATED` until you explicitly transmit.

**Idempotency:** `POST /file` accepts an `Idempotency-Key` header. If the same key is sent again within 24 hours, the cached response is returned instead of creating a duplicate filing.

## API reference

| Method | Path                      | Auth   | Description                                             |
| ------ | ------------------------- | ------ | ------------------------------------------------------- |
| `GET`  | `/`                       | No     | API overview                                            |
| `GET`  | `/health`                 | No     | Workers AI + TaxBandits OAuth status                    |
| `POST` | `/validate`               | Bearer | Validate 1099-NEC (AI only, nothing sent to TaxBandits) |
| `POST` | `/file`                   | Bearer | Validate → create 1099-NEC in TaxBandits                |
| `POST` | `/file/batch`             | Bearer | Validate → create up to 100 1099-NECs in one submission |
| `POST` | `/transmit/:submissionId` | Bearer | Transmit to IRS                                         |
| `GET`  | `/status/:submissionId`   | Bearer | Poll filing status                                      |
| `GET`  | `/openapi.json`           | No     | OpenAPI 3.1 specification                               |

All responses: `{ success: boolean, data?, error?, details? }`

Amounts are in **dollars** (e.g., `5000.00`). POST endpoints are rate-limited to 20 requests/minute per IP.

## Project structure

```
src/
├── index.ts           # Hono routes, Zod schemas, auth middleware
├── index.test.ts      # 28 integration tests
├── agent.ts           # Structural + AI validation pipeline
├── agent.test.ts      # 42 unit tests (pure functions)
├── taxbandits.ts      # TaxBandits API client (JWS auth, token cache)
├── taxbandits.test.ts # 37 unit tests (crypto, request building)
├── pii.ts             # TIN masking and scrubbing
├── pii.test.ts        # 11 PII tests
├── ratelimit.ts       # Per-IP rate limiter (20 req/min on POST)
├── openapi.ts         # OpenAPI 3.1 spec
└── types.ts           # All TypeScript types
```

Built on [Cloudflare Workers](https://developers.cloudflare.com/workers/) + [Workers AI](https://developers.cloudflare.com/workers-ai/) + [Hono](https://hono.dev) + [TaxBandits](https://developer.taxbandits.com).

## Why TaxBandits

TaxBandits is the only tax API with self-serve sandbox signup, a real IRS e-file pipeline, and support for 1099-NEC/MISC/K, W-2, W-9, and 20+ other forms. Column Tax handles personal 1040s but requires a sales call. Intuit has no TurboTax API. TaxBandits gave us working credentials in 2 minutes.

## Known limitations

- **Batch filing limit:** `POST /file/batch` accepts up to 100 recipients per submission. All recipients must share the same payer.
- **US addresses only:** Both payer and recipient addresses are assumed to be US domestic. `IsForeignAddress` is hardcoded to `false`. Foreign addresses are not supported.
- **Sandbox by default:** The TaxBandits integration defaults to sandbox mode (`TAXBANDITS_ENV=sandbox`). Set `TAXBANDITS_ENV=production` with valid production credentials for real IRS filings.
- **Floating-point money:** Amounts are JavaScript `number` (IEEE 754 doubles). Values are rounded to 2 decimal places with `.toFixed(2)` before sending to TaxBandits, which can cause ±$0.01 discrepancies for unusual inputs. For cent-perfect accuracy, send amounts that are already clean decimals (e.g., `5000.00`, not `5000.004`).

## Credits

- **[Ben (@nurodev)](https://github.com/nurodev)** — sparked the idea
- **[@grok](https://x.com/grok)** — drafted the first spec
- **[Jordan (@acoyfellow)](https://github.com/acoyfellow)** — implementation

## License

MIT
