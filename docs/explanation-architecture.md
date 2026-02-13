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

## Why TaxBandits

TaxBandits is the only tax API with:
- Self-serve sandbox signup (credentials in 2 minutes)
- Real IRS e-file pipeline
- Support for 1099-NEC/MISC/K, W-2, W-9, and 20+ other forms

Column Tax handles personal 1040s but requires a sales call. Intuit has no TurboTax API. Tax1099 is UI-first with API as an afterthought.
