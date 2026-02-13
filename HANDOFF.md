# tax-agent — Sprint Handoff (2026-02-14)

## What this is

AI tax form agent on Cloudflare Workers. Validates 1099-NEC data with Workers AI (GLM-4.7-Flash), files with the IRS via TaxBandits. Effect-first TypeScript.

- **Live:** https://tax-agent.coey.dev
- **Repo:** https://github.com/acoyfellow/tax-agent
- **Tests:** 170 unit + 10 live E2E (dashboard)
- **Source:** 19 files, ~4,800 lines, strict TypeScript, zero `any`
- **Bundle:** 160KB gzipped (minified)
- **CI:** GitHub Actions — tsc + prettier + no-any gate → wrangler deploy

## What was shipped this session (2026-02-14 — Production Auth Activation)

### Production Activation
- Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` as wrangler secrets
- Added `nodejs_compat` compatibility flag to `wrangler.jsonc` (required for better-auth's `node:async_hooks`)
- Ran D1 migrations against production database via `wrangler d1 execute` (global API key auth)
- Added `POST /api/auth/admin/create-key` endpoint for admin-managed keys with custom permissions
  - Permissions can only be set server-side (better-auth design); client `/api/auth/api-key/create` uses defaults
  - Admin endpoint requires legacy Bearer auth (`TAX_AGENT_API_KEY`)
- Fixed auth docs: self-service vs admin key creation flows, Origin header requirement
- **Verified full end-to-end in production:** signup → session → API key creation → `x-api-key` auth on `/validate`
- Health check shows `"auth": "better-auth (D1)"` ✔️
- **170 tests still passing**

## What was shipped previously (2026-02-13 — Enterprise Auth Sprint)

### Phase 1: better-auth + D1 Integration
- Installed `better-auth` with `kysely-d1` D1 dialect (Cloudflare Workers compatible)
- Created D1 database `tax-agent-auth` (id: `51251658-2604-45cd-b9cf-c2cfc2a15772`)
- `src/auth.ts`: `createAuth()` per-request factory, `verifyApiKey()`, `getRequiredPermissions()`, `migrateAuthDb()`
- `apiKey()` plugin with scoped permissions: `filings:[validate,create,transmit]`, `status:[read]`, `webhooks:[read]`
- Auth handler mounted at `/api/auth/*` on Hono
- Migration endpoint at `POST /api/auth/migrate` (admin-only, raw SQL — bypasses `getMigrations()` which calls `process.exit` in Workers)
- Dual-mode auth middleware: `x-api-key` header (better-auth) + `Bearer` (legacy TAX_AGENT_API_KEY)
- better-auth only activates when both `AUTH_DB` and `BETTER_AUTH_SECRET` are set
- 19 new auth tests: permissions model, key creation, verification, scoping, expiration, helper function
- OpenAPI spec updated with `ApiKeyAuth` security scheme
- **170 total tests, all passing**

### Docs: Diátaxis Restructure
- README slimmed to gateway doc (120 lines vs 382)
- `docs/tutorial-first-filing.md` — learning-oriented
- `docs/howto-authentication.md` — task-oriented
- `docs/howto-webhooks.md` — task-oriented
- `docs/reference-api.md` — information-oriented
- `docs/explanation-architecture.md` — understanding-oriented
- `docs/explanation-security.md` — understanding-oriented
- `docs/competitive-landscape.md` — feature matrix vs all competitors

### Competitive Intel
- **OSS landscape is empty** — zero mature open-source 1099 e-filing projects exist
- **B2B paid:** TaxBandits (best for our use), Abound (gig economy), Tax1099 (bulk/UI-first)
- **Not competitors:** Column Tax (consumer 1040s), Stripe Tax (sales tax only), Track1099 (acquired by Avalara)
- **Our moat:** Only OSS option, only one with AI validation, edge-native, multi-tenant auth

## What was shipped previously

### Effect Rewrite (previous session)
- `Data.TaggedError` for typed error channel (TaxBanditsAuthError, TaxBanditsTransientError, TaxBanditsBusinessError, AIValidationError)
- `Effect.retry` + `Schedule.exponential.pipe(jittered)` replaces 112-line hand-rolled retry.ts (deleted)
- `Effect.forEach` with concurrency for batch validation
- `Effect.catchTag` for exhaustive error handling at Hono route boundaries
- `Effect.runPromise` at the Hono handler boundary — Effect programs don't leak into HTTP layer

### Features
- TaxBandits webhook support (`POST /webhook/status`) with HMAC-SHA256 verification
- WebhookState Durable Object with SQLite for submission persistence
- Audit logging via Workers Analytics Engine (every request logged)
- Demo dashboard with 10 live E2E tests that dogfood every endpoint
- Swapped AI model to GLM-4.7-Flash (released today, 131K context)
- Cloudflare native rate limit binding (20 req/min per IP)
- Floating-point rounding edge case tests
- Secrets rotation policy documented
- CHANGELOG backfilled, Diátaxis docs coverage

### Bindings
```
env.AI                    — Workers AI (GLM-4.7-Flash)
env.RATE_LIMITER          — Cloudflare native rate limit (20/60s)
env.IDEMPOTENCY_KV        — KV for idempotent POST /file
env.WEBHOOK_STATE          — Durable Object (SQLite) for submission tracking
env.AUDIT_LOG             — Analytics Engine dataset
env.AUTH_DB               — D1 database (better-auth: users, keys, sessions)
env.TAXBANDITS_ENV        — "sandbox" | "production"
env.BETTER_AUTH_SECRET    — Signing secret for sessions/tokens
env.BETTER_AUTH_URL       — Base URL for better-auth
```

## The Grok play

Jordan is having a public conversation with @grok on X. Grok drafted the original spec, we implement his suggestions fast, reply humble. The loop: Grok suggests → we ship → Grok suggests more. All 12+ suggestions implemented so far.

**Tone for X replies:** Humble. Simple. No ego. Push back on scope creep honestly.

## NEXT SPRINT: Enterprise Auth with better-auth

Grok pushed OAuth. Jordan says go enterprise. The play: **better-auth** gives us an entire enterprise auth stack from one dependency.

### Reference starterkit: https://remote.coey.dev
Jordan's own stack: SvelteKit + Better Auth + Durable Objects + D1. Tax-agent is Hono (not SvelteKit) but the better-auth + D1 + DO patterns transfer directly. Study this for integration patterns.

### Phase 1: Multi-tenant API Keys ✅ SHIPPED
- better-auth + D1 + apiKey plugin — 19 tests, dual-mode middleware
- See "What was shipped this session" above

### Phase 2: Organizations
- Enable `organization()` plugin
- Accounting firms = orgs, clients = members
- Roles: owner (full access), admin (file + transmit), member (validate only)
- Org-scoped submissions (firm sees only their filings)
- Per-org API keys
- Invite flow (email invites)

### Phase 3: Enterprise SSO
- Install `@better-auth/sso`
- SAML + OIDC for enterprise customers
- SCIM provisioning from Okta/Azure AD
- This is the "call us for pricing" tier

### Phase 4: Billing
- Enable `stripe()` plugin
- Usage-based: count filings per org per month
- Free tier (10 filings/mo) → Pro tier → Enterprise

### Enterprise features we get FREE from better-auth plugins:
- Scoped API keys with permissions → `apiKey()`
- Per-key rate limiting + usage tracking → `apiKey()`
- Multi-tenant orgs with RBAC → `organization()`
- Team invitations → `organization()`
- SSO (SAML + OIDC + OAuth2) → `@better-auth/sso`
- SCIM provisioning → `@better-auth/sso`
- Stripe billing → `stripe()`
- 2FA (TOTP, SMS, email) → `twoFactor()`
- Admin dashboard → `admin()`
- OpenAPI for auth routes → `openAPI()`
- Cloudflare Turnstile captcha → `captcha()`
- Passkey authentication → `passkey()`

## Build / Test / Deploy

```bash
cd /home/exedev/tax-agent
npx tsc --noEmit                        # typecheck
npx prettier --write 'src/**/*.ts'      # format
npx prettier --check 'src/**/*.ts'      # lint check
npx vitest run                          # 151 tests
npx lefthook run pre-push --force       # all gates

