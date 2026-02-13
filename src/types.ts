// ============================================================
// Cloudflare Worker Environment
// ============================================================

export interface Env {
  AI: Ai;
  COLUMN_TAX_CLIENT_ID: string;
  COLUMN_TAX_CLIENT_SECRET: string;
  COLUMN_TAX_ENV: 'sandbox' | 'production';
  COLUMN_TAX_BASE_URL: string;
}

// ============================================================
// Tax Data — what the user sends to our agent
// ============================================================

export interface TaxpayerInfo {
  first_name: string;
  middle_initial?: string;
  last_name: string;
  date_of_birth: string; // ISO 8601: YYYY-MM-DD
  social_security_number: string; // 9 digits, no dashes
  occupation: string;
  phone: string; // 10 digits, no formatting
  email: string;
}

export interface Address {
  address: string;
  apt_no?: string;
  city: string;
  state: string; // 2-letter abbreviation
  zip_code: string; // 5 digits
}

export interface BankAccount {
  account_type: 'checking' | 'savings';
  routing_number: string; // 9 digits
  account_number: string;
}

export interface W2 {
  employer_name: string;
  employer_ein: string; // XX-XXXXXXX
  wages: number; // cents
  federal_tax_withheld: number; // cents
  state_tax_withheld?: number; // cents
  state?: string; // 2-letter
}

export interface Income1099 {
  payer_name: string;
  payer_tin: string;
  amount: number; // cents
  type: '1099-NEC' | '1099-MISC' | '1099-INT' | '1099-DIV';
}

export interface ScheduleCBusiness {
  business_name: string;
  business_activity: string;
  gross_income: number; // cents
  expenses: number; // cents
}

export interface TaxFilingRequest {
  taxpayer: TaxpayerInfo;
  address: Address;
  refund_bank_account?: BankAccount;
  payment_bank_account?: BankAccount;
  w2s?: W2[];
  income_1099s?: Income1099[];
  schedule_c_businesses?: ScheduleCBusiness[];
  filing_year?: number; // defaults to current year
}

// ============================================================
// AI Validation — what Workers AI returns
// ============================================================

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  summary: string;
  ai_model: string;
}

// ============================================================
// Column Tax API types
// ============================================================

export interface ColumnTaxUserMetadata {
  password_changed_date: string | null;
  account_locked_date: string | null;
  passed_mfa_at_this_login: boolean;
  failed_login_attempts: number;
  cell_phone_changed_date: string | null;
  email_changed_date: string | null;
}

export interface ColumnTaxInitRequest {
  user_identifier: string;
  user: { email: string };
  user_metadata: ColumnTaxUserMetadata;
  tax_filing_fee?: { tax_filing_fee_cents: number };
  taxpayer_personal_info?: {
    first_name: string;
    middle_initial?: string;
    last_name: string;
    date_of_birth: string;
    social_security_number: string;
    occupation: string;
    phone: string;
  };
  address?: {
    address: string;
    apt_no?: string;
    city: string;
    state: string;
    zip_code: string;
  };
  refund_bank_account?: {
    account_type: 'checking' | 'savings';
    routing_number: string;
    account_number: string;
  };
  payment_bank_account?: {
    account_type: 'checking' | 'savings';
    routing_number: string;
    account_number: string;
  };
  w2s?: Array<Record<string, unknown>>;
  schedule_c_businesses?: Array<Record<string, unknown>>;
}

export interface ColumnTaxInitResponse {
  user_identifier: string;
  user_url: string;
  user_token?: string; // deprecated
  data_errors?: string[];
}

export interface ColumnTaxReturn {
  status: 'not_started' | 'started' | 'submitted';
  jurisdictions?: Array<{
    jurisdiction: string;
    submission_status: 'retryable' | 'accepted' | 'rejected';
    refund_or_amount_owed_cents: number;
  }>;
}

// ============================================================
// API Response envelope
// ============================================================

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; details?: unknown };
