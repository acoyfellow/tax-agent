import type {
  Env,
  TaxFilingRequest,
  ColumnTaxInitRequest,
  ColumnTaxInitResponse,
  ColumnTaxUserMetadata,
  ColumnTaxReturn,
} from './types';

/**
 * Generate a deterministic user identifier from taxpayer data.
 * Column Tax uses this to track users across sessions.
 */
function generateUserIdentifier(taxpayer: TaxFilingRequest['taxpayer']): string {
  // In production, use a stable UUID from your user database.
  // For the demo, we derive one from the SSN (hashed).
  const raw = `tax-agent:${taxpayer.social_security_number}`;
  // Simple hash — replace with crypto.subtle in production
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `tax-agent-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Build the Authorization header for Column Tax API.
 */
function buildAuthHeader(env: Env): string {
  const credentials = btoa(`${env.COLUMN_TAX_CLIENT_ID}:${env.COLUMN_TAX_CLIENT_SECRET}`);
  return `Basic ${credentials}`;
}

/**
 * Build the security metadata Column Tax requires on every request.
 */
function buildUserMetadata(): ColumnTaxUserMetadata {
  return {
    password_changed_date: null,
    account_locked_date: null,
    passed_mfa_at_this_login: true,
    failed_login_attempts: 0,
    cell_phone_changed_date: null,
    email_changed_date: null,
  };
}

/**
 * Transform our TaxFilingRequest into Column Tax's initialize_tax_filing format.
 */
function buildInitRequest(data: TaxFilingRequest): ColumnTaxInitRequest {
  const request: ColumnTaxInitRequest = {
    user_identifier: generateUserIdentifier(data.taxpayer),
    user: { email: data.taxpayer.email },
    user_metadata: buildUserMetadata(),
    tax_filing_fee: { tax_filing_fee_cents: 0 }, // free for demo
    taxpayer_personal_info: {
      first_name: data.taxpayer.first_name,
      middle_initial: data.taxpayer.middle_initial,
      last_name: data.taxpayer.last_name,
      date_of_birth: data.taxpayer.date_of_birth,
      social_security_number: data.taxpayer.social_security_number,
      occupation: data.taxpayer.occupation,
      phone: data.taxpayer.phone,
    },
    address: {
      address: data.address.address,
      apt_no: data.address.apt_no,
      city: data.address.city,
      state: data.address.state,
      zip_code: data.address.zip_code,
    },
  };

  if (data.refund_bank_account) {
    request.refund_bank_account = data.refund_bank_account;
  }

  if (data.payment_bank_account) {
    request.payment_bank_account = data.payment_bank_account;
  }

  return request;
}

/**
 * Initialize a tax filing session with Column Tax.
 * Returns a user_url that opens their white-label tax prep UI.
 */
export async function initializeTaxFiling(
  env: Env,
  data: TaxFilingRequest,
): Promise<ColumnTaxInitResponse> {
  const body = buildInitRequest(data);

  const response = await fetch(`${env.COLUMN_TAX_BASE_URL}/v1/exp/initialize_tax_filing`, {
    method: 'POST',
    headers: {
      'Authorization': buildAuthHeader(env),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Column Tax API error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<ColumnTaxInitResponse>;
}

/**
 * Get the status of a user's tax return.
 */
export async function getTaxReturnStatus(
  env: Env,
  userIdentifier: string,
): Promise<ColumnTaxReturn> {
  const response = await fetch(
    `${env.COLUMN_TAX_BASE_URL}/v1/exp/tax_returns?user_identifier=${encodeURIComponent(userIdentifier)}`,
    {
      method: 'GET',
      headers: {
        'Authorization': buildAuthHeader(env),
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Column Tax API error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<ColumnTaxReturn>;
}
