// ---------------------------------------------------------------------------
// OpenAPI 3.1.0 specification for tax-agent
// ---------------------------------------------------------------------------

const errorResponse = {
  type: 'object',
  required: ['success', 'error'],
  properties: {
    success: { type: 'boolean', const: false },
    error: { type: 'string' },
    details: {},
  },
} as const;

const validationIssue = {
  type: 'object',
  required: ['field', 'message', 'severity'],
  properties: {
    field: { type: 'string' },
    message: { type: 'string' },
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
  },
} as const;

const validationResult = {
  type: 'object',
  required: ['valid', 'issues', 'summary', 'ai_model'],
  properties: {
    valid: { type: 'boolean' },
    issues: { type: 'array', items: validationIssue },
    summary: { type: 'string' },
    ai_model: { type: 'string' },
  },
} as const;

const taxBanditsError = {
  type: 'object',
  required: ['Id', 'Name', 'Message', 'Type'],
  properties: {
    Id: { type: 'string' },
    Name: { type: 'string' },
    Message: { type: 'string' },
    Type: { type: 'string' },
  },
} as const;

const taxBanditsFormRecord = {
  type: 'object',
  required: ['RecordId', 'RecordStatus', 'Sequence'],
  properties: {
    RecordId: { type: 'string' },
    RecordStatus: { type: 'string' },
    Sequence: { type: 'string' },
    Errors: {
      oneOf: [{ type: 'array', items: taxBanditsError }, { type: 'null' }],
    },
  },
} as const;

const payerSchema = {
  type: 'object',
  required: ['name', 'tin', 'address', 'city', 'state', 'zip_code', 'phone', 'email'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    tin: {
      type: 'string',
      minLength: 9,
      maxLength: 11,
      description: 'EIN: XX-XXXXXXX or SSN: 9 digits',
    },
    tin_type: { type: 'string', enum: ['EIN', 'SSN'], default: 'EIN' },
    address: { type: 'string', minLength: 1, maxLength: 200 },
    city: { type: 'string', minLength: 1, maxLength: 100 },
    state: { type: 'string', minLength: 2, maxLength: 2 },
    zip_code: { type: 'string', pattern: '^\\d{5}(-\\d{4})?$' },
    phone: { type: 'string', minLength: 10, maxLength: 15 },
    email: { type: 'string', format: 'email' },
    business_type: {
      type: 'string',
      enum: ['CORP', 'SCORP', 'PART', 'TRUST', 'LLC', 'EXEMPT', 'ESTE'],
      default: 'LLC',
    },
  },
} as const;

const recipientSchema = {
  type: 'object',
  required: ['first_name', 'last_name', 'tin', 'tin_type', 'address', 'city', 'state', 'zip_code'],
  properties: {
    first_name: { type: 'string', minLength: 1, maxLength: 100 },
    last_name: { type: 'string', minLength: 1, maxLength: 100 },
    tin: { type: 'string', minLength: 9, maxLength: 11 },
    tin_type: { type: 'string', enum: ['SSN', 'EIN'] },
    address: { type: 'string', minLength: 1, maxLength: 200 },
    city: { type: 'string', minLength: 1, maxLength: 100 },
    state: { type: 'string', minLength: 2, maxLength: 2 },
    zip_code: { type: 'string', pattern: '^\\d{5}(-\\d{4})?$' },
  },
} as const;

const form1099NECBody = {
  type: 'object',
  required: [
    'payer',
    'recipient',
    'nonemployee_compensation',
    'is_federal_tax_withheld',
    'is_state_filing',
  ],
  properties: {
    payer: payerSchema,
    recipient: recipientSchema,
    nonemployee_compensation: { type: 'number', exclusiveMinimum: 0 },
    is_federal_tax_withheld: { type: 'boolean' },
    federal_tax_withheld: { type: 'number', minimum: 0 },
    is_state_filing: { type: 'boolean' },
    state: { type: 'string', minLength: 2, maxLength: 2 },
    state_income: { type: 'number', minimum: 0 },
    state_tax_withheld: { type: 'number', minimum: 0 },
    tax_year: { type: 'string', pattern: '^\\d{4}$' },
    kind_of_employer: {
      type: 'string',
      enum: ['FEDERALGOVT', 'STATEGOVT', 'TRIBALGOVT', 'TAX_EXEMPT', 'NONEAPPLY'],
      default: 'NONEAPPLY',
    },
    kind_of_payer: {
      type: 'string',
      enum: ['REGULAR941', 'REGULAR944', 'AGRICULTURAL943', 'HOUSEHOLD', 'MILITARY', 'MEDICARE'],
      default: 'REGULAR941',
    },
  },
} as const;

const submissionIdParam = {
  name: 'submissionId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'TaxBandits submission UUID',
} as const;

