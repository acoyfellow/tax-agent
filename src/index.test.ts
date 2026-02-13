import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_PAYER = {
  name: 'Acme Corp',
  tin: '27-1234567',
  address: '100 Main St',
  city: 'New York',
  state: 'NY',
  zip_code: '10001',
  phone: '2125551234',
  email: 'payroll@acme.com',
};

const VALID_RECIPIENT = {
  first_name: 'Jane',
  last_name: 'Smith',
  tin: '412789654',
  tin_type: 'SSN' as const,
  address: '200 Oak Ave',
  city: 'Austin',
  state: 'TX',
  zip_code: '78701',
};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    payer: VALID_PAYER,
    recipient: VALID_RECIPIENT,
    nonemployee_compensation: 5000.0,
    is_federal_tax_withheld: false,
    is_state_filing: false,
    tax_year: '2024',
    ...overrides,
  };
}

// Helper to get auth header (dev mode if TAX_AGENT_API_KEY not set)
function authHeader(): Record<string, string> {
  const key = (env as Record<string, string>).TAX_AGENT_API_KEY;
  if (key) return { Authorization: `Bearer ${key}` };
  return {};
}

// ---------------------------------------------------------------------------
// GET / — API overview
// ---------------------------------------------------------------------------
describe('GET /', () => {
  it('returns API overview with 200', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe('tax-agent');
    expect(body.version).toBe('2.0.0');
    expect(body.endpoints).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
describe('GET /health', () => {
  it('returns health check object', async () => {
    const res = await SELF.fetch('http://localhost/health');
    // May be 200 or 503 depending on env, but should always return JSON
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('checks');
    expect(typeof body.healthy).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------
describe('Not found', () => {
  it('returns 404 JSON for unknown routes', async () => {
    const res = await SELF.fetch('http://localhost/nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Not found');
  });
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
describe('Auth middleware', () => {
  it('rejects /validate without Bearer token when API key is set', async () => {
    const key = (env as Record<string, string>).TAX_AGENT_API_KEY;
    if (!key) return; // skip in dev mode

    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Unauthorized');
  });

  it('rejects /validate with wrong Bearer token', async () => {
    const key = (env as Record<string, string>).TAX_AGENT_API_KEY;
    if (!key) return; // skip in dev mode

    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token-here',
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /validate — Zod schema validation
// ---------------------------------------------------------------------------
describe('POST /validate — Zod validation', () => {
  it('rejects empty body', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid request body');
  });

  it('rejects non-JSON body', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing payer', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        recipient: VALID_RECIPIENT,
        nonemployee_compensation: 5000,
        is_federal_tax_withheld: false,
        is_state_filing: false,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid payer EIN format', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(
        validBody({
          payer: { ...VALID_PAYER, tin: '123456789' },
        }),
      ),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; details: unknown };
    expect(body.success).toBe(false);
  });

  it('rejects negative compensation', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody({ nonemployee_compensation: -100 })),
    });
    expect(res.status).toBe(400);
  });

  it('rejects zero compensation', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody({ nonemployee_compensation: 0 })),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid tax year format', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody({ tax_year: '24' })),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid tin_type', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(
        validBody({
          recipient: { ...VALID_RECIPIENT, tin_type: 'ITIN' },
        }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid business_type', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(
        validBody({
          payer: { ...VALID_PAYER, business_type: 'INVALID' },
        }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid kind_of_employer', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody({ kind_of_employer: 'INVALID' })),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid ZIP code', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(
        validBody({
          payer: { ...VALID_PAYER, zip_code: 'ABCDE' },
        }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it('accepts valid 9-digit ZIP', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(
        validBody({
          payer: { ...VALID_PAYER, zip_code: '10001-1234' },
        }),
      ),
    });
    // Should not be 400 (Zod should accept it)
    expect(res.status).not.toBe(400);
  });

  it('defaults business_type to LLC when not provided', async () => {
    // Valid body without business_type — should pass Zod with default
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody()),
    });
    // Should not be 400 (accepted with default)
    expect(res.status).not.toBe(400);
  });

  it('accepts valid business_type values', async () => {
    for (const bt of ['CORP', 'SCORP', 'PART', 'TRUST', 'LLC', 'EXEMPT', 'ESTE']) {
      const res = await SELF.fetch('http://localhost/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(
          validBody({
            payer: { ...VALID_PAYER, business_type: bt },
          }),
        ),
      });
      expect(res.status).not.toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /validate — Structural validation (via AI route, checks agent.ts)
// ---------------------------------------------------------------------------
describe('POST /validate — structural checks', () => {
  it('returns validation result for valid input', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody()),
    });
    // Might be 200 (success) or 500 (AI unavailable) but not 400
    expect(res.status).not.toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    // If AI is unavailable, it should still return structured response
    if (body.success) {
      const data = body.data as { valid: boolean; issues: unknown[]; ai_model: string };
      expect(data).toHaveProperty('valid');
      expect(data).toHaveProperty('issues');
      expect(data).toHaveProperty('ai_model');
    }
  });

  it('flags state filing without state as structural error', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody({ is_state_filing: true })),
    });
    const body = (await res.json()) as {
      success: boolean;
      data?: { valid: boolean; issues: Array<{ field: string; severity: string }> };
    };
    if (body.success && body.data) {
      expect(body.data.valid).toBe(false);
      const stateIssue = body.data.issues.find((i) => i.field === 'state');
      expect(stateIssue).toBeDefined();
      expect(stateIssue?.severity).toBe('error');
    }
  });

  it('warns when state filing without state_income', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(
        validBody({
          is_state_filing: true,
          state: 'CA',
        }),
      ),
    });
    const body = (await res.json()) as {
      success: boolean;
      data?: { issues: Array<{ field: string; severity: string }> };
    };
    if (body.success && body.data) {
      const incomeIssue = body.data.issues.find((i) => i.field === 'state_income');
      expect(incomeIssue).toBeDefined();
      expect(incomeIssue?.severity).toBe('warning');
    }
  });

  it('flags federal_tax_withheld=true but amount 0', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(
        validBody({
          is_federal_tax_withheld: true,
          federal_tax_withheld: 0,
        }),
      ),
    });
    const body = (await res.json()) as {
      success: boolean;
      data?: { valid: boolean; issues: Array<{ field: string; severity: string }> };
    };
    if (body.success && body.data) {
      expect(body.data.valid).toBe(false);
      const ftwIssue = body.data.issues.find((i) => i.field === 'federal_tax_withheld');
      expect(ftwIssue).toBeDefined();
      expect(ftwIssue?.severity).toBe('error');
    }
  });

  it('gives info for compensation under $600', async () => {
    const res = await SELF.fetch('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(validBody({ nonemployee_compensation: 100 })),
    });
    const body = (await res.json()) as {
      success: boolean;
      data?: { issues: Array<{ field: string; severity: string }> };
    };
    if (body.success && body.data) {
      const thresholdIssue = body.data.issues.find(
        (i) => i.field === 'nonemployee_compensation' && i.severity === 'info',
      );
      expect(thresholdIssue).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /transmit/:id — UUID validation
// ---------------------------------------------------------------------------
describe('POST /transmit/:id — UUID param validation', () => {
  it('rejects non-UUID submission ID', async () => {
    const res = await SELF.fetch('http://localhost/transmit/not-a-uuid', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('UUID');
  });
});

// ---------------------------------------------------------------------------
// GET /status/:id — UUID validation
// ---------------------------------------------------------------------------
describe('GET /status/:id — UUID param validation', () => {
  it('rejects non-UUID submission ID', async () => {
    const res = await SELF.fetch('http://localhost/status/bad-id', {
      headers: authHeader(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('UUID');
  });
});

// ---------------------------------------------------------------------------
// POST /file — Zod validation (same as /validate)
// ---------------------------------------------------------------------------
describe('POST /file — Zod validation', () => {
  it('rejects empty body', async () => {
    const res = await SELF.fetch('http://localhost/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing required fields', async () => {
    const res = await SELF.fetch('http://localhost/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ payer: VALID_PAYER }),
    });
    expect(res.status).toBe(400);
  });
});
