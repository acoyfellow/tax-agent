# tax-agent — Worker Handoff

## What this is

AI tax form agent on Cloudflare Workers. Validates 1099-NEC data with Workers AI (Llama 3.3 70B), files with the IRS via TaxBandits API. Live at https://tax-agent.coey.dev. Repo: https://github.com/acoyfellow/tax-agent

## Origin

Ben (@nurodev) asked "can it do my taxes?" on X. Grok drafted a spec. We built it for real.

## Architecture

```
Client → POST /validate or /file
  → Zod schema validation (runtime)
  → Structural checks (format, ranges)
  → Workers AI semantic review (Llama 3.3 70B)
  → TaxBandits API (create 1099-NEC → transmit to IRS → poll status)
```

## Files (4 source files, ~800 lines total)

```
src/
├── index.ts        # Hono router, Zod schemas, auth middleware, routes
├── agent.ts        # Structural + AI validation pipeline
├── taxbandits.ts   # TaxBandits API client (JWS→JWT auth, CRUD, token cache)
└── types.ts        # All TypeScript types (Env, Form1099NECRequest, TaxBandits API types)
```

Config: `wrangler.jsonc` (account_id, AI binding, vars)
Gates: `lefthook.yml` (pre-push: tsc, prettier, no-any grep)
CI: `.github/workflows/deploy.yml` (check job → deploy job)

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | / | No | API overview |
| GET | /health | No | AI + TaxBandits + auth status |
| POST | /validate | Bearer | Validate 1099-NEC (AI only) |
| POST | /file | Bearer | Validate → create in TaxBandits |
| POST | /transmit/:id | Bearer | Transmit submission to IRS |
| GET | /status/:id | Bearer | Poll filing status |

## Secrets (all configured)

- `TAXBANDITS_CLIENT_ID` — bb192f2700ca5b43
- `TAXBANDITS_CLIENT_SECRET` — in wrangler secrets
- `TAXBANDITS_USER_TOKEN` — in wrangler secrets  
- `TAX_AGENT_API_KEY` — Bearer auth token for mutating routes
- `CLOUDFLARE_API_TOKEN` — GitHub repo secret for CI deploy

## Build / Test / Deploy

```bash
npx tsc --noEmit          # typecheck
npx prettier --check 'src/**/*.ts'  # lint
npx lefthook run pre-push --force   # all gates

# Deploy (uses wrangler.jsonc)
source /home/exedev/myfilepath-new/.env
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy

# Test
API_KEY=$(cat /tmp/tax-agent-api-key.txt)
curl -s https://tax-agent.coey.dev/health | jq .
curl -s https://tax-agent.coey.dev/validate \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"payer":{"name":"Acme Corp","tin":"27-1234567","address":"100 Main St","city":"New York","state":"NY","zip_code":"10001","phone":"2125551234","email":"payroll@acme.com"},"recipient":{"first_name":"Jane","last_name":"Smith","tin":"412789654","tin_type":"SSN","address":"200 Oak Ave","city":"Austin","state":"TX","zip_code":"78701"},"nonemployee_compensation":5000.00,"is_federal_tax_withheld":false,"is_state_filing":false,"tax_year":"2024"}' | jq .
```

## What's DONE (criticals fixed)

1. ✅ Bearer auth on mutating routes (TAX_AGENT_API_KEY)
2. ✅ PII masked in AI prompts (EIN/TIN → last 4 only)
3. ✅ Zod runtime validation on all POST bodies + UUID check on submissionId
4. ✅ OAuth token cached in module scope with TTL
5. ✅ TaxBandits business-level errors checked (StatusCode in response body)
6. ✅ AI failure = fail closed (valid: false)
7. ✅ validStates hoisted to module scope + US territories added
8. ✅ .replace('-','') → .replace(/-/g,'') everywhere
9. ✅ Single API_VERSION constant for TaxBandits URLs
10. ✅ Body size limit (64KB)

## TODO — HIGH priority (do these next, in order)

