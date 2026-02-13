import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from './types';
import { auditLogger } from './audit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAuditLog() {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  return {
    binding: {
      writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) {
        points.push(point);
      },
    },
    points,
  };
}

function createApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', auditLogger());
  app.get('/hello', (c) => c.json({ ok: true }));
  app.post('/submit', (c) => c.json({ created: true }, 201));

  return {
    async request(req: Request): Promise<Response> {
      return app.fetch(req, envOverrides as Env);
    },
  };
}

function getRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { method: 'GET', headers });
}

function postRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auditLogger', () => {
  it('calls writeDataPoint with correct shape', async () => {
    const mock = createMockAuditLog();
    const app = createApp({ AUDIT_LOG: mock.binding as unknown as AnalyticsEngineDataset });

    const res = await app.request(
      getRequest('/hello', { 'cf-connecting-ip': '1.2.3.4', 'user-agent': 'TestAgent/1.0' }),
    );
    expect(res.status).toBe(200);

    expect(mock.points).toHaveLength(1);
    const point = mock.points[0]!;

    // indexes: [ip]
    expect(point.indexes).toEqual(['1.2.3.4']);

    // blobs: [method, path, status, ua]
    expect(point.blobs).toHaveLength(4);
    expect(point.blobs![0]).toBe('GET');
    expect(point.blobs![1]).toBe('/hello');
    expect(point.blobs![2]).toBe('200');
    expect(point.blobs![3]).toBe('TestAgent/1.0');

    // doubles: [elapsed_ms, status_code]
    expect(point.doubles).toHaveLength(2);
    expect(typeof point.doubles![0]).toBe('number');
    expect(point.doubles![1]).toBe(200);
  });

  it('does not throw when AUDIT_LOG binding is missing', async () => {
    const app = createApp({}); // no AUDIT_LOG
    const res = await app.request(getRequest('/hello'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it('records response time >= 0', async () => {
    const mock = createMockAuditLog();
    const app = createApp({ AUDIT_LOG: mock.binding as unknown as AnalyticsEngineDataset });

    await app.request(getRequest('/hello', { 'cf-connecting-ip': '10.0.0.1' }));

    expect(mock.points).toHaveLength(1);
    const elapsed = mock.points[0]!.doubles![0]!;
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it('records correct method and path', async () => {
    const mock = createMockAuditLog();
    const app = createApp({ AUDIT_LOG: mock.binding as unknown as AnalyticsEngineDataset });

    await app.request(postRequest('/submit', { 'cf-connecting-ip': '10.0.0.2' }));

    expect(mock.points).toHaveLength(1);
    const point = mock.points[0]!;
    expect(point.blobs![0]).toBe('POST');
    expect(point.blobs![1]).toBe('/submit');
    expect(point.blobs![2]).toBe('201');
  });

  it('uses "anonymous" when cf-connecting-ip header is absent', async () => {
    const mock = createMockAuditLog();
    const app = createApp({ AUDIT_LOG: mock.binding as unknown as AnalyticsEngineDataset });

    await app.request(getRequest('/hello'));

    expect(mock.points).toHaveLength(1);
    expect(mock.points[0]!.indexes).toEqual(['anonymous']);
  });
});
