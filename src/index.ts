import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { Effect } from 'effect';
import type {
  Env,
  Form1099NECRequest,
  ApiResponse,
  ValidationResult,
  TaxBanditsCreateResponse,
  TaxBanditsTransmitResponse,
  TaxBanditsStatusResponse,
} from './types';
import { validateForm, runStructuralValidations } from './agent';
import { openApiSpec } from './openapi';
import {
  create1099NEC,
  createBatch1099NEC,
  transmit,
  getStatus,
  getAccessToken,
} from './taxbandits';
import { rateLimiter } from './ratelimit';
import { scrubTINs } from './pii';
import { auditLogger } from './audit';
import { verifyWebhookSignature, parseWebhookPayload } from './webhook';

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
app.use('*', auditLogger());
app.use('*', bodyLimit({ maxSize: 64 * 1024 })); // 64 KB

// Rate-limit POST endpoints (20 req/min per IP). GET routes are unlimited.
app.post('*', rateLimiter());

// API key auth on mutating routes. If TAX_AGENT_API_KEY is not set, routes are open (dev mode).
app.use('/validate', async (c, next) => {
  if (!c.env.TAX_AGENT_API_KEY) return next();
  return bearerAuth({ token: c.env.TAX_AGENT_API_KEY })(c, next);
});
app.use('/file', async (c, next) => {
  if (!c.env.TAX_AGENT_API_KEY) return next();
  return bearerAuth({ token: c.env.TAX_AGENT_API_KEY })(c, next);
});
app.use('/file/batch', async (c, next) => {
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
app.use('/webhook/submissions', async (c, next) => {
  if (!c.env.TAX_AGENT_API_KEY) return next();
  return bearerAuth({ token: c.env.TAX_AGENT_API_KEY })(c, next);
});
app.use('/webhook/submissions/*', async (c, next) => {
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

/** Build a fallback ValidationResult when AI is unavailable, preserving structural issues. */
function aiFallbackResult(data: Form1099NECRequest, errMessage: string): ValidationResult {
  const structuralIssues = runStructuralValidations(data);
  return {
    valid: false,
    issues: [
      ...structuralIssues,
      {
        field: 'ai_validation',
        message: `AI review unavailable: ${errMessage}. Retry later.`,
        severity: 'error',
      },
    ],
    summary: 'AI validation failed — cannot proceed without semantic review',
    ai_model: '@cf/zai-org/glm-4.7-flash (failed)',
  };
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
      'POST /file/batch': 'Validate + create multiple 1099-NECs in one submission (max 100)',
      'POST /transmit/:submissionId': 'Transmit a submission to the IRS',
      'GET /status/:submissionId': 'Check filing status',
      'GET /health': 'Service health check',
      'POST /webhook/status': 'TaxBandits webhook callback (HMAC verified)',
      'GET /webhook/submissions': 'List tracked submissions (Bearer auth)',
      'GET /webhook/submissions/:id': 'Get submission status (Bearer auth)',
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
      await Effect.runPromise(getAccessToken(c.env));
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

  const formData = parsed.data as Form1099NECRequest;
  const program = validateForm(c.env, formData).pipe(
    Effect.catchTag('AIValidationError', (err) =>
      Effect.succeed(aiFallbackResult(formData, err.message)),
    ),
  );
  const result = await Effect.runPromise(program);
  return c.json<ApiResponse<ValidationResult>>({ success: true, data: result });
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

  const validationProgram = validateForm(c.env, body).pipe(
    Effect.catchTag('AIValidationError', (err) =>
      Effect.succeed(aiFallbackResult(body, err.message)),
    ),
  );
  const validation = await Effect.runPromise(validationProgram);

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

  const filingProgram = create1099NEC(c.env, body).pipe(
    Effect.tap((created) =>
      Effect.promise(async () => {
        if (c.env.WEBHOOK_STATE && created.SubmissionId) {
          const stub = c.env.WEBHOOK_STATE.get(c.env.WEBHOOK_STATE.idFromName('global'));
          await stub.trackSubmission(created.SubmissionId, 'FORM1099NEC');
        }
      }),
    ),
    Effect.map((created) => {
      const responseBody: ApiResponse<{
        validation: ValidationResult;
        filing: TaxBanditsCreateResponse;
      }> = {
        success: true,
        data: { validation, filing: created },
      };
      return { status: 200 as const, body: responseBody };
    }),
    Effect.catchAll((err) =>
      Effect.succeed({
        status: 502 as const,
        body: {
          success: false,
          error: 'TaxBandits API call failed',
          details: {
            validation,
            taxbandits_error: scrubTINs(err.message),
          },
        } as ApiResponse<{ validation: ValidationResult }>,
      }),
    ),
  );
  const result = await Effect.runPromise(filingProgram);

  // Cache successful filing response for idempotency
  if (result.status === 200 && idempotencyKey && kv) {
    await kv.put(idempotencyKey, JSON.stringify({ status: 200, body: result.body }), {
      expirationTtl: IDEMPOTENCY_TTL,
    });
  }

  return c.json(result.body, result.status);
});

/** POST /file/batch — Validate + create multiple 1099-NECs in one TaxBandits submission. */
app.post('/file/batch', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const schema = z.object({ forms: z.array(Form1099NECSchema).min(1).max(100) });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Invalid request body', details: parsed.error.flatten() },
      400,
    );
  }
  const forms = parsed.data.forms as Form1099NECRequest[];

  // Validate all forms
  const validationProgram = Effect.forEach(
    forms,
    (f) =>
      validateForm(c.env, f).pipe(
        Effect.catchTag('AIValidationError', (err) =>
          Effect.succeed(aiFallbackResult(f, err.message)),
        ),
      ),
    { concurrency: 'unbounded' },
  );
  const validations = await Effect.runPromise(validationProgram);

  const failed = validations.filter((v) => !v.valid);
  if (failed.length > 0) {
    return c.json<ApiResponse<{ validations: ValidationResult[] }>>(
      {
        success: false,
        error: `${failed.length} of ${forms.length} forms failed validation`,
        details: { validations },
      },
      422,
    );
  }

  const filingProgram = createBatch1099NEC(c.env, forms).pipe(
    Effect.tap((created) =>
      Effect.promise(async () => {
        if (c.env.WEBHOOK_STATE && created.SubmissionId) {
          const stub = c.env.WEBHOOK_STATE.get(c.env.WEBHOOK_STATE.idFromName('global'));
          await stub.trackSubmission(created.SubmissionId, 'FORM1099NEC');
        }
      }),
    ),
    Effect.map((created) => ({
      status: 200 as const,
      body: {
        success: true,
        data: { validations, filing: created },
      } as ApiResponse<{ validations: ValidationResult[]; filing: TaxBanditsCreateResponse }>,
    })),
    Effect.catchAll((err) =>
      Effect.succeed({
        status: 502 as const,
        body: {
          success: false,
          error: 'TaxBandits API call failed',
          details: {
            validations,
            taxbandits_error: scrubTINs(err.message),
          },
        } as ApiResponse<{ validations: ValidationResult[] }>,
      }),
    ),
  );
  const result = await Effect.runPromise(filingProgram);
  return c.json(result.body, result.status);
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

  const program = transmit(c.env, idCheck.data).pipe(
    Effect.map((data) => ({
      status: 200 as const,
      body: { success: true, data } as ApiResponse<TaxBanditsTransmitResponse>,
    })),
    Effect.catchAll((err) =>
      Effect.succeed({
        status: 502 as const,
        body: {
          success: false,
          error: 'Transmit failed',
          details: scrubTINs(err.message),
        } as ApiResponse<never>,
      }),
    ),
  );
  const result = await Effect.runPromise(program);
  return c.json(result.body, result.status);
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

  const program = getStatus(c.env, idCheck.data).pipe(
    Effect.map((data) => ({
      status: 200 as const,
      body: { success: true, data } as ApiResponse<TaxBanditsStatusResponse>,
    })),
    Effect.catchAll((err) =>
      Effect.succeed({
        status: 502 as const,
        body: {
          success: false,
          error: 'Status check failed',
          details: scrubTINs(err.message),
        } as ApiResponse<never>,
      }),
    ),
  );
  const result = await Effect.runPromise(program);
  return c.json(result.body, result.status);
});

