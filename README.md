# tax-agent

AI tax form agent on Cloudflare Workers. Validates 1099-NEC data with Workers AI, files with the IRS via TaxBandits.

**Origin:** [Ben (@nurodev)](https://github.com/nurodev) asked _"But can it finally do my taxes for me?"_ — [@grok](https://x.com/grok) [drafted a spec](https://x.com/nurodev) — this repo makes it real.

```
You ─POST─▶ Worker ─validate─▶ Workers AI (Llama 3.3 70B)
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
npm run deploy
```

## Validate a 1099-NEC

```bash
curl -s http://localhost:8787/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "payer": {
      "name": "Acme Corp",
      "tin": "27-1234567",
      "address": "100 Main St",
      "city": "New York",
      "state": "NY",
      "zip_code": "10001",
      "phone": "2125551234",
      "email": "payroll@acme.com"
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

Validation runs in two passes: structural checks (TIN format, state codes, amounts) then Workers AI semantic review (withholding ratios, red flags, consistency).

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

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | API overview |
| `GET` | `/health` | Workers AI + TaxBandits OAuth status |
| `POST` | `/validate` | Validate 1099-NEC (AI only, nothing sent to TaxBandits) |
| `POST` | `/file` | Validate → create 1099-NEC in TaxBandits |
| `POST` | `/transmit/:submissionId` | Transmit to IRS |
| `GET` | `/status/:submissionId` | Poll filing status |

All responses: `{ success: boolean, data?, error?, details? }`

Amounts are in **dollars** (e.g., `5000.00`).

## Project structure

```
src/
├── index.ts        # Hono routes, middleware, error handling
├── agent.ts        # Structural + AI validation pipeline
├── taxbandits.ts   # TaxBandits API client (JWS auth, CRUD)
└── types.ts        # All TypeScript types
```

Four files. Built on [Cloudflare Workers](https://developers.cloudflare.com/workers/) + [Workers AI](https://developers.cloudflare.com/workers-ai/) + [Hono](https://hono.dev) + [TaxBandits](https://developer.taxbandits.com).

## Why TaxBandits

TaxBandits is the only tax API with self-serve sandbox signup, a real IRS e-file pipeline, and support for 1099-NEC/MISC/K, W-2, W-9, and 20+ other forms. Column Tax handles personal 1040s but requires a sales call. Intuit has no TurboTax API. TaxBandits gave us working credentials in 2 minutes.

## Credits

- **[Ben (@nurodev)](https://github.com/nurodev)** — sparked the idea
- **[@grok](https://x.com/grok)** — drafted the first spec
- **[Jordan (@acoyfellow)](https://github.com/acoyfellow)** — implementation

## License

MIT
