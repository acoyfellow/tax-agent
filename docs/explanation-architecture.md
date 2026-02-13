# Architecture

> **Understanding** how tax-agent works under the hood.

## Request flow

```
User ─POST─▶ Worker ─validate─▶ Workers AI (GLM-4.7-Flash)
               │                        │
               │◀── issues / ok ────────┘
               │
               ├─create─▶ TaxBandits API ─▶ 1099-NEC created
               ├─transmit─▶ TaxBandits ─▶ Filed with IRS
               ├─status─▶ TaxBandits ─▶ TRANSMITTED / ACCEPTED
               │
               └─webhook◀── TaxBandits ─── IRS acknowledgment
                    │
                    ▼
               Durable Object (SQLite) ─── persistent status
```

## Validation pipeline

Validation runs in two independent passes:

1. **Structural validation** (pure functions, no network): TIN format, state codes, amount ranges, cross-field consistency (e.g., `is_state_filing: true` requires `state`). These produce `severity: "error"` issues that **block filing**.

2. **AI semantic review** (Workers AI): Withholding ratio analysis, red flag detection, business logic consistency. These produce `severity: "warning"` or `"info"` issues that **do not block filing**.

This separation is a security design choice. Even if an attacker manipulates the AI via prompt injection, structural errors can't be bypassed.

## Effect-based error handling

All business logic uses [Effect](https://effect.website) for typed error channels:

```typescript
// Errors flow through the type system
Effect<TaxBanditsCreateResponse, TaxBanditsAuthError | TaxBanditsTransientError | TaxBanditsBusinessError>
```

- `TaxBanditsAuthError` — bad credentials, **never retry**
- `TaxBanditsTransientError` — 429/5xx/network, **auto-retry** with exponential backoff + jitter
- `TaxBanditsBusinessError` — TaxBandits rejected the request
- `AIValidationError` — Workers AI unavailable

At the Hono handler boundary, `Effect.runPromise` converts to HTTP responses. Effect programs never leak into the HTTP layer.

## Cloudflare bindings

| Binding | Purpose |
|---|---|
| `env.AI` | Workers AI (GLM-4.7-Flash, 131K context) |
| `env.AUTH_DB` | D1 database for better-auth (users, API keys, sessions) |
| `env.RATE_LIMITER` | Native rate limit (20 req/min per IP) |
| `env.IDEMPOTENCY_KV` | KV for idempotent `POST /file` |
| `env.WEBHOOK_STATE` | Durable Object with SQLite for submission tracking |
| `env.AUDIT_LOG` | Analytics Engine dataset for compliance logging |

## Authentication

Dual-mode, checked in order:

1. `x-api-key` header → better-auth API key verification (checks scoped permissions against route)
2. `Authorization: Bearer` header → legacy single-token match
3. Neither configured → dev mode (all routes open)

better-auth is only active when both `AUTH_DB` and `BETTER_AUTH_SECRET` are set.

## Why TaxBandits (why we can't cut the middleman)

Filing 1099s with the IRS electronically requires the **FIRE system** (Filing Information Returns Electronically). You can't just POST JSON to the IRS. Here's what's actually involved:

1. **Transmitter Control Code (TCC)** — You must apply via IRS Form 4419. Takes weeks to months. One per organization.
2. **FIRE format** — Fixed-width 750-byte ASCII records per IRS Publication 1220. Every field is positional, padded, uppercase. It's a format from the 1990s.
3. **FIRE portal** — It's a web upload at `fire.irs.gov`, not a REST API. You upload `.ascii` files through a form.
4. **Annual testing** — IRS requires test submissions before each filing season.
5. **State filing** — Each state has its own system with its own format.
6. **Corrections/amendments** — If IRS rejects, you re-file through the same portal.

TaxBandits is an IRS-approved transmitter that wraps all of this in a REST API. We send JSON, they handle the FIRE conversion, submission, acknowledgment cycle, and state filing.

**Could we build it ourselves?** The format part — yes ([fire-1099](https://github.com/sdj0/fire-1099) already did it in Python). But the TCC application, FIRE portal automation, state filing matrix, and annual compliance testing is a business commitment, not a weekend project.

**Why TaxBandits specifically:**
- Self-serve sandbox (credentials in 2 minutes, free)
- Broadest form coverage (1099, W-2, W-9, 940, 941, ACA, 20+ forms)
- Real IRS e-file pipeline with webhook status callbacks
- ~$0.35-5/form — a convenience tax most users will happily pay

**Alternatives we evaluated:**
- **Abound** — gig economy focus, narrower coverage, unclear sandbox status
- **Tax1099** — UI-first with API as afterthought, ~$1.90/form
- **Column Tax** — consumer 1040s only, not information returns
- **Stripe Tax** — sales tax/VAT only, no 1099 filing

### What it would take to replace TaxBandits

If you wanted to file directly with the IRS and cut the dependency entirely:

1. **Apply for a TCC** — Submit IRS Form 4419. Budget 4–6 weeks. Requires a US business entity.
2. **Get FIRE system access** — Separate enrollment at `fire.irs.gov` after TCC approval.
3. **Pass annual FIRE testing** — Submit test files to the IRS before each filing season. They validate format compliance.
4. **Implement IRS Publication 1220** — Port the FIRE format generator to TypeScript. ~400 lines. Fixed-width ASCII: T record (transmitter), A record (payer), B records (payees), C record (end of payer), F record (end of transmission). Each record is exactly 750 bytes. [fire-1099](https://github.com/sdj0/fire-1099) is a working Python reference.
5. **Automate FIRE upload** — The portal is web-only. Either automate the browser or find an undocumented submission path.
6. **Handle acknowledgments** — IRS posts results to FIRE portal. You poll or scrape. No webhooks.
7. **State filing** — Implement the Combined Federal/State Filing Program, or file separately with each state. Every state has its own format, portal, and deadlines.
8. **Corrections** — Implement correction/void filings per IRS spec (different record types).

Steps 1–3 are bureaucratic (one-time, weeks). Step 4 is a weekend. Steps 5–8 are the ongoing maintenance burden. TaxBandits charges $0.35–5/form to handle all of it.

See [competitive landscape](./competitive-landscape.md) for the full breakdown.
