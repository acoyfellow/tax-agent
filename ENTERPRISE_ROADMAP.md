# Enterprise Roadmap — better-auth

## What better-auth gives us FREE off the shelf

### Auth Core
- Email/password, magic link, OTP, passkey login
- Session management (JWT or cookie)
- Hono integration (mount handler, middleware)
- D1/SQLite database adapter (Cloudflare native)

### API Keys Plugin (built-in)
- Create, revoke, verify API keys per user
- Built-in rate limiting per key
- Custom expiration, refill, remaining count
- Scoped permissions: `{ filings: ["read", "write"], transmit: ["execute"] }`
- Key prefix (e.g., `tax_live_`, `tax_test_`)
- Metadata per key

### Organization Plugin (built-in)
- Multi-tenant orgs (accounting firms = orgs, clients = members)
- Role-based access: owner, admin, member, custom
- Invitations (email invite flow)
- Per-org settings and metadata

### Enterprise Plugins
- **SSO** (OIDC + OAuth2 + SAML) — `@better-auth/sso`
- **SCIM** — user provisioning from Okta/Azure AD — `@better-auth/sso` (NEW)
- **OIDC Provider** — BE the identity provider
- **OAuth Provider** — let third parties OAuth into us (the QuickBooks play, reversed)
- **Admin** — admin dashboard, user management
- **OpenAPI** — auto-generated auth API docs

### Payments (built-in plugins)
- Stripe integration
- Polar, Autumn Billing, Dodo Payments, Creem, Commet

### Security (built-in)
- 2FA (TOTP, SMS, email)
- Captcha (Cloudflare Turnstile, reCAPTCHA, hCaptcha)
- Have I Been Pwned password check
- Bearer token auth

## What this means for tax-agent

### Phase 1: Multi-tenant API (this session if time permits)
- Install better-auth + D1 adapter
- API Key plugin with permissions
- Replace our single `TAX_AGENT_API_KEY` with per-user scoped keys
- Each key gets rate limits, audit trail, usage tracking

### Phase 2: Organizations
- Accounting firms create orgs
- Invite team members with roles
- Org-scoped filings (firm sees only their submissions)
- Per-org API keys

### Phase 3: Enterprise SSO
- SAML/OIDC for enterprise customers
- SCIM provisioning from Okta/Azure AD
- This is the "call us for pricing" tier

### Phase 4: Payments
- Stripe plugin for usage-based billing
- Free tier → paid tier based on filings/month
- Per-org billing

## Install plan
```bash
bun add better-auth @better-auth/sso
```

Database: D1 (Cloudflare native, SQL, free tier generous)
Integration: Hono mount at `/api/auth/*`