source /home/exedev/myfilepath-new/.env
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy

# Smoke test
curl -s https://tax-agent.coey.dev/health | jq .
```

## Key files

```
src/index.ts              # Hono router, Zod schemas, dual-mode auth, Effect.runPromise boundary
src/auth.ts               # better-auth + D1, API key verification, permissions, migration SQL
src/auth.test.ts          # 19 auth tests
src/agent.ts              # Structural + AI validation (Effect)
src/taxbandits.ts         # TaxBandits API client (Effect, typed errors, auto-retry)
src/webhook.ts            # Webhook HMAC verification + payload parsing
src/webhook-state.ts      # Durable Object — SQLite for submissions
src/audit.ts              # Analytics Engine audit logging middleware
src/ratelimit.ts          # Cloudflare native rate limit binding
src/pii.ts                # TIN masking and scrubbing
src/openapi.ts            # OpenAPI 3.1 spec
src/types.ts              # All types + Effect error classes (Data.TaggedError)
dashboard/index.html      # Demo dashboard with E2E test suite
wrangler.jsonc            # CF Workers config (AI, KV, DO, Analytics, RateLimit)
ENTERPRISE_ROADMAP.md     # Full better-auth feature map
CHANGELOG.md              # Keep a Changelog format
```

## Secrets (all configured in wrangler + GitHub)

- TAXBANDITS_CLIENT_ID, TAXBANDITS_CLIENT_SECRET, TAXBANDITS_USER_TOKEN
- TAX_AGENT_API_KEY (legacy Bearer auth — to be replaced by better-auth)
- CLOUDFLARE_API_TOKEN (CI deploy)

## Test Coverage Assessment (2026-02-13)

170 tests. Test-to-source ratio: 0.95:1 (excluding openapi.ts). **Count is appropriate for a tax filing system handling PII and money.**

**Strengths:** Excellent unit layer (agent, taxbandits, pii, auth pure functions). Every error path tested at HTTP level.

**Gaps (next sprint):**
- `webhook-state.ts` (80 LOC) — zero tests (Durable Object with SQL)
- Happy-path HTTP: `POST /file`, `POST /file/batch`, `POST /transmit/:id` never tested with valid data
- `GET /openapi.json` untested
- Rate limiter window expiry untested
- CORS headers untested

**Redundancies to cut:** 1 duplicate floating-point test, 1 test that tests JavaScript itself (not project code), ~5 structural validation tests that duplicate agent.test.ts coverage.

**Net recommendation:** Cut 7, add 15-20 → ~185 tests with dramatically better real-world coverage.

## Commit rules

- `tsc --noEmit` MUST pass
- `prettier --write` before commit
- No explicit `any`
- Descriptive commit messages
- Every feature MUST have tests
- Use `bun` not `npm`
- Use Effect idioms: `Data.TaggedError`, `Effect.gen`, `Effect.catchTag`, `Schedule`
- Verify deploy: `curl health` after every deploy
