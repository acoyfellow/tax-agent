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
// JWS / OAuth
// ============================================================

/** Base64url encode a string (no padding). */
function base64url(input: string): string {
  return btoa(input).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Base64url encode raw bytes. */
function base64urlBytes(bytes: Uint8Array): string {
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
async function buildJWS(
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
export async function getAccessToken(env: Env): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const jws = await buildJWS(
    env.TAXBANDITS_CLIENT_ID,
    env.TAXBANDITS_CLIENT_SECRET,
    env.TAXBANDITS_USER_TOKEN,
  );

  const response = await fetch(getOAuthUrl(env), {
    method: 'GET',
    headers: { Authentication: jws },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as TaxBanditsTokenResponse;
  if (data.StatusCode !== 200) {
    throw new Error(`OAuth error: ${data.StatusMessage} ${JSON.stringify(data.Errors)}`);
  }

  tokenCache = {
    token: data.AccessToken,
    expiresAt: Date.now() + data.ExpiresIn * 1000 - TOKEN_BUFFER_MS,
  };

  return data.AccessToken;
}

// ============================================================
// API helpers
// ============================================================

async function apiCall<T extends { StatusCode?: number; Errors?: TaxBanditsError[] | null }>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken(env);

  const response = await fetch(`${getBaseUrl(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TaxBandits API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as T;

  // TaxBandits can return HTTP 200 with business-level errors
  if (data.StatusCode && data.StatusCode >= 400) {
    const msgs = (data.Errors ?? []).map((e) => `${e.Id}: ${e.Message}`).join('; ');
    throw new Error(`TaxBandits error (${data.StatusCode}): ${msgs || 'Unknown error'}`);
  }

  return data;
}

// ============================================================
// Transform our types → TaxBandits API format
// ============================================================

function buildCreateRequest(data: Form1099NECRequest): TaxBanditsCreateRequest {
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
        IsEIN: true,
        BusinessType: data.payer.business_type ?? 'LLC',
        Phone: data.payer.phone.replace(/\D/g, ''),
        Email: data.payer.email,
        KindOfEmployer: data.kind_of_employer ?? 'NONEAPPLY',
        KindOfPayer: data.kind_of_payer ?? 'REGULAR941',
        IsBusinessTerminated: false,
        IsForeignAddress: false,
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
      },
    ],
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Create a 1099-NEC form in TaxBandits.
 * Returns a SubmissionId + RecordId for tracking.
 */
export async function create1099NEC(
  env: Env,
  data: Form1099NECRequest,
): Promise<TaxBanditsCreateResponse> {
  const body = buildCreateRequest(data);
  return apiCall<TaxBanditsCreateResponse>(env, 'POST', '/Form1099NEC/Create', body);
}

/**
 * Transmit a submission to the IRS.
 */
export async function transmit(
  env: Env,
  submissionId: string,
): Promise<TaxBanditsTransmitResponse> {
  return apiCall<TaxBanditsTransmitResponse>(env, 'POST', '/Form1099NEC/Transmit', {
    SubmissionId: submissionId,
  });
}

/**
 * Check the filing status of a submission.
 */
export async function getStatus(env: Env, submissionId: string): Promise<TaxBanditsStatusResponse> {
  return apiCall<TaxBanditsStatusResponse>(
    env,
    'GET',
    `/Form1099NEC/Status?SubmissionId=${encodeURIComponent(submissionId)}`,
  );
}
