import type { Context, Next } from 'hono';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Rate limiter middleware — Cloudflare native binding with in-memory fallback
// ---------------------------------------------------------------------------

// In-memory fallback for local dev / tests where the binding isn't available
interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanupStaleEntries(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [ip, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(ip);
    }
  }
}

/** In-memory sliding window — used when RATE_LIMITER binding is unavailable. */
function inMemoryLimit(key: string): { success: boolean } {
  cleanupStaleEntries();
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 1, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
    return { success: true };
  }
  bucket.count += 1;
  return { success: bucket.count <= MAX_REQUESTS };
}

/** Exported for testing — reset in-memory state between tests. */
export function resetBuckets(): void {
  buckets.clear();
  lastCleanup = Date.now();
}

/**
 * Hono middleware that rate-limits POST requests.
 *
 * Uses Cloudflare's native rate limit binding (env.RATE_LIMITER) when available,
 * falls back to in-memory sliding window for local dev / tests.
 */
export function rateLimiter() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const ip = c.req.header('cf-connecting-ip');
    // No IP = local dev / tests without cf-connecting-ip header → skip
    if (!ip) {
      await next();
      return;
    }

    const limiter = c.env.RATE_LIMITER;
    let allowed: boolean;

    if (limiter) {
      // Cloudflare native rate limit binding
      const outcome = await limiter.limit({ key: ip });
      allowed = outcome.success;
    } else {
      // In-memory fallback
      const outcome = inMemoryLimit(ip);
      allowed = outcome.success;
    }

    if (!allowed) {
      return c.json(
        {
          success: false,
          error: 'Rate limit exceeded. Try again in 60 seconds.',
        },
        {
          status: 429,
          headers: { 'Retry-After': '60' },
        },
      );
    }

    await next();
  };
}
