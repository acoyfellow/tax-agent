# tax-agent — Handoff (2026-02-13 14:00 UTC)

## What this is

AI tax form agent on Cloudflare Workers. Validates 1099-NEC data with Workers AI (Llama 3.1 8B), files with the IRS via TaxBandits.

- **Live:** https://tax-agent.coey.dev
- **Repo:** https://github.com/acoyfellow/tax-agent
- **Version:** 2.0.0
- **Tests:** 128 (28 integration + 100 unit)
- **Source:** 11 files, 3,306 lines, strict TypeScript, zero `any`

## The Grok play

Jordan is having a conversation with @grok on X. Grok drafted the original spec, reviewed the repo, and is now giving suggestions. The strategy: reply humble and simple to each Grok suggestion, implement it fast, reply "done — what else?" This tricks Grok into being our free code reviewer/architect. We push him to keep suggesting, he thinks he's pushing us.

**Tone for X replies to Grok:** Humble. Simple. No ego. "Good call, done" energy. Never "already done." Ask what's next. Keep the loop going.

**Latest Grok suggestion:** Replace in-memory rate limiter with Cloudflare's native rate limiting binding. We were about to implement this when context ran out.

## Current Grok thread suggestions (all addressed except native rate limiting):
1. ✅ Unit tests for agent.ts and taxbandits.ts
2. ✅ Rate limiting (in-memory currently — Grok suggested Cloudflare native)
3. ✅ PII security: TINs masked in transit/logs
4. ✅ Batch filing for multi-recipients
5. ✅ OpenAPI spec
6. ✅ Prompt injection defenses (with docs + examples)
7. ✅ Swap in-memory rate limiter for Cloudflare native rate limit binding

## Completed this session

- Switched from custom `RateLimiter` interface to native Cloudflare `RateLimit` type from `@cloudflare/workers-types`
- Added retry with exponential backoff + jitter for TaxBandits API calls (src/retry.ts, 36 tests)
- Added 9 floating-point rounding edge case tests
- Added secrets rotation policy to README
- Deployed successfully — health check passing
- **Tests: 173** (was 128)

## Next task: Wait for Grok's next suggestion

All 7 Grok suggestions have been implemented. The pattern continues:
1. Read Grok's suggestion
2. Implement it
3. Commit + push + deploy
4. Reply humble: "Done. [one-line summary]. What else you got?"

## After that: keep the Grok loop going

Whatever Grok suggests next, implement it and reply. The pattern:
1. Read Grok's suggestion
2. Implement it
3. Commit + push + deploy
4. Reply humble: "Done. [one-line summary]. What else you got?"

## Build / Test / Deploy

```bash
cd /home/exedev/tax-agent
npx tsc --noEmit                        # typecheck
npx prettier --write 'src/**/*.ts'      # format
npx prettier --check 'src/**/*.ts'      # lint check
npx lefthook run pre-push --force       # all gates

source /home/exedev/myfilepath-new/.env
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy

# Smoke test
curl -s https://tax-agent.coey.dev/health | jq .

# Auth test
API_KEY=$(cat /tmp/tax-agent-api-key.txt)
curl -s https://tax-agent.coey.dev/validate \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"payer":{"name":"Acme Corp","tin":"27-1234567","tin_type":"EIN","address":"100 Main St","city":"New York","state":"NY","zip_code":"10001","phone":"2125551234","email":"payroll@acme.com","business_type":"LLC"},"recipient":{"first_name":"Jane","last_name":"Smith","tin":"412789654","tin_type":"SSN","address":"200 Oak Ave","city":"Austin","state":"TX","zip_code":"78701"},"nonemployee_compensation":5000.00,"is_federal_tax_withheld":false,"is_state_filing":false,"tax_year":"2024"}' | jq .
```

## Key files

```
src/index.ts        # Hono router, Zod schemas, auth, routes
src/index.test.ts   # 28 integration tests  
src/agent.ts        # Structural + AI validation
src/agent.test.ts   # Unit tests
src/taxbandits.ts   # TaxBandits API client (JWS auth, token cache)
src/taxbandits.test.ts # Unit tests
src/types.ts        # All TypeScript types
src/ratelimit.ts    # Rate limiter (TO BE REPLACED with CF native)
src/pii.ts          # PII scrubbing
src/pii.test.ts     # PII tests
src/openapi.ts      # OpenAPI 3.1 spec
wrangler.jsonc      # CF Workers config
lefthook.yml        # Pre-push gates
.github/workflows/deploy.yml  # CI: check → deploy
```

## Secrets (all configured in wrangler + GitHub)

- TAXBANDITS_CLIENT_ID, TAXBANDITS_CLIENT_SECRET, TAXBANDITS_USER_TOKEN
- TAX_AGENT_API_KEY (Bearer auth)
- CLOUDFLARE_API_TOKEN (CI deploy)

## Commit rules

- tsc --noEmit MUST pass
- prettier --write before commit
- No explicit `any`
- Descriptive commit messages
- git push triggers lefthook + GitHub Action deploy
- Verify after deploy: curl health endpoint
- NEVER commit secrets
