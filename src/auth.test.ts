import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import {
  getRequiredPermissions,
  PERMISSIONS,
  DEFAULT_PERMISSIONS,
  createAuth,
  migrateAuthDb,
  verifyApiKey,
} from './auth';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Pure function tests — no D1 needed
// ---------------------------------------------------------------------------

describe('getRequiredPermissions', () => {
  it('returns filings:validate for /validate', () => {
    expect(getRequiredPermissions('/validate')).toEqual({ filings: ['validate'] });
  });

  it('returns filings:create for /file', () => {
    expect(getRequiredPermissions('/file')).toEqual({ filings: ['create'] });
  });

  it('returns filings:create for /file/batch', () => {
    expect(getRequiredPermissions('/file/batch')).toEqual({ filings: ['create'] });
  });

  it('returns filings:transmit for /transmit', () => {
    expect(getRequiredPermissions('/transmit')).toEqual({ filings: ['transmit'] });
  });

  it('returns filings:transmit for /transmit/abc-123', () => {
    expect(getRequiredPermissions('/transmit/abc-123')).toEqual({ filings: ['transmit'] });
  });

  it('returns status:read for /status', () => {
    expect(getRequiredPermissions('/status')).toEqual({ status: ['read'] });
  });

  it('returns status:read for /status/sub-id', () => {
    expect(getRequiredPermissions('/status/sub-id')).toEqual({ status: ['read'] });
  });

  it('returns webhooks:read for /webhook/submissions', () => {
    expect(getRequiredPermissions('/webhook/submissions')).toEqual({ webhooks: ['read'] });
  });

  it('returns null for unknown paths', () => {
    expect(getRequiredPermissions('/')).toBeNull();
    expect(getRequiredPermissions('/health')).toBeNull();
    expect(getRequiredPermissions('/openapi.json')).toBeNull();
  });
});

describe('PERMISSIONS constants', () => {
  it('defines all permission scopes', () => {
    expect(PERMISSIONS.filings).toEqual(['validate', 'create', 'transmit']);
    expect(PERMISSIONS.status).toEqual(['read']);
    expect(PERMISSIONS.webhooks).toEqual(['read']);
  });

  it('DEFAULT_PERMISSIONS grants validate + read only', () => {
    expect(DEFAULT_PERMISSIONS.filings).toEqual(['validate']);
    expect(DEFAULT_PERMISSIONS.status).toEqual(['read']);
    expect(DEFAULT_PERMISSIONS.webhooks).toEqual(['read']);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — better-auth with D1
// ---------------------------------------------------------------------------

describe('better-auth D1 integration', () => {
  // Shared auth instance across all tests in this suite
  // (better-auth uses an in-memory Kysely instance that must be reused)
  let auth: ReturnType<typeof createAuth>;
  let userId: string;

  beforeAll(async () => {
    const testEnv = {
      ...env,
      BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long',
      BETTER_AUTH_URL: 'http://localhost',
    } as unknown as Env;

    // Run raw SQL migrations to create tables
    await migrateAuthDb(testEnv.AUTH_DB!);

    // Create shared auth instance
    auth = createAuth(testEnv);

    // Create a test user for all tests
    const res = await auth.api.signUpEmail({
      body: {
        email: 'test@example.com',
        password: 'TestPassword123!',
        name: 'Test User',
      },
    });
    userId = res.user.id;
  });

  it('created a user via signup', () => {
    expect(userId).toBeTruthy();
  });

  it('can create an API key for a user', async () => {
    const key = await auth.api.createApiKey({
      body: {
        name: 'Test Key',
        userId,
        permissions: {
          filings: ['validate', 'create'],
          status: ['read'],
        },
      },
    });
    expect(key).toBeDefined();
    expect(key.key).toBeTruthy();
  });

  it('can verify an API key with correct permissions', async () => {
    const key = await auth.api.createApiKey({
      body: {
        name: 'Verify Test Key',
        userId,
        permissions: {
          filings: ['validate', 'create'],
          status: ['read'],
        },
      },
    });

    const result = await auth.api.verifyApiKey({
      body: {
        key: key.key,
        permissions: {
          filings: ['validate'],
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it('rejects API key with insufficient permissions', async () => {
    const key = await auth.api.createApiKey({
      body: {
        name: 'Limited Key',
        userId,
        permissions: {
          filings: ['validate'],
        },
      },
    });

    // Try to verify for transmit permission — should fail
    const result = await auth.api.verifyApiKey({
      body: {
        key: key.key,
        permissions: {
          filings: ['transmit'],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects invalid API key', async () => {
    const result = await auth.api.verifyApiKey({
      body: {
        key: 'totally-invalid-key-that-does-not-exist',
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects expired API key', async () => {
    // Create a key, then manually expire it in the DB
    const key = await auth.api.createApiKey({
      body: {
        name: 'Soon-Expired Key',
        userId,
        permissions: {
          filings: ['validate'],
        },
      },
    });

    // Verify it works before expiration
    const before = await auth.api.verifyApiKey({ body: { key: key.key } });
    expect(before.valid).toBe(true);

    // Manually set expiresAt to the past in D1
    const db = (env as unknown as Env).AUTH_DB!;
    await db
      .prepare('UPDATE apikey SET expiresAt = ? WHERE id = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), key.id)
      .run();

    // Should now be expired
    const after = await auth.api.verifyApiKey({ body: { key: key.key } });
    expect(after.valid).toBe(false);
  });

  it('verifyApiKey helper works end-to-end', async () => {
    const testEnv = {
      ...env,
      BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long',
      BETTER_AUTH_URL: 'http://localhost',
    } as unknown as Env;

    // Create a key via the shared auth instance
    const key = await auth.api.createApiKey({
      body: {
        name: 'Helper Test Key',
        userId,
        permissions: {
          filings: ['validate'],
          status: ['read'],
        },
      },
    });

    // Verify via the exported helper (creates its own auth instance)
    const result = await verifyApiKey(testEnv, key.key, { filings: ['validate'] });
    expect(result.valid).toBe(true);
    expect(result.userId).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests — auth middleware via SELF.fetch
// ---------------------------------------------------------------------------

describe('auth middleware (HTTP)', () => {
  it('allows requests in dev mode (no TAX_AGENT_API_KEY, no BETTER_AUTH_SECRET)', async () => {
    // The test env has neither TAX_AGENT_API_KEY nor BETTER_AUTH_SECRET set
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payer: {
          name: 'Test',
          tin: '27-1234567',
          tin_type: 'EIN',
          address: '100 Main St',
          city: 'New York',
          state: 'NY',
          zip_code: '10001',
          phone: '2125551234',
          email: 'test@test.com',
        },
        recipient: {
          first_name: 'Jane',
          last_name: 'Smith',
          tin: '412789654',
          tin_type: 'SSN',
          address: '200 Oak Ave',
          city: 'Austin',
          state: 'TX',
          zip_code: '78701',
        },
        nonemployee_compensation: 5000,
        is_federal_tax_withheld: false,
        is_state_filing: false,
      }),
    });
    // Should NOT be 401/403 — dev mode allows through
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
