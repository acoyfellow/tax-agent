import { betterAuth } from 'better-auth';
import { apiKey } from 'better-auth/plugins';
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
  return betterAuth({
    database: env.AUTH_DB,
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
