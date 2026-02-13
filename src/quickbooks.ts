import { Effect, Schedule, Data } from 'effect';
import type { Env, Form1099NECRequest } from './types';

// ============================================================
// QuickBooks Error Types — typed error channel
// ============================================================

export class QBAuthError extends Data.TaggedError('QBAuthError')<{
  readonly message: string;
}> {}

export class QBTransientError extends Data.TaggedError('QBTransientError')<{
  readonly status: number;
  readonly message: string;
}> {}

export class QBBusinessError extends Data.TaggedError('QBBusinessError')<{
  readonly message: string;
  readonly detail?: unknown;
}> {}

// ============================================================
// QuickBooks API Types
// ============================================================

export interface QBVendor {
  Id: string;
  DisplayName: string;
  GivenName?: string;
  FamilyName?: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  BillAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
  };
  TaxIdentifier?: string; // last 4 only from QB
  Vendor1099: boolean;
  Active: boolean;
}

export interface QBVendor1099Row {
  vendorId: string;
  vendorName: string;
  tin: string; // last 4 from QB — full TIN must come from W-9
  nec: number; // Box 1: nonemployee compensation total
}

interface QBQueryResponse<T> {
  QueryResponse: {
    [key: string]: T[] | undefined;
    startPosition?: never;
    maxResults?: never;
  };
}

interface QBReportResponse {
  Header: { ReportName: string };
  Columns: { Column: Array<{ ColTitle: string; ColType: string }> };
  Rows: {
    Row?: Array<{
      ColData: Array<{ value: string; id?: string }>;
      type?: string;
    }>;
  };
}

// ============================================================
// Token management — reads/writes via D1 account table
// ============================================================

export interface QBTokens {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  expiresAt: Date;
}

/** Read QB tokens for a user from the better-auth account table. */
export function getQBTokens(db: D1Database, userId: string): Effect.Effect<QBTokens, QBAuthError> {
  return Effect.tryPromise({
    try: async () => {
      const row = await db
        .prepare(
          'SELECT accessToken, refreshToken, accountId, accessTokenExpiresAt FROM account WHERE userId = ? AND providerId = ?',
        )
        .bind(userId, 'quickbooks')
        .first<{
          accessToken: string | null;
          refreshToken: string | null;
          accountId: string;
          accessTokenExpiresAt: string | null;
        }>();
      if (!row?.accessToken || !row.refreshToken) {
        throw new Error('No QuickBooks connection found');
      }
      return {
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        realmId: row.accountId,
        expiresAt: row.accessTokenExpiresAt ? new Date(row.accessTokenExpiresAt) : new Date(0),
      };
    },
    catch: (e) =>
      new QBAuthError({
        message: e instanceof Error ? e.message : 'Failed to read QB tokens',
      }),
  });
}

