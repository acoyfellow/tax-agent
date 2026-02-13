import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type {
  Env,
  Form1099NECRequest,
  ApiResponse,
  ValidationResult,
  TaxBanditsCreateResponse,
  TaxBanditsTransmitResponse,
  TaxBanditsStatusResponse,
} from './types';
import { validateForm } from './agent';
import { create1099NEC, transmit, getStatus, getAccessToken } from './taxbandits';

// ---------------------------------------------------------------------------
// Zod schemas — runtime validation for POST bodies
// ---------------------------------------------------------------------------
const PayerSchema = z
  .object({
    name: z.string().min(1).max(200),
    tin: z.string().min(9).max(11),
    tin_type: z.enum(['EIN', 'SSN']).default('EIN'),
    address: z.string().min(1).max(200),
    city: z.string().min(1).max(100),
    state: z.string().length(2),
    zip_code: z.string().regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 5 or 9 digits'),
    phone: z.string().min(10).max(15),
    email: z.string().email(),
    business_type: z
      .enum(['CORP', 'SCORP', 'PART', 'TRUST', 'LLC', 'EXEMPT', 'ESTE'])
      .default('LLC'),
  })
  .refine(
    (p) => {
      if (p.tin_type === 'EIN') return /^\d{2}-\d{7}$/.test(p.tin);
      return /^\d{9}$/.test(p.tin.replace(/-/g, ''));
    },
    {
      message: 'EIN must be XX-XXXXXXX format; SSN must be 9 digits',
      path: ['tin'],
    },
  );

const RecipientSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  tin: z.string().min(9).max(11),
  tin_type: z.enum(['SSN', 'EIN']),
  address: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  state: z.string().length(2),
  zip_code: z.string().regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 5 or 9 digits'),
});

const Form1099NECSchema = z.object({
  payer: PayerSchema,
  recipient: RecipientSchema,
  nonemployee_compensation: z.number().positive().finite(),
  is_federal_tax_withheld: z.boolean(),
  federal_tax_withheld: z.number().nonnegative().finite().optional(),
  is_state_filing: z.boolean(),
  state: z.string().length(2).optional(),
  state_income: z.number().nonnegative().finite().optional(),
  state_tax_withheld: z.number().nonnegative().finite().optional(),
  tax_year: z
    .string()
    .regex(/^\d{4}$/, 'Must be 4-digit year')
    .optional(),
  kind_of_employer: z
    .enum(['FEDERALGOVT', 'STATEGOVT', 'TRIBALGOVT', 'TAX_EXEMPT', 'NONEAPPLY'])
    .default('NONEAPPLY'),
  kind_of_payer: z
    .enum(['REGULAR941', 'REGULAR944', 'AGRICULTURAL943', 'HOUSEHOLD', 'MILITARY', 'MEDICARE'])
    .default('REGULAR941'),
});

const SubmissionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Must be a UUID');

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use('*', cors());
app.use('*', bodyLimit({ maxSize: 64 * 1024 })); // 64 KB

