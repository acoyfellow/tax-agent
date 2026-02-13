import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from './types';
import { rateLimiter, resetBuckets } from './ratelimit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('*', rateLimiter());
  app.post('/test', (c) => c.json({ success: true }));

  // Wrapper to inject env bindings via the fetch signature
  return {
    async request(req: Request): Promise<Response> {
      return app.fetch(req, envOverrides as Env);
    },
  };
}

function postRequest(ip?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ip) headers['cf-connecting-ip'] = ip;
  return new Request('http://localhost/test', { method: 'POST', headers });
}

/** Mock Cloudflare rate limiter binding */
function createMockLimiter(responses: boolean[]): RateLimit {
  let callIndex = 0;
  return {
    async limit(_opts: RateLimitOptions) {
      const idx = callIndex++;
      const val = idx < responses.length ? responses[idx] : undefined;
      return { success: val ?? false };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimiter', () => {
  beforeEach(() => {
    resetBuckets();
  });

  describe('skips rate limiting', () => {
    it('passes through when no cf-connecting-ip header', async () => {
      const app = createApp();
      const res = await app.request(postRequest());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body).toEqual({ success: true });
    });
  });

  describe('in-memory fallback (no RATE_LIMITER binding)', () => {
    it('allows requests within the limit', async () => {
      const app = createApp();
      for (let i = 0; i < 20; i++) {
        const res = await app.request(postRequest('1.2.3.4'));
        expect(res.status).toBe(200);
      }
    });

    it('blocks the 21st request from the same IP', async () => {
      const app = createApp();
      for (let i = 0; i < 20; i++) {
        await app.request(postRequest('1.2.3.4'));
      }
      const res = await app.request(postRequest('1.2.3.4'));
      expect(res.status).toBe(429);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Rate limit exceeded');
      expect(res.headers.get('Retry-After')).toBe('60');
    });

    it('tracks IPs independently', async () => {
      const app = createApp();
      for (let i = 0; i < 20; i++) {
        await app.request(postRequest('1.2.3.4'));
      }
      // Different IP should still work
      const res = await app.request(postRequest('5.6.7.8'));
      expect(res.status).toBe(200);
    });

    it('resetBuckets clears state', async () => {
      const app = createApp();
      for (let i = 0; i < 20; i++) {
        await app.request(postRequest('1.2.3.4'));
      }
      const blocked = await app.request(postRequest('1.2.3.4'));
      expect(blocked.status).toBe(429);

      resetBuckets();
      const res = await app.request(postRequest('1.2.3.4'));
      expect(res.status).toBe(200);
    });
  });

  describe('Cloudflare native binding (RATE_LIMITER present)', () => {
    it('allows when binding returns success: true', async () => {
      const limiter = createMockLimiter([true]);
      const app = createApp({ RATE_LIMITER: limiter });
      const res = await app.request(postRequest('10.0.0.1'));
      expect(res.status).toBe(200);
    });

    it('blocks when binding returns success: false', async () => {
      const limiter = createMockLimiter([false]);
      const app = createApp({ RATE_LIMITER: limiter });
      const res = await app.request(postRequest('10.0.0.1'));
      expect(res.status).toBe(429);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Rate limit exceeded');
    });

    it('uses binding instead of in-memory when available', async () => {
      // Even after 20 requests in-memory would block,
      // if binding says yes, it should allow
      const limiter = createMockLimiter(Array(25).fill(true) as boolean[]);
      const app = createApp({ RATE_LIMITER: limiter });
      for (let i = 0; i < 25; i++) {
        const res = await app.request(postRequest('10.0.0.1'));
        expect(res.status).toBe(200);
      }
    });

    it('passes IP as key to the binding', async () => {
      let capturedKey = '';
      const limiter: RateLimit = {
        async limit(opts: { key: string }) {
          capturedKey = opts.key;
          return { success: true };
        },
      };
      const app = createApp({ RATE_LIMITER: limiter });
      await app.request(postRequest('203.0.113.42'));
      expect(capturedKey).toBe('203.0.113.42');
    });
  });

  describe('429 response format', () => {
    it('returns correct JSON envelope and Retry-After header', async () => {
      const limiter = createMockLimiter([false]);
      const app = createApp({ RATE_LIMITER: limiter });
      const res = await app.request(postRequest('10.0.0.1'));
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('60');
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({
        success: false,
        error: 'Rate limit exceeded. Try again in 60 seconds.',
      });
    });
  });
});