/** Refresh QB access token via Intuit OAuth. */
export function refreshQBToken(
  env: Env,
  userId: string,
  refreshToken: string,
): Effect.Effect<QBTokens, QBAuthError> {
  return Effect.tryPromise({
    try: async () => {
      const clientId = env.QB_CLIENT_ID!;
      const clientSecret = env.QB_CLIENT_SECRET!;
      const basic = btoa(`${clientId}:${clientSecret}`);
      const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Token refresh failed (${res.status}): ${body}`);
      }
      const data = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const expiresAt = new Date(Date.now() + data.expires_in * 1000);

      // Update tokens in D1
      await env
        .AUTH_DB!.prepare(
          'UPDATE account SET accessToken = ?, refreshToken = ?, accessTokenExpiresAt = ? WHERE userId = ? AND providerId = ?',
        )
        .bind(data.access_token, data.refresh_token, expiresAt.toISOString(), userId, 'quickbooks')
        .run();

      // Read back realmId
      const row = await env
        .AUTH_DB!.prepare('SELECT accountId FROM account WHERE userId = ? AND providerId = ?')
        .bind(userId, 'quickbooks')
        .first<{ accountId: string }>();

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        realmId: row!.accountId,
        expiresAt,
      };
    },
    catch: (e) =>
      new QBAuthError({
        message: e instanceof Error ? e.message : 'Token refresh failed',
      }),
  });
}

/** Get a valid access token, refreshing if expired. */
export function getValidToken(env: Env, userId: string): Effect.Effect<QBTokens, QBAuthError> {
  return Effect.gen(function* () {
    const tokens = yield* getQBTokens(env.AUTH_DB!, userId);
    if (tokens.expiresAt.getTime() > Date.now() + 60_000) {
      return tokens; // still valid (with 60s buffer)
    }
    return yield* refreshQBToken(env, userId, tokens.refreshToken);
  });
}

// ============================================================
// QuickBooks API client
// ============================================================

const QB_BASE = 'https://quickbooks.api.intuit.com';
const QB_SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';

function qbBase(env: Env): string {
  return env.TAXBANDITS_ENV === 'production' ? QB_BASE : QB_SANDBOX_BASE;
}

/** Retry schedule: exponential backoff with jitter, 3 attempts. */
const retrySchedule = Schedule.intersect(
  Schedule.recurs(2),
  Schedule.exponential('500 millis').pipe(Schedule.jittered),
);

function qbFetch<T>(
  env: Env,
  tokens: QBTokens,
  path: string,
): Effect.Effect<T, QBAuthError | QBTransientError> {
  return Effect.tryPromise({
    try: async () => {
      const url = `${qbBase(env)}/v3/company/${tokens.realmId}${path}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
        },
      });
      if (res.status === 401 || res.status === 403) {
        throw { _tag: 'auth', status: res.status, body: await res.text() };
      }
      if (!res.ok) {
        throw { _tag: 'transient', status: res.status, body: await res.text() };
      }
      return (await res.json()) as T;
    },
    catch: (e) => {
      if (typeof e === 'object' && e !== null && '_tag' in e) {
        const err = e as { _tag: string; status: number; body: string };
        if (err._tag === 'auth') {
          return new QBAuthError({ message: `QB auth failed (${err.status}): ${err.body}` });
        }
        return new QBTransientError({ status: err.status, message: err.body });
      }
      return new QBTransientError({
        status: 0,
        message: e instanceof Error ? e.message : 'QB request failed',
      });
    },
  });
}

// ============================================================
// Business operations
// ============================================================

/** Fetch all 1099-flagged vendors from QuickBooks. */
export function fetchVendors(
  env: Env,
  tokens: QBTokens,
): Effect.Effect<QBVendor[], QBAuthError | QBTransientError> {
  const query = encodeURIComponent(
    'SELECT * FROM Vendor WHERE Vendor1099 = true AND Active = true',
  );
  return qbFetch<QBQueryResponse<QBVendor>>(env, tokens, `/query?query=${query}`).pipe(
    Effect.map((res) => res.QueryResponse.Vendor ?? []),
    Effect.retry({ schedule: retrySchedule, while: (e) => e._tag === 'QBTransientError' }),
  );
}

/** Fetch the Vendor1099 report — pre-computed payment totals by vendor. */
export function fetchVendor1099Report(
  env: Env,
  tokens: QBTokens,
  taxYear: string,
): Effect.Effect<QBVendor1099Row[], QBAuthError | QBTransientError> {
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  return qbFetch<QBReportResponse>(
    env,
    tokens,
    `/reports/Vendor1099?start_date=${startDate}&end_date=${endDate}&report_date=${endDate}`,
  ).pipe(
    Effect.map(parseVendor1099Report),
    Effect.retry({ schedule: retrySchedule, while: (e) => e._tag === 'QBTransientError' }),
  );
}

