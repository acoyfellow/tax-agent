import type { Context, Next } from 'hono';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter (per-IP, POST-only)
// ---------------------------------------------------------------------------

interface RateBucket {
  count: number;
  resetAt: number; // epoch ms
}

/** Module-level map — persists across requests within one isolate. */
const buckets = new Map<string, RateBucket>();

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 20; // per window per IP
const CLEANUP_INTERVAL_MS = 60_000; // purge stale entries every 60 s

let lastCleanup = Date.now();

/** Remove entries whose window has expired so the Map doesn't grow forever. */
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

/**
 * Hono middleware that rate-limits requests.
 * Attach it to POST routes only — GET endpoints are unlimited.
 */
export function rateLimiter() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    cleanupStaleEntries();

    const ip = c.req.header('cf-connecting-ip');
    // No cf-connecting-ip means we're not behind Cloudflare (local dev/tests)
    if (!ip) {
      await next();
      return;
    }
    const now = Date.now();

    let bucket = buckets.get(ip);

    // First request or window expired → start fresh window.
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 1, resetAt: now + WINDOW_MS };
      buckets.set(ip, bucket);
      await next();
      return;
    }

    // Within active window — increment.
    bucket.count += 1;

    if (bucket.count > MAX_REQUESTS) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      return c.json(
        {
          success: false,
          error: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSec) },
        },
      );
    }

    await next();
  };
}
