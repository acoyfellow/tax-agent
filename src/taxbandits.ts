import type {
  Env,
  Form1099NECRequest,
  TaxBanditsError,
  TaxBanditsTokenResponse,
  TaxBanditsCreateRequest,
  TaxBanditsCreateResponse,
  TaxBanditsTransmitResponse,
  TaxBanditsStatusResponse,
} from './types';
import { TaxBanditsAuthError, TaxBanditsTransientError, TaxBanditsBusinessError } from './types';
import { Effect, Schedule } from 'effect';

// ============================================================
// Config
// ============================================================

const API_VERSION = 'v1.7.3';
const SANDBOX_API = `https://testapi.taxbandits.com/${API_VERSION}`;
const SANDBOX_OAUTH = 'https://testoauth.expressauth.net/v2/tbsauth';
const PROD_API = `https://api.taxbandits.com/${API_VERSION}`;
const PROD_OAUTH = 'https://oauth.expressauth.net/v2/tbsauth';

// Token cache — survives within a single Worker isolate.
// Workers may share isolates across requests, so this avoids
// re-authenticating on every call. Tokens expire in 3600s;
// we refresh at 3300s (5 min buffer) to avoid edge-case expiry.
let tokenCache: { token: string; expiresAt: number } | null = null;
const TOKEN_BUFFER_MS = 300_000; // refresh 5 min before expiry

function getBaseUrl(env: Env): string {
  return env.TAXBANDITS_ENV === 'production' ? PROD_API : SANDBOX_API;
}

function getOAuthUrl(env: Env): string {
  return env.TAXBANDITS_ENV === 'production' ? PROD_OAUTH : SANDBOX_OAUTH;
}

// ============================================================
// Effect retry & error helpers
// ============================================================

interface TaxBanditsResponse {
  StatusCode?: number;
  Errors?: TaxBanditsError[] | null;
}

const retryPolicy = Schedule.exponential('500 millis').pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.jittered,
);

function classifyHttpError(
  status: number,
  body: string,
): TaxBanditsAuthError | TaxBanditsTransientError {
  if (status === 401 || status === 403) {
    return new TaxBanditsAuthError({ message: `Auth failed (${status}): ${body}` });
  }
  return new TaxBanditsTransientError({ status, message: `HTTP ${status}: ${body}` });
}

// ============================================================
// JWS / OAuth
// ============================================================

/** Base64url encode a string (no padding). */
export function base64url(input: string): string {
  return btoa(input).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Base64url encode raw bytes. */
export function base64urlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Build a JWS token signed with HMAC-SHA256.
 * TaxBandits uses this instead of standard OAuth2 client_credentials.
 */
export async function buildJWS(
  clientId: string,
  clientSecret: string,
  userToken: string,
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: clientId,
      sub: clientId,
      aud: userToken,
      iat: Math.floor(Date.now() / 1000),
    }),
  );

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  const sig = base64urlBytes(new Uint8Array(signature));

  return `${header}.${payload}.${sig}`;
}

/**
 * Get an access token from TaxBandits OAuth.
 * Caches within the Worker isolate; re-fetches 5 min before expiry.
 *
 * Note: header is "Authentication" (not "Authorization") and method is GET.
 * See: https://developer.taxbandits.com/docs/oauth2.0authentication/
 */
export function getAccessToken(
  env: Env,
): Effect.Effect<string, TaxBanditsAuthError | TaxBanditsTransientError> {
  return Effect.gen(function* () {
    if (tokenCache && Date.now() < tokenCache.expiresAt) {
      return tokenCache.token;
    }

    const jws = yield* Effect.tryPromise({
      try: () =>
        buildJWS(env.TAXBANDITS_CLIENT_ID, env.TAXBANDITS_CLIENT_SECRET, env.TAXBANDITS_USER_TOKEN),
      catch: (e) =>
        new TaxBanditsTransientError({
          status: 0,
          message: `JWS build failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(getOAuthUrl(env), {
          method: 'GET',
          headers: { Authentication: jws },
        }),
      catch: (e) =>
        new TaxBanditsTransientError({
          status: 0,
          message: `OAuth fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    if (!response.ok) {
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          new TaxBanditsTransientError({
            status: response.status,
            message: `Failed to read OAuth error body`,
          }),
      });
      return yield* Effect.fail(classifyHttpError(response.status, text));
    }

    const data = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new TaxBanditsTransientError({ status: 0, message: 'Failed to parse OAuth JSON' }),
    })) as TaxBanditsTokenResponse;

    if (data.StatusCode !== 200) {
      return yield* Effect.fail(
        new TaxBanditsAuthError({
          message: `OAuth error: ${data.StatusMessage} ${JSON.stringify(data.Errors)}`,
        }),
      );
    }

    tokenCache = {
      token: data.AccessToken,
      expiresAt: Date.now() + data.ExpiresIn * 1000 - TOKEN_BUFFER_MS,
    };

    return data.AccessToken;
  }).pipe(
    Effect.retry({
      schedule: retryPolicy,
      while: (e) => e._tag === 'TaxBanditsTransientError',
    }),
  );
}