/** GET /openapi.json — OpenAPI 3.1 specification. */
app.get('/openapi.json', (c) => c.json(openApiSpec));

/** POST /webhook/status — TaxBandits e-file status webhook callback */
app.post('/webhook/status', async (c) => {
  const signature = c.req.header('Signature') ?? '';
  const timestamp = c.req.header('TimeStamp') ?? '';

  if (!signature || !timestamp) {
    return c.json({ success: false, error: 'Missing Signature or TimeStamp header' }, 401);
  }

  const isValid = await Effect.runPromise(
    verifyWebhookSignature(
      c.env.TAXBANDITS_CLIENT_ID,
      c.env.TAXBANDITS_CLIENT_SECRET,
      signature,
      timestamp,
    ),
  );

  if (!isValid) {
    return c.json({ success: false, error: 'Invalid webhook signature' }, 401);
  }

  const raw = await c.req.json().catch(() => null);
  const payload = parseWebhookPayload(raw);
  if (!payload) {
    return c.json({ success: false, error: 'Invalid webhook payload' }, 400);
  }

  // Persist to Durable Object
  if (c.env.WEBHOOK_STATE) {
    const stub = c.env.WEBHOOK_STATE.get(c.env.WEBHOOK_STATE.idFromName('global'));
    await stub.trackSubmission(payload.SubmissionId, payload.FormType);

    // Determine overall status from records
    const hasRejected = payload.Records.some((r) => r.Status === 'Rejected');
    const allAccepted = payload.Records.every((r) => r.Status === 'Accepted');
    const status = hasRejected ? 'REJECTED' : allAccepted ? 'ACCEPTED' : 'PARTIAL';

    await stub.updateStatus(payload.SubmissionId, status, JSON.stringify(payload.Records));
  }

  // Audit log
  if (c.env.AUDIT_LOG) {
    c.env.AUDIT_LOG.writeDataPoint({
      indexes: [payload.SubmissionId],
      blobs: ['webhook', payload.FormType, payload.Records[0]?.Status ?? 'unknown'],
      doubles: [payload.Records.length],
    });
  }

  return c.json({ success: true });
});

