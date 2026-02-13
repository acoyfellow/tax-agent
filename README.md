# tax-agent

AI tax filing agent on Cloudflare Workers. Validates data with Workers AI, files returns through Column Tax.

**Origin:** [Ben (@nurodev)](https://github.com/nurodev) asked _"But can it finally do my taxes for me?"_ — [@grok](https://x.com/grok) [drafted a spec](https://x.com/nurodev) — this repo makes it real.

```
You ──POST──▶ Worker ──validate──▶ Workers AI (Llama 3.3 70B)
                │                         │
                │◀── issues / ok ─────────┘
                │
                ├──file──▶ Column Tax API ──▶ IRS e-file
                │               │
                │◀── user_url ──┘  (open in browser to complete filing)
```

## Quick start

```bash
git clone https://github.com/acoyfellow/tax-agent.git
cd tax-agent
npm install
npm run dev          # starts on localhost:8787
```

`/validate` works immediately — it only needs the Workers AI binding.

`/file` requires Column Tax credentials. Email [sales@columntax.com](mailto:sales@columntax.com) for sandbox access, then:

```bash
# either set secrets for deploy:
npx wrangler secret put COLUMN_TAX_CLIENT_ID
npx wrangler secret put COLUMN_TAX_CLIENT_SECRET

# or for local dev, create .dev.vars:
echo 'COLUMN_TAX_CLIENT_ID=xxx' >> .dev.vars
echo 'COLUMN_TAX_CLIENT_SECRET=xxx' >> .dev.vars
```

Deploy: `npm run deploy`

## Validate tax data

```bash
curl -s http://localhost:8787/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "taxpayer": {
      "first_name": "Susan",
      "last_name": "Magnolia",
      "date_of_birth": "1988-02-03",
      "social_security_number": "123124321",
      "occupation": "Detective",
      "phone": "2125551234",
      "email": "susan@example.com"
    },
    "address": {
      "address": "2030 Pecan Street",
      "city": "Las Vegas",
      "state": "NV",
      "zip_code": "89031"
    },
    "w2s": [{
      "employer_name": "Acme Corp",
      "employer_ein": "12-3456789",
      "wages": 7500000,
      "federal_tax_withheld": 1500000
    }]
  }' | jq
```

```json
{
  "success": true,
  "data": {
    "valid": true,
    "issues": [],
    "summary": "All checks passed",
    "ai_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  }
}
```

Validation runs in two passes: structural checks (format, ranges, required fields) then Workers AI semantic review. If structural checks find errors, the AI call is skipped.

## File a return

```bash
curl -s http://localhost:8787/file \
  -H 'Content-Type: application/json' \
  -d '{ ... same body ... }' | jq
```

If validation passes, this calls Column Tax's `initialize_tax_filing` endpoint and returns a `user_url`. Open that URL in a browser — Column Tax's white-label UI handles the rest of the filing flow (IRS-authorized e-file).

If validation fails, you get a `422` with the issues. Fix and retry.

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | API overview |
| `GET` | `/health` | Workers AI binding + credential status |
| `POST` | `/validate` | Validate tax data (AI only, nothing sent to Column Tax) |
| `POST` | `/file` | Validate → initialize Column Tax filing session |
| `GET` | `/status/:userId` | Polling endpoint for filing status |

All responses use `{ success: boolean, data?, error?, details? }`.

Amounts are in **cents** (e.g., `7500000` = $75,000.00).

## Project structure

```
src/
├── index.ts        # Hono routes, middleware, error handling  (210 lines)
├── agent.ts        # Structural + AI validation pipeline      (202 lines)
├── column-tax.ts   # Column Tax API client                    (138 lines)
└── types.ts        # All TypeScript types                     (163 lines)
```

713 lines total. Four files. Strict TypeScript, no `any`.

Built on [Cloudflare Workers](https://developers.cloudflare.com/workers/) + [Workers AI](https://developers.cloudflare.com/workers-ai/) + [Hono](https://hono.dev) + [Column Tax](https://columntax.com/developers).

## Why Column Tax

Column Tax is the only API that computes personal tax liability and e-files 1040s. TaxBandits handles information returns (1099, W-2) but not personal filing. Intuit has no TurboTax API. Column Tax is white-label, IRS-authorized, and requires just one API call — their embedded UI handles the interview, computation, and submission.

The tradeoff: signup is through [sales@columntax.com](mailto:sales@columntax.com), not self-serve.

## Credits

- **[Ben (@nurodev)](https://github.com/nurodev)** — sparked the idea
- **[@grok](https://x.com/grok)** — drafted the first spec
- **[Jordan (@acoyfellow)](https://github.com/acoyfellow)** — implementation

## License

MIT
