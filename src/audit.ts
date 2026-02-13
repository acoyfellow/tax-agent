import type { Context, Next } from 'hono';
import type { Env } from './types';

/**
 * Audit log middleware — logs every request to Analytics Engine.
 *
 * Blobs: [method, path, status, ip, user-agent]
 * Doubles: [response_time_ms, status_code]
 * Index: IP or 'anonymous'
 *
 * Fire-and-forget — never blocks the response.
 */
export function auditLogger() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
    const start = Date.now();
    await next();
    const elapsed = Date.now() - start;

    const log = c.env.AUDIT_LOG;
    if (!log) return;

    const ip = c.req.header('cf-connecting-ip') ?? 'anonymous';
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const status = c.res.status.toString();
    const ua = c.req.header('user-agent')?.slice(0, 200) ?? '';

    log.writeDataPoint({
      indexes: [ip],
      blobs: [method, path, status, ua],
      doubles: [elapsed, c.res.status],
    });
  };
}