/** GET /webhook/submissions — List tracked submissions */
app.get('/webhook/submissions', async (c) => {
  if (!c.env.WEBHOOK_STATE) {
    return c.json({ success: false, error: 'Webhook state not configured' }, 503);
  }
  const stub = c.env.WEBHOOK_STATE.get(c.env.WEBHOOK_STATE.idFromName('global'));
  const submissions = await stub.listSubmissions();
  return c.json({ success: true, data: submissions });
});

/** GET /webhook/submissions/:submissionId — Get single submission status */
app.get('/webhook/submissions/:submissionId', async (c) => {
  if (!c.env.WEBHOOK_STATE) {
    return c.json({ success: false, error: 'Webhook state not configured' }, 503);
  }
  const submissionId = c.req.param('submissionId');
  const stub = c.env.WEBHOOK_STATE.get(c.env.WEBHOOK_STATE.idFromName('global'));
  const submission = await stub.getSubmission(submissionId);
  if (!submission) {
    return c.json({ success: false, error: 'Submission not found' }, 404);
  }
  return c.json({ success: true, data: submission });
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
  const safeMessage = scrubTINs(err instanceof Error ? err.message : String(err));
  console.error('Unhandled error:', safeMessage);
  return c.json<ApiResponse<never>>({ success: false, error: 'Internal server error' }, 500);
});

export default app;

export { WebhookState } from './webhook-state';