export const openApiSpec: Record<string, unknown> = {
  openapi: '3.1.0',
  info: {
    title: 'Tax Agent API',
    version: '2.0.0',
    description:
      'AI-powered tax form agent — validates 1099-NEC data with Workers AI and files via TaxBandits.',
    license: { name: 'MIT' },
  },
  servers: [{ url: 'https://tax-agent.coey.dev' }],
  security: [{ BearerAuth: [] }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Set the TAX_AGENT_API_KEY secret. If unset the API runs in open dev mode.',
      },
    },
    schemas: {
      Payer: payerSchema,
      Recipient: recipientSchema,
      Form1099NECRequest: form1099NECBody,
      ValidationIssue: validationIssue,
      ValidationResult: validationResult,
      TaxBanditsError: taxBanditsError,
      TaxBanditsFormRecord: taxBanditsFormRecord,
      ErrorResponse: errorResponse,
    },
  },
  paths: {
    // ------------------------------------------------------------------ GET /
    '/': {
      get: {
        operationId: 'getRoot',
        summary: 'API overview',
        security: [],
        responses: {
          '200': {
            description: 'API metadata and available endpoints',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    version: { type: 'string' },
                    description: { type: 'string' },
                    endpoints: { type: 'object', additionalProperties: { type: 'string' } },
                    auth: { type: 'string' },
                    docs: { type: 'string', format: 'uri' },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ----------------------------------------------------------- GET /health
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Service health check',
        security: [],
        responses: {
          '200': {
            description: 'All checks passed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['healthy', 'checks'],
                  properties: {
                    healthy: { type: 'boolean' },
                    checks: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          '503': {
            description: 'One or more checks failed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['healthy', 'checks'],
                  properties: {
                    healthy: { type: 'boolean', const: false },
                    checks: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // -------------------------------------------------------- POST /validate
    '/validate': {
      post: {
        operationId: 'validateForm',
        summary: 'Validate 1099-NEC data with AI (does not file)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: form1099NECBody } },
        },
        responses: {
          '200': {
            description: 'Validation completed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'data'],
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: validationResult,
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid request body',
            content: { 'application/json': { schema: errorResponse } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: errorResponse } },
          },
          '500': {
            description: 'AI validation error',
            content: { 'application/json': { schema: errorResponse } },
          },
        },
      },
    },

    // ------------------------------------------------------------- POST /file
    '/file': {
      post: {
        operationId: 'fileForm',
        summary: 'Validate + create 1099-NEC in TaxBandits',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description:
              'Optional idempotency key. If provided (and IDEMPOTENCY_KV is bound), retries with the same key return the cached response for 24 h.',
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: form1099NECBody } },
        },
        responses: {
          '200': {
            description: 'Form validated and filed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'data'],
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      required: ['validation', 'filing'],
                      properties: {
                        validation: validationResult,
                        filing: {
                          type: 'object',
                          required: [
                            'StatusCode',
                            'StatusName',
                            'StatusMessage',
                            'SubmissionId',
                            'FormRecords',
                          ],
                          properties: {
                            StatusCode: { type: 'integer' },
                            StatusName: { type: 'string' },
                            StatusMessage: { type: 'string' },
                            SubmissionId: { type: 'string' },
                            FormRecords: { type: 'array', items: taxBanditsFormRecord },
                            Errors: {
                              oneOf: [{ type: 'array', items: taxBanditsError }, { type: 'null' }],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid request body',
            content: { 'application/json': { schema: errorResponse } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: errorResponse } },
          },
          '422': {
            description: 'AI validation found errors — fix before filing',
            content: { 'application/json': { schema: errorResponse } },
          },
          '502': {
            description: 'TaxBandits API call failed',
            content: { 'application/json': { schema: errorResponse } },
          },
        },
      },
    },

    // ------------------------------------------- POST /transmit/{submissionId}
    '/transmit/{submissionId}': {
      post: {
        operationId: 'transmitSubmission',
        summary: 'Transmit a submission to the IRS',
        parameters: [submissionIdParam],
        responses: {
          '200': {
            description: 'Submission transmitted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'data'],
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      required: ['StatusCode', 'StatusName', 'StatusMessage', 'SubmissionId'],
                      properties: {
                        StatusCode: { type: 'integer' },
                        StatusName: { type: 'string' },
                        StatusMessage: { type: 'string' },
                        SubmissionId: { type: 'string' },
                        Errors: {
                          oneOf: [{ type: 'array', items: taxBanditsError }, { type: 'null' }],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid submission ID',
            content: { 'application/json': { schema: errorResponse } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: errorResponse } },
          },
          '502': {
            description: 'TaxBandits transmit failed',
            content: { 'application/json': { schema: errorResponse } },
          },
        },
      },
    },

    // -------------------------------------------- GET /status/{submissionId}
    '/status/{submissionId}': {
      get: {
        operationId: 'getStatus',
        summary: 'Check filing status',
        parameters: [submissionIdParam],
        responses: {
          '200': {
            description: 'Status retrieved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'data'],
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      required: [
                        'StatusCode',
                        'StatusName',
                        'StatusMessage',
                        'SubmissionId',
                        'FormStatus',
                      ],
                      properties: {
                        StatusCode: { type: 'integer' },
                        StatusName: { type: 'string' },
                        StatusMessage: { type: 'string' },
                        SubmissionId: { type: 'string' },
                        FormStatus: { type: 'string' },
                        FormRecords: {
                          oneOf: [{ type: 'array', items: taxBanditsFormRecord }, { type: 'null' }],
                        },
                        Errors: {
                          oneOf: [{ type: 'array', items: taxBanditsError }, { type: 'null' }],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid submission ID',
            content: { 'application/json': { schema: errorResponse } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: errorResponse } },
          },
          '502': {
            description: 'TaxBandits status check failed',
            content: { 'application/json': { schema: errorResponse } },
          },
        },
      },
    },

    // --------------------------------------------------- GET /openapi.json
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'OpenAPI 3.1 specification',
        security: [],
        responses: {
          '200': {
            description: 'The OpenAPI specification document',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
};
