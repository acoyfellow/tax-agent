import { betterAuth } from 'better-auth';
import { apiKey } from 'better-auth/plugins';
import { D1Dialect } from 'kysely-d1';
import { Kysely } from 'kysely';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Permission model for tax-agent API keys
// ---------------------------------------------------------------------------

export const PERMISSIONS = {
  filings: ['validate', 'create', 'transmit'],
  status: ['read'],
  webhooks: ['read'],
} as const;

/** Default permissions for new API keys — full read, validate only */
export const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  filings: ['validate'],
  status: ['read'],
  webhooks: ['read'],
};

// ---------------------------------------------------------------------------
// Create a better-auth instance per-request (CF Workers: env only at runtime)
// ---------------------------------------------------------------------------

export function createAuth(env: Env) {
  const db = new Kysely({ dialect: new D1Dialect({ database: env.AUTH_DB! }) });
  return betterAuth({
    database: {
      db,
      type: 'sqlite' as const,
    },
    secret: env.BETTER_AUTH_SECRET ?? 'dev-secret-change-in-production',
    baseURL: env.BETTER_AUTH_URL ?? 'https://tax-agent.coey.dev',
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      apiKey({
        enableSessionForAPIKeys: true,
        permissions: {
          defaultPermissions: DEFAULT_PERMISSIONS,
        },
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Route → required permission mapping
// ---------------------------------------------------------------------------

const ROUTE_PERMISSIONS: Record<string, Record<string, string[]>> = {
  '/validate': { filings: ['validate'] },
  '/file': { filings: ['create'] },
  '/file/batch': { filings: ['create'] },
  '/transmit': { filings: ['transmit'] },
  '/status': { status: ['read'] },
  '/webhook/submissions': { webhooks: ['read'] },
};

/** Resolve required permissions for a request path */
export function getRequiredPermissions(path: string): Record<string, string[]> | null {
  // Exact match first
  if (ROUTE_PERMISSIONS[path]) return ROUTE_PERMISSIONS[path];
  // Prefix match (e.g., /transmit/abc → /transmit)
  for (const [route, perms] of Object.entries(ROUTE_PERMISSIONS)) {
    if (path.startsWith(route + '/') || path === route) return perms;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verify API key via better-auth
// ---------------------------------------------------------------------------

export interface VerifyResult {
  valid: boolean;
  error?: string;
  keyId?: string;
  userId?: string;
}

export async function verifyApiKey(
  env: Env,
  key: string,
  requiredPermissions?: Record<string, string[]>,
): Promise<VerifyResult> {
  const auth = createAuth(env);
  const result = await auth.api.verifyApiKey({
    body: {
      key,
      ...(requiredPermissions ? { permissions: requiredPermissions } : {}),
    },
  });
  if (!result.valid) {
    return {
      valid: false,
      error: result.error?.message ?? 'Invalid API key',
    };
  }
  return {
    valid: true,
    keyId: result.key?.id,
    userId: result.key?.userId,
  };
}

// ---------------------------------------------------------------------------
// Raw SQL schema for better-auth tables (SQLite/D1)
// Used for programmatic migration when getMigrations() isn't available
// ---------------------------------------------------------------------------

/** Individual SQL statements for better-auth schema (SQLite/D1) */
export const AUTH_SCHEMA_STATEMENTS: string[] = [
  'CREATE TABLE IF NOT EXISTS "user" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE, "emailVerified" INTEGER NOT NULL, "image" TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "session" ("id" TEXT NOT NULL PRIMARY KEY, "expiresAt" DATE NOT NULL, "token" TEXT NOT NULL UNIQUE, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL, "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE)',
  'CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId")',
  'CREATE TABLE IF NOT EXISTS "account" ("id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" DATE, "refreshTokenExpiresAt" DATE, "scope" TEXT, "password" TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL)',
  'CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId")',
  'CREATE TABLE IF NOT EXISTS "verification" ("id" TEXT NOT NULL PRIMARY KEY, "identifier" TEXT NOT NULL, "value" TEXT NOT NULL, "expiresAt" DATE NOT NULL, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL)',
  'CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier")',
  'CREATE TABLE IF NOT EXISTS "apikey" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT, "start" TEXT, "prefix" TEXT, "key" TEXT NOT NULL, "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "refillInterval" INTEGER, "refillAmount" INTEGER, "lastRefillAt" DATE, "enabled" INTEGER, "rateLimitEnabled" INTEGER, "rateLimitTimeWindow" INTEGER, "rateLimitMax" INTEGER, "requestCount" INTEGER, "remaining" INTEGER, "lastRequest" DATE, "expiresAt" DATE, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL, "permissions" TEXT, "metadata" TEXT)',
  'CREATE INDEX IF NOT EXISTS "apikey_key_idx" ON "apikey"("key")',
  'CREATE INDEX IF NOT EXISTS "apikey_userId_idx" ON "apikey"("userId")',
];

/** Run better-auth schema migration against a D1 database */
export async function migrateAuthDb(db: D1Database): Promise<void> {
  await db.batch(AUTH_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}
