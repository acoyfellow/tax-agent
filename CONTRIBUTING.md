# Contributing to tax-agent

## Prerequisites

- **Node.js** ≥ 18
- **npm** (comes with Node)
- A **Cloudflare** account (for Workers AI binding)
- A **TaxBandits** sandbox account (for filing integration)

## Setup

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/acoyfellow/tax-agent.git
   cd tax-agent
   npm install
   ```

2. Copy the example env file and fill in your secrets:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

   Edit `.dev.vars` with your TaxBandits sandbox credentials and an API key of your choice.

3. Run the dev server:

   ```bash
   npx wrangler dev
   ```

## Quality Gates

All of these must pass before pushing:

| Gate | Command |
|------|---------|
| TypeScript | `npx tsc --noEmit` |
| Formatting | `npx prettier --check 'src/**/*.ts'` |
| Tests | `npx vitest run` |
| No `any` types | enforced by grep in pre-push hook |

A **lefthook** pre-push hook runs these automatically on `git push`. To run manually:

```bash
npx lefthook run pre-push --force
```

## Auto-formatting

Format before committing:

```bash
npx prettier --write 'src/**/*.ts'
```

## Testing

Tests use [Vitest](https://vitest.dev/) with [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) to run inside the Workers runtime.

```bash
npx vitest run        # single run
npx vitest            # watch mode
```

Test files live alongside source files (e.g., `src/index.test.ts`).

## Project Structure

```
src/
├── index.ts        # Hono router, Zod schemas, auth middleware, routes
├── index.test.ts   # Tests
├── agent.ts        # Structural + AI validation pipeline
├── taxbandits.ts   # TaxBandits API client (JWS→JWT auth, CRUD)
└── types.ts        # All TypeScript types
```

## Deploy

Deploy is handled by GitHub Actions on push to `main`. The workflow runs quality gates first, then deploys via `wrangler deploy`.

To deploy manually:

```bash
CLOUDFLARE_API_TOKEN=<your-token> npx wrangler deploy
```

## Commit Guidelines

- Descriptive commit messages
- `npx tsc --noEmit` must pass
- `npx prettier --write 'src/**/*.ts'` before committing
- No explicit `any` types
- Never commit secrets or `.dev.vars`
