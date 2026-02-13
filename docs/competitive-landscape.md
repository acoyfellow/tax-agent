# Competitive Landscape

> Last updated: 2026-02-13

## TL;DR

The open-source landscape for US 1099 e-filing is **empty**. No mature project exists. The B2B API space has 3 real players (TaxBandits, Abound, Tax1099) — none of them offer AI validation. tax-agent is the only open-source, AI-powered tax filing agent.

## Feature Matrix

| Feature | tax-agent | TaxBandits API | Abound | Tax1099 | Track1099 (Avalara) | Column Tax |
|---|---|---|---|---|---|---|
| **Category** | OSS AI agent | B2B API | B2B API | B2B + UI | Enterprise | Consumer 1040 |
| **1099-NEC filing** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **1099-MISC/K/INT/DIV** | ❌ (roadmap) | ✅ | Partial | ✅ | ✅ | ❌ |
| **W-2 filing** | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **W-9 collection** | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| **AI validation** | ✅ Workers AI | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Structural validation** | ✅ Zod + rules | ✅ server-side | ✅ | ✅ | ✅ | N/A |
| **Prompt injection defense** | ✅ | N/A | N/A | N/A | N/A | N/A |
| **Self-serve sandbox** | ✅ (via TaxBandits) | ✅ free | ⚠️ unclear | ✅ | ❌ sales call | ❌ sales call |
| **API-first** | ✅ | ✅ | ✅ | Partial (UI-first) | ❌ | ❌ |
| **Open source** | ✅ MIT | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Batch filing** | ✅ 100/batch | ✅ | ✅ | ✅ bulk | ✅ | N/A |
| **Webhook status** | ✅ | ✅ | ✅ | ❌ | ❌ | N/A |
| **Multi-tenant auth** | ✅ better-auth | N/A (per-account) | N/A | N/A | N/A | N/A |
| **Rate limiting** | ✅ CF native | Platform-level | Platform-level | Unknown | Unknown | N/A |
| **Audit logging** | ✅ Analytics Engine | ❌ (your problem) | ❌ | ❌ | ❌ | N/A |
| **Idempotent writes** | ✅ KV-backed | ❌ | Unknown | ❌ | ❌ | N/A |
| **Edge deployment** | ✅ CF Workers | Cloud | Cloud | Cloud | Cloud | Cloud |
| **Pricing** | Free (OSS) + CF costs | ~$0.35-5/form | Usage-based | ~$1.90/form | Enterprise | Enterprise |
| **OpenAPI spec** | ✅ | ✅ | ✅ | Partial | ❌ | ❌ |

## B2B Paid Alternatives

### TaxBandits API ⭐ (our underlying provider)
- **URL:** https://developer.taxbandits.com
- **Forms:** 1099 (all variants), W-2, W-9/W-8, 940, 941, 1095, 1098, ACA, 8809
- **Self-serve:** Yes, free sandbox with instant credentials
- **Pricing:** Tiered per-form ($0.35-$5 depending on volume and form type)
- **API quality:** Mature (v1.7.3), webhooks, Zapier, MCP server
- **Differentiator:** Broadest form coverage, best developer experience, real IRS e-file pipeline
- **Weakness:** No AI validation, no built-in multi-tenant auth

### Abound
- **URL:** https://withabound.com
- **Forms:** 1099 series (focused on gig economy)
- **Self-serve:** Unclear (SSL issues observed 2026-02)
- **Pricing:** Usage-based
- **Differentiator:** Developer-first, gig economy focus
- **Weakness:** Narrower form coverage, potential instability signals

### Tax1099
- **URL:** https://www.tax1099.com
- **Forms:** 1099, W-2, 941, 1042-S
- **Self-serve:** Yes, has developer API docs
- **Pricing:** ~$1.90/form federal
- **Differentiator:** Bulk filing, web UI + API
- **Weakness:** API feels secondary to web UI, no webhooks

### Track1099 → Avalara 1099 & W-9
- **URL:** https://www.track1099.com
- **Forms:** 1099, W-9 collection
- **Self-serve:** No, acquired by Avalara, "book a demo" only
- **Differentiator:** W-9 collection workflow, Avalara tax ecosystem
- **Weakness:** Lost API independence post-acquisition, enterprise sales only

### Column Tax
- **URL:** https://column.tax
- **NOT a competitor.** Embedded consumer 1040 filing for neobanks. Different category entirely.

### Stripe Tax
- **NOT relevant.** Sales tax/VAT/GST calculation. No information return filing.

## Open Source Landscape

**Effectively empty.** GitHub search results:
- "irs efile api" → **0 results**
- "1099 api tax" → **1 result** (partial Go wrapper, 0 stars)
- "1099-NEC" → 9 results, all 0-6 stars, none do e-filing
- "tax filing agent" → AI chatbot demos, nothing production-grade
- npm → Zero 1099-related packages

**tax-agent is the only open-source project that:**
1. Validates tax forms with AI
2. Files with the IRS via a real e-file pipeline
3. Provides a production API with auth, rate limiting, audit logging
4. Runs on edge infrastructure (Cloudflare Workers)

## Our Moat

1. **AI validation** — Nobody else does this. Structural + semantic review before filing.
2. **Open source** — The only OSS option in the space. Enterprises can audit, fork, self-host.
3. **Edge-native** — Sub-50ms cold starts vs cloud APIs. Global by default.
4. **Enterprise auth** — better-auth gives us multi-tenant, scoped API keys, org hierarchy (roadmap).
5. **Composable** — Effect-based error handling, typed error channel, retries with jitter.
6. **Defense in depth** — Prompt injection defenses, PII masking, audit trail, idempotency.