// API key auth on mutating routes. If TAX_AGENT_API_KEY is not set, routes are open (dev mode).
app.use('/validate', async (c, next) => {
  if (!c.env.TAX_AGENT_API_KEY) return next();
  return bearerAuth({ token: c.env.TAX_AGENT_API_KEY })(c, next);
});
app.use('/file', async (c, next) => {
  if (!c.env.TAX_AGENT_API_KEY) return next();
  return bearerAuth({ token: c.env.TAX_AGENT_API_KEY })(c, next);
});
app.use('/transmit/*', async (c, next) => {
  if (!c.env.TAX_AGENT_API_KEY) return next();
  return bearerAuth({ token: c.env.TAX_AGENT_API_KEY })(c, next);
});
app.use('/status/*', async (c, next) => {
  if (!c.env.TAX_AGENT_API_KEY) return next();
  return bearerAuth({ token: c.env.TAX_AGENT_API_KEY })(c, next);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function parseBody(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null);
  return Form1099NECSchema.safeParse(raw);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET / — API overview. */
app.get('/', (c) => {
  return c.json({
    name: 'tax-agent',
    version: '2.0.0',
    description: 'AI-powered tax form agent — validates with Workers AI, files via TaxBandits',
    endpoints: {
      'POST /validate': 'Validate 1099-NEC data with AI (does not file)',
      'POST /file': 'Validate + create 1099-NEC in TaxBandits',
      'POST /transmit/:submissionId': 'Transmit a submission to the IRS',
      'GET /status/:submissionId': 'Check filing status',
      'GET /health': 'Service health check',
    },
    auth: 'Bearer token required on mutating routes (set TAX_AGENT_API_KEY secret)',
    docs: 'https://github.com/acoyfellow/tax-agent',
  });
});

/** GET /health — Verifies AI binding and TaxBandits credentials. */
app.get('/health', async (c) => {
  const checks: Record<string, string> = {};

  checks['workers_ai'] = c.env.AI ? 'available' : 'missing';

  const hasCreds =
    c.env.TAXBANDITS_CLIENT_ID && c.env.TAXBANDITS_CLIENT_SECRET && c.env.TAXBANDITS_USER_TOKEN;
  checks['taxbandits_credentials'] = hasCreds ? 'configured' : 'missing';

  if (hasCreds) {
    try {
      await getAccessToken(c.env);
      checks['taxbandits_oauth'] = 'authenticated';
    } catch (err) {
      checks['taxbandits_oauth'] = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  checks['taxbandits_env'] = c.env.TAXBANDITS_ENV ?? 'sandbox';
  checks['auth'] = c.env.TAX_AGENT_API_KEY ? 'enabled' : 'disabled (dev mode)';

  const healthy =
    checks['workers_ai'] === 'available' && checks['taxbandits_oauth'] === 'authenticated';
  return c.json({ healthy, checks }, healthy ? 200 : 503);
});

/** POST /validate — AI validation only, nothing sent to TaxBandits. */
app.post('/validate', async (c) => {
  const parsed = await parseBody(c);
  if (!parsed.success) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Invalid request body', details: parsed.error.flatten() },
      400,
    );
  }

  try {
    const result = await validateForm(c.env, parsed.data as Form1099NECRequest);
    return c.json<ApiResponse<ValidationResult>>({ success: true, data: result });
  } catch (err) {
    return c.json<ApiResponse<never>>(
      {
        success: false,
        error: 'Validation failed',
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

/** Idempotency key TTL: 24 hours (in seconds). */
const IDEMPOTENCY_TTL = 86_400;

/** POST /file — Validate → create 1099-NEC in TaxBandits. */
app.post('/file', async (c) => {
  // Idempotency: if an Idempotency-Key header is provided and IDEMPOTENCY_KV is bound,
  // return a cached response on retry instead of creating a duplicate filing.
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || null;
  const kv = c.env.IDEMPOTENCY_KV;

  if (idempotencyKey && kv) {
    const cached = await kv.get(idempotencyKey, 'text');
    if (cached) {
      const parsed = JSON.parse(cached) as { status: number; body: unknown };
      return c.json(parsed.body, parsed.status as 200 | 422 | 502);
    }
  }

  const parsed = await parseBody(c);
  if (!parsed.success) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Invalid request body', details: parsed.error.flatten() },
      400,
    );
  }
  const body = parsed.data as Form1099NECRequest;

  const validation = await validateForm(c.env, body);
  if (!validation.valid) {
    return c.json<ApiResponse<{ validation: ValidationResult }>>(
      {
        success: false,
        error: 'Validation failed — fix issues before filing',
        details: { validation },
      },
      422,
    );
  }

  try {
    const created = await create1099NEC(c.env, body);
    const responseBody: ApiResponse<{
      validation: ValidationResult;
      filing: TaxBanditsCreateResponse;
    }> = {
      success: true,
      data: { validation, filing: created },
    };

    // Cache successful filing response for idempotency
    if (idempotencyKey && kv) {
      await kv.put(idempotencyKey, JSON.stringify({ status: 200, body: responseBody }), {
        expirationTtl: IDEMPOTENCY_TTL,
      });
    }

    return c.json(responseBody);
  } catch (err) {
    return c.json<ApiResponse<{ validation: ValidationResult }>>(
      {
        success: false,
        error: 'TaxBandits API call failed',
        details: { validation, taxbandits_error: err instanceof Error ? err.message : String(err) },
      },
      502,
    );
  }
});

/** POST /transmit/:submissionId — Transmit to the IRS. */
app.post('/transmit/:submissionId', async (c) => {
  const idCheck = SubmissionIdSchema.safeParse(c.req.param('submissionId'));
  if (!idCheck.success) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Invalid submission ID — must be a UUID' },
      400,
    );
  }

  try {
    const result = await transmit(c.env, idCheck.data);
    return c.json<ApiResponse<TaxBanditsTransmitResponse>>({ success: true, data: result });
  } catch (err) {
    return c.json<ApiResponse<never>>(
      {
        success: false,
        error: 'Transmit failed',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

/** GET /status/:submissionId — Check filing status. */
app.get('/status/:submissionId', async (c) => {
  const idCheck = SubmissionIdSchema.safeParse(c.req.param('submissionId'));
  if (!idCheck.success) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Invalid submission ID — must be a UUID' },
      400,
    );
  }

  try {
    const status = await getStatus(c.env, idCheck.data);
    return c.json<ApiResponse<TaxBanditsStatusResponse>>({ success: true, data: status });
  } catch (err) {
    return c.json<ApiResponse<never>>(
      {
        success: false,
        error: 'Status check failed',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

// ---------------------------------------------------------------------------
// 404 / Error
// ---------------------------------------------------------------------------
app.notFound((c) => {
  return c.json<ApiResponse<never>>(
    { success: false, error: `Not found: ${c.req.method} ${c.req.path}` },
    404,
  );
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const status = err.status;
    const message = status === 401 ? 'Unauthorized: invalid or missing Bearer token' : err.message;
    return c.json<ApiResponse<never>>({ success: false, error: message }, status);
  }
  console.error('Unhandled error:', err);
  return c.json<ApiResponse<never>>({ success: false, error: 'Internal server error' }, 500);
});

export default app;