// ============================================================
// API helpers
// ============================================================

function apiCall<T extends TaxBanditsResponse>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<T, TaxBanditsAuthError | TaxBanditsTransientError | TaxBanditsBusinessError> {
  return Effect.gen(function* () {
    const token = yield* getAccessToken(env);

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${getBaseUrl(env)}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      catch: (e) =>
        new TaxBanditsTransientError({
          status: 0,
          message: `API fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    if (!response.ok) {
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          new TaxBanditsTransientError({
            status: response.status,
            message: 'Failed to read API error body',
          }),
      });
      return yield* Effect.fail(classifyHttpError(response.status, text));
    }

    const data = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new TaxBanditsTransientError({ status: 0, message: 'Failed to parse API JSON' }),
    })) as T;

    // TaxBandits can return HTTP 200 with business-level errors
    if (data.StatusCode && data.StatusCode >= 400) {
      return yield* Effect.fail(
        new TaxBanditsBusinessError({ statusCode: data.StatusCode, errors: data.Errors ?? [] }),
      );
    }

    return data;
  }).pipe(
    Effect.retry({
      schedule: retryPolicy,
      while: (e) => e._tag === 'TaxBanditsTransientError',
    }),
  );
}

// ============================================================
// Transform our types → TaxBandits API format
// ============================================================

export function buildCreateRequest(data: Form1099NECRequest): TaxBanditsCreateRequest {
  const taxYear = data.tax_year ?? new Date().getFullYear().toString();

  return {
    SubmissionManifest: {
      TaxYear: taxYear,
      IsFederalFiling: true,
      IsStateFiling: data.is_state_filing,
      IsPostal: false,
      IsOnlineAccess: false,
    },
    ReturnHeader: {
      Business: {
        BusinessNm: data.payer.name,
        EINorSSN: data.payer.tin.replace(/-/g, ''),
        IsEIN: (data.payer.tin_type ?? 'EIN') === 'EIN',
        BusinessType: data.payer.business_type ?? 'LLC',
        Phone: data.payer.phone.replace(/\D/g, ''),
        Email: data.payer.email,
        KindOfEmployer: data.kind_of_employer ?? 'NONEAPPLY',
        KindOfPayer: data.kind_of_payer ?? 'REGULAR941',
        IsBusinessTerminated: false,
        IsForeignAddress: false, // TODO: support foreign addresses (see README known limitations)
        USAddress: {
          Address1: data.payer.address,
          City: data.payer.city,
          State: data.payer.state,
          ZipCd: data.payer.zip_code,
        },
      },
    },
    ReturnData: [
      {
        SequenceId: `seq-${crypto.randomUUID().slice(0, 8)}`,
        Recipient: {
          TINType: data.recipient.tin_type,
          TIN: data.recipient.tin.replace(/-/g, ''),
          FirstPayeeNm: `${data.recipient.first_name} ${data.recipient.last_name}`,
          IsForeignAddress: false, // TODO: support foreign addresses (see README known limitations)
          USAddress: {
            Address1: data.recipient.address,
            City: data.recipient.city,
            State: data.recipient.state,
            ZipCd: data.recipient.zip_code,
          },
        },
        NECFormData: {
          B1NEC: data.nonemployee_compensation.toFixed(2),
          B4FedTaxWH: data.is_federal_tax_withheld
            ? (data.federal_tax_withheld ?? 0).toFixed(2)
            : undefined,
          Is2ndTINnot: false,
          IsDirectSales: false,
          ...(data.is_state_filing && data.state
            ? {
                States: [
                  {
                    StateCd: data.state,
                    StateIncome: (data.state_income ?? data.nonemployee_compensation).toFixed(2),
                    StateTaxWithheld: (data.state_tax_withheld ?? 0).toFixed(2),
                  },
                ],
              }
            : {}),
        },
      },
    ],
  };
}

/**
 * Build a TaxBandits create request for multiple recipients (batch filing).
 * All recipients share the same payer, tax year, and filing options.
 */
export function buildBatchCreateRequest(forms: Form1099NECRequest[]): TaxBanditsCreateRequest {
  const first = forms[0];
  if (!first) throw new Error('At least one form is required');

  const taxYear = first.tax_year ?? new Date().getFullYear().toString();
  const hasStateFiling = forms.some((f) => f.is_state_filing);

  return {
    SubmissionManifest: {
      TaxYear: taxYear,
      IsFederalFiling: true,
      IsStateFiling: hasStateFiling,
      IsPostal: false,
      IsOnlineAccess: false,
    },
    ReturnHeader: {
      Business: {
        BusinessNm: first.payer.name,
        EINorSSN: first.payer.tin.replace(/-/g, ''),
        IsEIN: (first.payer.tin_type ?? 'EIN') === 'EIN',
        BusinessType: first.payer.business_type ?? 'LLC',
        Phone: first.payer.phone.replace(/\D/g, ''),
        Email: first.payer.email,
        KindOfEmployer: first.kind_of_employer ?? 'NONEAPPLY',
        KindOfPayer: first.kind_of_payer ?? 'REGULAR941',
        IsBusinessTerminated: false,
        IsForeignAddress: false,
        USAddress: {
          Address1: first.payer.address,
          City: first.payer.city,
          State: first.payer.state,
          ZipCd: first.payer.zip_code,
        },
      },
    },
    ReturnData: forms.map((data) => ({
      SequenceId: `seq-${crypto.randomUUID().slice(0, 8)}`,
      Recipient: {
        TINType: data.recipient.tin_type,
        TIN: data.recipient.tin.replace(/-/g, ''),
        FirstPayeeNm: `${data.recipient.first_name} ${data.recipient.last_name}`,
        IsForeignAddress: false,
        USAddress: {
          Address1: data.recipient.address,
          City: data.recipient.city,
          State: data.recipient.state,
          ZipCd: data.recipient.zip_code,
        },
      },
      NECFormData: {
        B1NEC: data.nonemployee_compensation.toFixed(2),
        B4FedTaxWH: data.is_federal_tax_withheld
          ? (data.federal_tax_withheld ?? 0).toFixed(2)
          : undefined,
        Is2ndTINnot: false,
        IsDirectSales: false,
        ...(data.is_state_filing && data.state
          ? {
              States: [
                {
                  StateCd: data.state,
                  StateIncome: (data.state_income ?? data.nonemployee_compensation).toFixed(2),
                  StateTaxWithheld: (data.state_tax_withheld ?? 0).toFixed(2),
                },
              ],
            }
          : {}),
      },
    })),
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Create a 1099-NEC form in TaxBandits.
 * Returns a SubmissionId + RecordId for tracking.
 */
export function create1099NEC(env: Env, data: Form1099NECRequest) {
  const body = buildCreateRequest(data);
  return apiCall<TaxBanditsCreateResponse>(env, 'POST', '/Form1099NEC/Create', body);
}

/**
 * Create multiple 1099-NEC forms in a single TaxBandits submission.
 * All forms must share the same payer. Max 100 per batch.
 */
export function createBatch1099NEC(env: Env, forms: Form1099NECRequest[]) {
  const body = buildBatchCreateRequest(forms);
  return apiCall<TaxBanditsCreateResponse>(env, 'POST', '/Form1099NEC/Create', body);
}

/**
 * Transmit a submission to the IRS.
 */
export function transmit(env: Env, submissionId: string) {
  return apiCall<TaxBanditsTransmitResponse>(env, 'POST', '/Form1099NEC/Transmit', {
    SubmissionId: submissionId,
  });
}

/**
 * Check the filing status of a submission.
 */
export function getStatus(env: Env, submissionId: string) {
  return apiCall<TaxBanditsStatusResponse>(
    env,
    'GET',
    `/Form1099NEC/Status?SubmissionId=${encodeURIComponent(submissionId)}`,
  );
}
