import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, TaxFilingRequest, ApiResponse, ValidationResult, ColumnTaxInitResponse } from './types';
import { validateTaxData } from './agent';
import { initializeTaxFiling, getTaxReturnStatus } from './column-tax';

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
 * Health check + API overview.
 */
app.get('/', (c) => {
  return c.json({
    name: 'tax-agent',
    version: '1.0.0',
    description: 'AI-powered tax filing agent — validates data with Workers AI, files via Column Tax',
    endpoints: {
      'POST /validate': 'Validate tax data with AI (does not file)',
      'POST /file': 'Validate + initialize tax filing with Column Tax',
      'GET /status/:userId': 'Check filing status for a user',
      'GET /health': 'Service health check',
    },
    docs: 'https://github.com/acoyfellow/tax-agent',
  });
});

/**
 * GET /health
 * Quick health check — verifies AI binding is available.
 */
app.get('/health', async (c) => {
  const checks: Record<string, string> = {};

  // Check AI binding
  try {
    checks['workers_ai'] = c.env.AI ? 'available' : 'missing';
  } catch {
    checks['workers_ai'] = 'error';
  }

  // Check Column Tax credentials (existence only, don't call the API)
  checks['column_tax_credentials'] =
    c.env.COLUMN_TAX_CLIENT_ID && c.env.COLUMN_TAX_CLIENT_SECRET
      ? 'configured'
      : 'missing — set via wrangler secret put';

  checks['column_tax_env'] = c.env.COLUMN_TAX_ENV ?? 'not set';

  const healthy = checks['workers_ai'] === 'available';
  return c.json({ healthy, checks }, healthy ? 200 : 503);
});

/**
 * POST /validate
 * Validate tax filing data using structural checks + Workers AI.
 * Does NOT send anything to Column Tax.
 */
app.post('/validate', async (c) => {
  let body: TaxFilingRequest;
  try {
    body = await c.req.json<TaxFilingRequest>();
  } catch {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Invalid JSON body' },
      400,
    );
  }

  // Basic shape check
  if (!body.taxpayer || !body.address) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Missing required fields: taxpayer, address' },
      400,
    );
  }

  try {
    const result = await validateTaxData(c.env, body);
    return c.json<ApiResponse<ValidationResult>>({
      success: true,
      data: result,
    });
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
 * Full flow: validate with AI → if valid, initialize filing with Column Tax.
 * Returns the Column Tax user_url to open their tax prep UI.
 */
app.post('/file', async (c) => {
  let body: TaxFilingRequest;
  try {
    body = await c.req.json<TaxFilingRequest>();
  } catch {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Invalid JSON body' },
      400,
    );
  }

  if (!body.taxpayer || !body.address) {
    return c.json<ApiResponse<never>>(
      { success: false, error: 'Missing required fields: taxpayer, address' },
      400,
    );
  }

  // Step 1: Validate
  const validation = await validateTaxData(c.env, body);
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

  // Step 2: Initialize Column Tax filing
  try {
    const filing = await initializeTaxFiling(c.env, body);

    return c.json<ApiResponse<{ validation: ValidationResult; filing: ColumnTaxInitResponse }>>({
      success: true,
      data: { validation, filing },
    });
  } catch (err) {
    return c.json<ApiResponse<{ validation: ValidationResult }>>(
      {
        success: false,
        error: 'Column Tax API call failed',
        details: {
          validation,
          column_tax_error: err instanceof Error ? err.message : String(err),
        },
      },
      502,
    );
  }
});

/**
 * GET /status/:userId
 * Check the filing status for a given user.
 */
app.get('/status/:userId', async (c) => {
  const userId = c.req.param('userId');

  try {
    const status = await getTaxReturnStatus(c.env, userId);
    return c.json<ApiResponse<typeof status>>({
      success: true,
      data: status,
    });
  } catch (err) {
    return c.json<ApiResponse<never>>(
      {
        success: false,
        error: 'Failed to fetch status',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------
app.notFound((c) => {
  return c.json<ApiResponse<never>>(
    { success: false, error: `Not found: ${c.req.method} ${c.req.path}` },
    404,
  );
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json<ApiResponse<never>>(
    { success: false, error: 'Internal server error' },
    500,
  );
});

export default app;
