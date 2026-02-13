# tax-agent — Worker Handoff (updated 2026-02-13 12:30 UTC)

## What this is

AI tax form agent on Cloudflare Workers. Validates 1099-NEC data with Workers AI (Llama 3.3 70B), files with the IRS via TaxBandits API.

- **Live:** https://tax-agent.coey.dev
- **Repo:** https://github.com/acoyfellow/tax-agent
- **Version:** 2.0.0

## Origin

Ben (@nurodev) asked "can it do my taxes?" on X. Grok drafted a spec. We built it.

## Architecture

```
Client → Hono router (Bearer auth) → Zod validation
  → Structural checks (agent.ts)
  → Workers AI semantic review (Llama 3.3 70B)
  → TaxBandits API (JWS→JWT auth, cached tokens)
  → IRS e-file (sandbox)
```

## Files

```
src/
├── index.ts        # Hono router, Zod schemas, auth middleware, routes
├── index.test.ts   # 28 integration tests
├── agent.ts        # Structural + AI validation pipeline
├── taxbandits.ts   # TaxBandits API client (JWS auth, CRUD, token cache)
└── types.ts        # All TypeScript types
```

Config: `wrangler.jsonc` | Gates: `lefthook.yml` | CI: `.github/workflows/deploy.yml`

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | / | No | API overview |
| GET | /health | No | Status checks |
| POST | /validate | Bearer | Validate 1099-NEC (AI only) |
| POST | /file | Bearer | Validate → create in TaxBandits |
| POST | /transmit/:id | Bearer | Transmit to IRS |
| GET | /status/:id | Bearer | Poll filing status |

## Build / Test / Deploy

```bash
npx tsc --noEmit                        # typecheck
npx prettier --check 'src/**/*.ts'      # lint
npx lefthook run pre-push --force       # all gates

source /home/exedev/myfilepath-new/.env
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy

API_KEY=$(cat /tmp/tax-agent-api-key.txt)
curl -s https://tax-agent.coey.dev/health | jq .
curl -s https://tax-agent.coey.dev/validate \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"payer":{"name":"Acme Corp","tin":"27-1234567","address":"100 Main St","city":"New York","state":"NY","zip_code":"10001","phone":"2125551234","email":"payroll@acme.com","business_type":"LLC"},"recipient":{"first_name":"Jane","last_name":"Smith","tin":"412789654","tin_type":"SSN","address":"200 Oak Ave","city":"Austin","state":"TX","zip_code":"78701"},"nonemployee_compensation":5000.00,"is_federal_tax_withheld":false,"is_state_filing":false,"tax_year":"2024"}' | jq .
```

## What's DONE

### Criticals (all 6 fixed)
1. ✅ Bearer auth on mutating routes (TAX_AGENT_API_KEY)
2. ✅ PII masked in AI prompts (last 4 only)
3. ✅ Zod runtime validation + 64KB body limit
4. ✅ OAuth token cached with TTL
5. ✅ TaxBandits business errors checked
6. ✅ AI failure = fail closed

### HIGHs (all 7 fixed)
7. ✅ BusinessType configurable (default LLC)
8. ✅ state_income/state_tax_withheld wired through
9. ✅ KindOfEmployer/KindOfPayer configurable, SequenceId randomized
10. ✅ Auth returns proper 401 JSON
11. ✅ 28 integration tests
12. ✅ .dev.vars.example + CONTRIBUTING.md
13. ✅ Version aligned to 2.0.0

## DONE — MEDIUM priority (all 8 complete)

### M1: AI prompt injection mitigation ✔️
In agent.ts `buildValidationPrompt()`: user-controlled fields (payer.name, recipient names, addresses) are interpolated directly into the AI prompt. A malicious payer name could inject instructions.
**Fix:** Truncate all string inputs to reasonable lengths (name: 100 chars, address: 200 chars) before interpolation. Wrap user data in clear delimiters like `<DATA>...</DATA>` so the model can distinguish instructions from data.