/** Parse the Vendor1099 report into structured rows. */
export function parseVendor1099Report(report: QBReportResponse): QBVendor1099Row[] {
  const rows = report.Rows?.Row ?? [];
  const results: QBVendor1099Row[] = [];
  for (const row of rows) {
    if (row.type === 'GrandTotal' || !row.ColData || row.ColData.length < 2) continue;
    const vendorCol = row.ColData[0];
    const necCol = row.ColData[1]; // Box 1: NEC
    if (!vendorCol || !necCol) continue;
    const nec = parseFloat(necCol.value || '0');
    if (nec <= 0) continue;
    results.push({
      vendorId: vendorCol.id ?? '',
      vendorName: vendorCol.value ?? '',
      tin: '', // QB masks TINs — must be provided separately
      nec,
    });
  }
  return results;
}

/** Convert a QB vendor + payment total into a Form1099NECRequest. */
export function vendorTo1099(
  vendor: QBVendor,
  nec: number,
  payer: Form1099NECRequest['payer'],
  tinOverride: string,
  taxYear: string,
): Form1099NECRequest {
  const nameParts = vendor.DisplayName.split(' ');
  return {
    payer,
    recipient: {
      first_name: vendor.GivenName ?? nameParts[0] ?? vendor.DisplayName,
      last_name: vendor.FamilyName ?? (nameParts.slice(1).join(' ') || vendor.DisplayName),
      tin: tinOverride, // must come from W-9, not QB
      tin_type: tinOverride.includes('-') ? 'EIN' : 'SSN',
      address: vendor.BillAddr?.Line1 ?? '',
      city: vendor.BillAddr?.City ?? '',
      state: vendor.BillAddr?.CountrySubDivisionCode ?? '',
      zip_code: vendor.BillAddr?.PostalCode ?? '',
    },
    nonemployee_compensation: nec,
    is_federal_tax_withheld: false,
    is_state_filing: false,
    tax_year: taxYear,
  };
}

// ============================================================
// High-level: pull from QB, generate 1099s
// ============================================================

export interface QBGenerateInput {
  userId: string;
  payer: Form1099NECRequest['payer'];
  taxYear: string;
  /** Map of QB vendor ID → full TIN (from W-9 collection). */
  vendorTins: Record<string, string>;
  /** Minimum payment threshold (default: 600). */
  threshold?: number;
}

export interface QBGenerateResult {
  forms: Form1099NECRequest[];
  skipped: Array<{ vendorId: string; vendorName: string; reason: string }>;
  total: number;
}

/** Pull vendors + payments from QB, generate 1099-NEC forms for all above threshold. */
export function generateFromQB(
  env: Env,
  input: QBGenerateInput,
): Effect.Effect<QBGenerateResult, QBAuthError | QBTransientError | QBBusinessError> {
  const threshold = input.threshold ?? 600;

  return Effect.gen(function* () {
    const tokens = yield* getValidToken(env, input.userId);
    const [vendors, report] = yield* Effect.all([
      fetchVendors(env, tokens),
      fetchVendor1099Report(env, tokens, input.taxYear),
    ]);

    const vendorMap = new Map(vendors.map((v) => [v.Id, v]));
    const forms: Form1099NECRequest[] = [];
    const skipped: QBGenerateResult['skipped'] = [];

    for (const row of report) {
      if (row.nec < threshold) {
        skipped.push({
          vendorId: row.vendorId,
          vendorName: row.vendorName,
          reason: `Below $${threshold} threshold ($${row.nec})`,
        });
        continue;
      }
      const tin = input.vendorTins[row.vendorId];
      if (!tin) {
        skipped.push({
          vendorId: row.vendorId,
          vendorName: row.vendorName,
          reason: 'Missing TIN — collect W-9',
        });
        continue;
      }
      const vendor = vendorMap.get(row.vendorId);
      if (!vendor) {
        skipped.push({
          vendorId: row.vendorId,
          vendorName: row.vendorName,
          reason: 'Vendor not found in QB',
        });
        continue;
      }
      forms.push(vendorTo1099(vendor, row.nec, input.payer, tin, input.taxYear));
    }

    return { forms, skipped, total: report.length };
  });
}