### H1: Hardcoded BusinessType: 'ESTE'
Every payer filed as Estate. Add `business_type` field to `PayerInfo` in types.ts. Valid values: CORP, SCORP, PART, TRUST, LLC, EXEMPT, ESTE. Default to 'LLC'. Wire through `buildCreateRequest` in taxbandits.ts.

### H2: state_income / state_tax_withheld silently dropped
types.ts accepts them, taxbandits.ts `buildCreateRequest` never maps them. Wire into the TaxBandits payload under `NECFormData` state fields. Also in agent.ts structural validation: if is_state_filing=true, validate state_income is present.

### H3: Hardcoded KindOfEmployer/KindOfPayer/SequenceId
In taxbandits.ts `buildCreateRequest`: KindOfEmployer='NONEAPPLY', KindOfPayer='REGULAR941', SequenceId='seq-001'. These should either be configurable or at least documented as defaults with correct values.

### H4: Auth returns "Internal server error" instead of 401
Hono's bearerAuth throws, and our onError handler catches it as a generic 500. Fix: add proper 401 response. Check if bearerAuth middleware can be configured to return JSON, or catch the specific error.

### H5: Write tests
Vitest is configured (`vitest.config.ts`, `@cloudflare/vitest-pool-workers`). Zero test files exist. Write `src/index.test.ts` covering:
- Zod validation (good input, bad input, edge cases)
- Structural validation in agent.ts
- Auth middleware (with/without key)
- Route handlers (mock AI + TaxBandits)

### H6: .dev.vars.example + CONTRIBUTING.md
Create `.dev.vars.example` with placeholder values. Create `CONTRIBUTING.md` explaining: prerequisites, setup, quality gates, testing, deploy.

### H7: Version mismatch
package.json says 2.0.0 in description area but version field is 1.0.0. index.ts GET / says 2.0.0. Align to 2.0.0 everywhere.

## TODO — MEDIUM priority

### M1: AI prompt injection
User-controlled fields interpolated directly into prompt. Truncate all string inputs to reasonable lengths before prompt building. Add delimiter markers.

### M2: toLocaleString() locale-dependent in prompt
Replace with .toFixed(2) in agent.ts prompt builder.

### M3: Payer TIN assumed to always be EIN
Sole proprietors use SSN. Add `payer_tin_type: 'EIN' | 'SSN'` to PayerInfo. Wire into taxbandits.ts IsEIN field.

### M4: Only single-recipient filings supported
TaxBandits supports batch. Document as known limitation in README.

### M5: Only US addresses
taxbandits.ts hardcodes IsForeignAddress: false. Document as limitation.

### M6: No idempotency key on /file
Network retry = duplicate IRS filing. Accept Idempotency-Key header, pass through or deduplicate.

### M7: Float money math
0.1 + 0.2 = 0.30000000000000004. Consider accepting cents (integers) or string amounts.

### M8: Consider 8B model instead of 70B
For JSON classification, 8B is likely sufficient and 3-5x faster. Test @cf/meta/llama-3.1-8b-instruct-fast.

## Key gotchas for the worker

- TaxBandits OAuth uses header `Authentication` (NOT `Authorization`) and method `GET` (NOT POST)
- TaxBandits sandbox rejects test SSNs starting with 9, 666, 000 and common patterns like 123456789
- TaxBandits sandbox rejects tax year 2026 (use 2024 or 2025)
- Workers AI wraps JSON in markdown fences (```json ... ```) — parser handles this
- `wrangler deploy` needs CLOUDFLARE_API_TOKEN env var: `source /home/exedev/myfilepath-new/.env && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy`
- Pre-push hook runs automatically on `git push` via lefthook
- NEVER commit secrets or .dev.vars

## Commit rules

- `npx tsc --noEmit` MUST pass before commit
- `npx prettier --write 'src/**/*.ts'` before commit  
- No explicit `any` types
- Descriptive commit messages
- Push triggers GitHub Action: check → deploy
- Test after deploy: `curl -s https://tax-agent.coey.dev/health | jq .`