### M2: ✅ toLocaleString() locale-dependent
In agent.ts prompt builder: `data.nonemployee_compensation.toLocaleString()` — output format depends on V8 locale. On some runtimes `5000` becomes `5.000` (European) instead of `5,000`.
**Fix:** Replace all `.toLocaleString()` calls in prompt builder with `.toFixed(2)` or explicit `toLocaleString('en-US')`.

### M3: ✅ Payer TIN assumed to always be EIN
In types.ts: PayerInfo has `tin` but no `tin_type`. In taxbandits.ts: `IsEIN: true` is hardcoded. Sole proprietors filing 1099-NECs use SSN not EIN.
**Fix:** Add `tin_type: 'EIN' | 'SSN'` to PayerInfo. Update Zod schema in index.ts. Wire `IsEIN` in taxbandits.ts to `data.payer.tin_type === 'EIN'`. Update TIN format validation in agent.ts to accept SSN format when tin_type is SSN.

### M4: ✅ Document single-recipient limitation
TaxBandits supports batch filing (multiple recipients per submission). Our API only accepts one recipient per request.
**Fix:** Add a "Known limitations" section to README.md listing: single recipient per request, US addresses only, sandbox-only default.

### M5: ✅ Document US-only address limitation
In taxbandits.ts: `IsForeignAddress: false` hardcoded for both payer and recipient.
**Fix:** Document in README. Optionally add `is_foreign_address` boolean to types if you want to support it later.

### M6: ✅ Idempotency key on /file
If a `/file` POST succeeds at TaxBandits but the response is lost (network timeout), retrying creates a duplicate IRS filing.
**Fix:** Accept `Idempotency-Key` header on POST /file. Store in KV with the response. On retry with same key, return cached response. This needs a KV namespace binding in wrangler.jsonc.

### M7: ✅ Float money math
JavaScript: `0.1 + 0.2 = 0.30000000000000004`. `nonemployee_compensation` is a float. `.toFixed(2)` in taxbandits.ts rounds, which could create cent discrepancies.
**Fix:** Either accept amounts as integer cents (breaking change) or as strings matching `/^\d+\.\d{2}$/` and pass through without float conversion. For now, document the limitation.

### M8: ✅ Consider 8B model instead of 70B
The AI does JSON classification — 70B is overkill. `@cf/meta/llama-3.1-8b-instruct-fast` would be 3-5x faster.
**Fix:** Test with 8B model. If validation quality is comparable, switch. Keep 70B as a comment fallback.

## DONE — Grok feedback (all 6 addressed)

1. ✅ **Unit tests** — 42 for agent.ts, 37 for taxbandits.ts, 11 for pii.ts (real crypto, zero mocks)
2. ✅ **Rate limiting** — 20 req/min per IP on POST endpoints (in-memory sliding window)
3. ✅ **PII security** — scrubTINs() masks SSN/EIN in error logs and API responses
4. ✅ **Batch filing** — POST /file/batch, up to 100 recipients per submission
5. ✅ **OpenAPI spec** — GET /openapi.json, full schema for all endpoints
6. ✅ **Prompt injection** — already done in M1 (sanitize, truncate, DATA delimiters)

Total: 118 tests, 11 source files, all passing.

## Commit rules

- `npx tsc --noEmit` MUST pass
- `npx prettier --write 'src/**/*.ts'` before commit
- No explicit `any` types
- Descriptive commit messages prefixed with task ID (e.g., "M1: ...")
- `git push` triggers lefthook pre-push gates automatically
- Push triggers GitHub Action: check → deploy
- Verify after deploy: `curl -s https://tax-agent.coey.dev/health | jq .`

## Key gotchas

- TaxBandits OAuth: header is `Authentication` (NOT `Authorization`), method is `GET` (NOT POST)
- TaxBandits sandbox rejects SSNs starting with 9, 666, 000 and patterns like 123456789
- TaxBandits sandbox rejects tax year 2026 (use 2024 or 2025)
- Workers AI wraps JSON in markdown fences — parser in agent.ts handles this
- Deploy command: `source /home/exedev/myfilepath-new/.env && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy`
- NEVER commit secrets or .dev.vars
- API key for testing: `cat /tmp/tax-agent-api-key.txt`
