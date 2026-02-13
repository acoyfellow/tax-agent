# API Reference

> **Reference** — complete endpoint documentation.

Base URL: `https://tax-agent.coey.dev`

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | No | API overview |
| `GET` | `/health` | No | Workers AI + TaxBandits OAuth status |
| `POST` | `/validate` | `filings:validate` | Validate 1099-NEC (AI only, nothing sent to TaxBandits) |
| `POST` | `/file` | `filings:create` | Validate → create 1099-NEC in TaxBandits |
| `POST` | `/file/batch` | `filings:create` | Validate → create up to 100 1099-NECs |
| `POST` | `/transmit/:submissionId` | `filings:transmit` | Transmit to IRS |
| `GET` | `/status/:submissionId` | `status:read` | Poll filing status |
| `GET` | `/openapi.json` | No | OpenAPI 3.1 specification |
| `POST` | `/webhook/status` | HMAC | TaxBandits webhook callback |
| `GET` | `/webhook/submissions` | `webhooks:read` | List tracked submissions |
| `GET` | `/webhook/submissions/:id` | `webhooks:read` | Get single submission status |
| `*` | `/api/auth/*` | Varies | better-auth handler |
| `POST` | `/api/auth/migrate` | Admin | Run D1 schema migrations |

## Authentication

Two modes, checked in order:

1. **`x-api-key` header** — better-auth scoped API key
2. **`Authorization: Bearer <token>`** — legacy single token

See [How to: Set Up Authentication](./howto-authentication.md).

## Response envelope

All responses follow:

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "message", "details": { ... } }
```

## Rate limiting

POST endpoints: 20 requests/minute per IP via [Cloudflare native rate limit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Request body: 1099-NEC

```json
{
  "payer": {
    "name": "string (required)",
    "tin": "XX-XXXXXXX (EIN) or 9 digits (SSN)",
    "tin_type": "EIN | SSN (default: EIN)",
    "address": "string",
    "city": "string",
    "state": "2-letter code",
    "zip_code": "XXXXX or XXXXX-XXXX",
    "phone": "10-15 digits",
    "email": "valid email",
    "business_type": "CORP | SCORP | PART | TRUST | LLC | EXEMPT | ESTE (default: LLC)"
  },
  "recipient": {
    "first_name": "string",
    "last_name": "string",
    "tin": "9 digits (SSN) or XX-XXXXXXX (EIN)",
    "tin_type": "SSN | EIN",
    "address": "string",
    "city": "string",
    "state": "2-letter code",
    "zip_code": "XXXXX or XXXXX-XXXX"
  },
  "nonemployee_compensation": 5000.00,
  "is_federal_tax_withheld": false,
  "federal_tax_withheld": 0,
  "is_state_filing": false,
  "state": "TX",
  "state_income": 0,
  "state_tax_withheld": 0,
  "tax_year": "2024"
}
```

Amounts are in **dollars** (e.g., `5000.00`). Rounded to 2 decimal places before sending to TaxBandits.

## Idempotency

`POST /file` accepts an `Idempotency-Key` header. Same key within 24 hours returns the cached response.

## Known limitations

- **Batch limit:** 100 recipients per submission, all sharing the same payer
- **US addresses only:** `IsForeignAddress` hardcoded to `false`
- **Sandbox default:** Set `TAXBANDITS_ENV=production` for real filings
- **Floating-point:** `±$0.01` rounding for unusual decimals; send clean values
