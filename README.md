# tax-agent

AI-powered tax filing agent on Cloudflare Workers. Validates your data with Workers AI, files your return via [Column Tax](https://columntax.com).

## Origin

This started as a [conversation on X](https://x.com/whoiskatrin) about AI agents and tax filing. [Ben (@nurodev)](https://github.com/nurodev) asked the question — _"But can it finally do my taxes for me?"_ — and [@grok](https://x.com/grok) drafted the first spec. This repo is that spec made real, built on current Cloudflare patterns.

## How it works

```
┌─────────┐     ┌───────────────────┐     ┌───────────────┐     ┌───────────┐
│  Client  │────▶│  Cloudflare Worker │────▶│  Workers AI   │────▶│ Column Tax│
│  (you)   │◀────│  (Hono router)     │◀────│  (Llama 3.3)  │◀────│   API     │
└─────────┘     └───────────────────┘     └───────────────┘     └───────────┘
```

1. **You POST tax data** (income, deductions, personal info)
2. **Workers AI validates it** — structural checks first, then Llama 3.3 70B reviews for errors and inconsistencies
3. **If valid, Column Tax takes over** — initializes a filing session, returns a URL to their white-label tax prep UI
4. **User completes filing** in Column Tax's embedded experience (IRS-authorized e-file)

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | API overview |
| `GET` | `/health` | Service health (AI binding, credentials) |
| `POST` | `/validate` | Validate tax data with AI (does not file) |
| `POST` | `/file` | Validate + initialize Column Tax filing |
| `GET` | `/status/:userId` | Check filing status |

## Quick start

```bash
git clone https://github.com/acoyfellow/tax-agent.git
cd tax-agent
npm install
```

### Configure secrets

Column Tax credentials (get from [sales@columntax.com](mailto:sales@columntax.com)):

```bash
npx wrangler secret put COLUMN_TAX_CLIENT_ID
npx wrangler secret put COLUMN_TAX_CLIENT_SECRET
```

Or for local dev, edit `.dev.vars`:

```
COLUMN_TAX_CLIENT_ID=your-sandbox-client-id
COLUMN_TAX_CLIENT_SECRET=your-sandbox-client-secret
```

### Run locally

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

## Example: validate tax data

```bash
curl -X POST http://localhost:8787/validate \
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
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "valid": true,
    "issues": [],
    "summary": "All checks passed — data is ready for filing",
    "ai_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  }
}
```

## Example: file taxes

```bash
curl -X POST http://localhost:8787/file \
  -H 'Content-Type: application/json' \
  -d '{ ... same body as above ... }'
```

Response includes a `user_url` — open it in a browser to complete filing in Column Tax's UI.

## Project structure

```
src/
├── index.ts        # Hono app — routes, middleware, error handling
├── agent.ts        # AI validation (structural checks + Workers AI)
├── column-tax.ts   # Column Tax API integration
└── types.ts        # All TypeScript types
```

Four files. Read them top to bottom in ~5 minutes.

## Stack

- **[Cloudflare Workers](https://developers.cloudflare.com/workers/)** — runtime
- **[Workers AI](https://developers.cloudflare.com/workers-ai/)** — Llama 3.3 70B for validation
- **[Hono](https://hono.dev)** — lightweight router
- **[Column Tax](https://columntax.com/developers)** — IRS-authorized tax filing API
- **TypeScript** — strict mode, no `any`

## Column Tax setup

Column Tax is the only API that actually computes personal tax liability and e-files 1040s. It's a white-label embedded experience — your backend calls one endpoint, their UI handles the rest.

To get sandbox credentials:
1. Email [sales@columntax.com](mailto:sales@columntax.com)
2. They send you a `client_id` and `client_secret` for sandbox
3. Set them as Wrangler secrets (see above)
4. The `/file` endpoint will work end-to-end

Without credentials, `/validate` still works — it only uses Workers AI.

## Credits

- **[Ben (@nurodev)](https://github.com/nurodev)** — asked the question that started this: _"But can it finally do my taxes for me?"_
- **[@grok](https://x.com/grok)** — drafted the first hypothetical spec using Workers AI SDK
- **[Jordan (@acoyfellow)](https://github.com/acoyfellow)** — built the working implementation

## License

MIT
