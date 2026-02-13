import { Hono } from 'hono';
import { cors } from 'hono/cors';
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

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use('*', cors());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /
 * API overview.
 */
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
    docs: 'https://github.com/acoyfellow/tax-agent',
  });
});

/**
 * GET /health
 * Verifies AI binding and TaxBandits credentials.
 */
app.get('/health', async (c) => {
  const checks: Record<string, string> = {};

  // AI binding
  checks['workers_ai'] = c.env.AI ? 'available' : 'missing';

  // TaxBandits credentials
  const hasCreds =
    c.env.TAXBANDITS_CLIENT_ID && c.env.TAXBANDITS_CLIENT_SECRET && c.env.TAXBANDITS_USER_TOKEN;
  checks['taxbandits_credentials'] = hasCreds ? 'configured' : 'missing';

  // Test TaxBandits OAuth
  if (hasCreds) {
    try {
      await getAccessToken(c.env);
      checks['taxbandits_oauth'] = 'authenticated';
    } catch (err) {
      checks['taxbandits_oauth'] = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  checks['taxbandits_env'] = c.env.TAXBANDITS_ENV ?? 'sandbox';

  const healthy =
    checks['workers_ai'] === 'available' && checks['taxbandits_oauth'] === 'authenticated';
  return c.json({ healthy, checks }, healthy ? 200 : 503);
});

/**
 * POST /validate
 * Validate 1099-NEC data with structural checks + Workers AI.
 * Does NOT create anything in TaxBandits.
 */
app.post('/validate', async (c) => {
  let body: Form1099NECRequest;
  try {
    body = await c.req.json<Form1099NECRequest>();
  } catch {
    return c.json<ApiResponse<never>>({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.payer || !body.recipient) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Missing required fields: payer, recipient' },
      400,
    );
  }

  try {
    const result = await validateForm(c.env, body);
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

/**
 * POST /file
 * Validate → create 1099-NEC in TaxBandits.
 * Returns SubmissionId + RecordId for tracking.
 */
app.post('/file', async (c) => {
  let body: Form1099NECRequest;
  try {
    body = await c.req.json<Form1099NECRequest>();
  } catch {
    return c.json<ApiResponse<never>>({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.payer || !body.recipient) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Missing required fields: payer, recipient' },
      400,
    );
  }

  // Step 1: Validate
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

  // Step 2: Create in TaxBandits
  try {
    const created = await create1099NEC(c.env, body);
    return c.json<ApiResponse<{ validation: ValidationResult; filing: TaxBanditsCreateResponse }>>({
      success: true,
      data: { validation, filing: created },
    });
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

/**
 * POST /transmit/:submissionId
 * Transmit a created submission to the IRS.
 */
app.post('/transmit/:submissionId', async (c) => {
  const submissionId = c.req.param('submissionId');

  try {
    const result = await transmit(c.env, submissionId);
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

/**
 * GET /status/:submissionId
 * Check the filing status of a submission.
 */
app.get('/status/:submissionId', async (c) => {
  const submissionId = c.req.param('submissionId');

  try {
    const status = await getStatus(c.env, submissionId);
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
  console.error('Unhandled error:', err);
  return c.json<ApiResponse<never>>({ success: false, error: 'Internal server error' }, 500);
});

export default app;
