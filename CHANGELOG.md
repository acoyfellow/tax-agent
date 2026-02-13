# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Swapped AI model from Llama 3.1 8B to GLM-4.7-Flash (131K context, released 2026-02-13)

## [2.2.0] - 2026-02-13

### Added

- TaxBandits webhook support with Durable Object persistence for async status callbacks
- Audit logging with Workers Analytics Engine for every filing event
- Webhook endpoints (`POST /webhook/taxbandits`) added to API overview

## [2.1.0] - 2026-02-13

### Added

- Typed error classes using `Data.TaggedError` for the Effect error channel
- Effect-based retry with `Effect.retry` + `Schedule` (replaces hand-rolled retry module)

### Changed

- **Effect rewrite** — rewrote `agent.ts`, `taxbandits.ts`, and `index.ts` to use Effect programs at the Hono boundary
- Structural issues are now preserved in the AI fallback handler during Effect error recovery

### Removed

- `retry.ts` — deleted in favor of Effect's built-in retry + Schedule combinators

## [2.0.2] - 2026-02-13

### Added

- Retry with exponential backoff for TaxBandits API calls
- Floating-point rounding edge-case tests
- Secrets rotation policy documentation

## [2.0.1] - 2026-02-13

### Added

- Cloudflare native rate limit binding (replaces in-memory rate limiter)
- Prompt injection defense documentation with examples

### Changed

- Refactored rate limiting to use native `RateLimit` type instead of custom `RateLimiter` interface

### Removed

- In-memory rate limiter implementation

## [2.0.0] - 2026-02-13

### Added

- 79 unit tests for `agent.ts` and `taxbandits.ts` — real crypto, real validation, zero mocks
- Batch filing endpoint (`POST /file/batch`) with rate limiter and PII scrubbing
- OpenAPI 3.1 spec served at `GET /openapi.json`
- PII scrubbing: mask TINs in error logs and API responses
- Per-IP rate limiting: 20 req/min on POST endpoints
- Idempotency key on `POST /file` to prevent duplicate IRS filings (KV-backed)
- AI prompt injection mitigation — sanitize and delimit user inputs
- Support for SSN as payer TIN type (not just EIN)
- Sanitized address fields in AI prompt for structural validation
- Comprehensive test suite with 28 initial tests (H5)
- `.dev.vars.example` and `CONTRIBUTING.md`

### Changed

- Switched AI model from Llama 70B to 8B for faster validation
- Tuned 8B model prompt to reduce false-positive warnings
- Raised AI warning threshold to $10M, explicitly allow all normal amounts
- Made `KindOfEmployer` / `KindOfPayer` configurable, randomize `SequenceId`
- Wired `state_income` / `state_tax_withheld` into TaxBandits payload
- Replaced hardcoded `BusinessType` `'ESTE'` with configurable `business_type` field
- Return proper 401 JSON response instead of generic 500 on auth failure
- Version aligned to 2.0.0 in `package.json`

### Fixed

- Missing comma in `wrangler.jsonc` before `kv_namespaces`

## [1.0.0] - 2026-02-13

### Added

- Initial AI tax filing agent on Cloudflare Workers
- TaxBandits integration for 1099-NEC e-filing (replaced Column Tax)
- AI validation pipeline using Workers AI
- Bearer token authentication
- GitHub Actions CI/CD: deploy on push to main
- Lefthook pre-push quality gates + CI checks before deploy
- Diátaxis-style README documentation
- Worker handoff document with full project context

### Fixed

- All 6 critical issues from initial code review
- AI validation pipeline and switch to `wrangler.jsonc`
