// ============================================================
// Cloudflare Worker Environment
// ============================================================

export interface Env {
  AI: Ai;
  TAXBANDITS_CLIENT_ID: string;
  TAXBANDITS_CLIENT_SECRET: string;
  TAXBANDITS_USER_TOKEN: string;
  TAXBANDITS_ENV: 'sandbox' | 'production';
  TAX_AGENT_API_KEY?: string; // optional: if set, all mutating routes require Bearer auth
}

// ============================================================
// Tax Form Data — what the user sends to our agent
// ============================================================

export type BusinessType = 'CORP' | 'SCORP' | 'PART' | 'TRUST' | 'LLC' | 'EXEMPT' | 'ESTE';

export interface PayerInfo {
  name: string;
  tin: string; // EIN: XX-XXXXXXX or SSN: XXX-XX-XXXX / 9 digits
  tin_type?: 'EIN' | 'SSN'; // defaults to 'EIN'
  address: string;
  city: string;
  state: string; // 2-letter
  zip_code: string;
  phone: string;
  email: string;
  business_type?: BusinessType; // defaults to 'LLC'
}

export interface RecipientInfo {
  first_name: string;
  last_name: string;
  tin: string; // SSN (9 digits) or EIN (XX-XXXXXXX)
  tin_type: 'SSN' | 'EIN';
  address: string;
  city: string;
  state: string;
  zip_code: string;
}

/** TaxBandits KindOfEmployer values */
export type KindOfEmployer =
  | 'FEDERALGOVT'
  | 'STATEGOVT'
  | 'TRIBALGOVT'
  | 'TAX_EXEMPT'
  | 'NONEAPPLY';

/** TaxBandits KindOfPayer values */
export type KindOfPayer =
  | 'REGULAR941'
  | 'REGULAR944'
  | 'AGRICULTURAL943'
  | 'HOUSEHOLD'
  | 'MILITARY'
  | 'MEDICARE';

export interface Form1099NECRequest {
  payer: PayerInfo;
  recipient: RecipientInfo;
  nonemployee_compensation: number; // in dollars (e.g., 5000.00)
  is_federal_tax_withheld: boolean;
  federal_tax_withheld?: number; // in dollars
  is_state_filing: boolean;
  state?: string;
  state_income?: number;
  state_tax_withheld?: number;
  tax_year?: string; // defaults to current year
  kind_of_employer?: KindOfEmployer; // defaults to 'NONEAPPLY'
  kind_of_payer?: KindOfPayer; // defaults to 'REGULAR941'
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
// TaxBandits API types
// ============================================================

export interface TaxBanditsError {
  Id: string;
  Name: string;
  Message: string;
  Type: string;
}

export interface TaxBanditsTokenResponse {
  StatusCode: number;
  StatusName: string;
  StatusMessage: string;
  AccessToken: string;
  TokenType: string;
  ExpiresIn: number;
  Errors: unknown;
}

export interface TaxBanditsCreateRequest {
  SubmissionManifest: {
    TaxYear: string;
    IsFederalFiling: boolean;
    IsStateFiling: boolean;
    IsPostal: boolean;
    IsOnlineAccess: boolean;
  };
  ReturnHeader: {
    Business: {
      BusinessNm: string;
      EINorSSN: string;
      IsEIN: boolean;
      BusinessType: string;
      Phone: string;
      Email: string;
      SigningAuthority?: {
        Name: string;
        Phone: string;
        BusinessMemberType: string;
      };
      KindOfEmployer: string;
      KindOfPayer: string;
      IsBusinessTerminated: boolean;
      IsForeignAddress: boolean;
      USAddress: {
        Address1: string;
        City: string;
        State: string;
        ZipCd: string;
      };
    };
  };
  ReturnData: Array<{
    SequenceId: string;
    RecordId?: string;
    Recipient: {
      TINType: string;
      TIN: string;
      FirstPayeeNm: string;
      SecondPayeeNm?: string;
      IsForeignAddress: boolean;
      USAddress: {
        Address1: string;
        City: string;
        State: string;
        ZipCd: string;
      };
    };
    NECFormData: {
      B1NEC: string; // nonemployee compensation as string
      B4FedTaxWH?: string; // federal tax withheld as string
      Is2ndTINnot: boolean;
      IsDirectSales: boolean;
      States?: Array<{
        StateCd: string;
        StateIncome?: string;
        StateTaxWithheld?: string;
      }>;
    };
  }>;
}

export interface TaxBanditsCreateResponse {
  StatusCode: number;
  StatusName: string;
  StatusMessage: string;
  SubmissionId: string;
  FormRecords: Array<{
    RecordId: string;
    RecordStatus: string;
    Sequence: string;
    Errors: TaxBanditsError[] | null;
  }>;
  Errors: TaxBanditsError[] | null;
}

export interface TaxBanditsTransmitResponse {
  StatusCode: number;
  StatusName: string;
  StatusMessage: string;
  SubmissionId: string;
  Errors: TaxBanditsError[] | null;
}

export interface TaxBanditsStatusResponse {
  StatusCode: number;
  StatusName: string;
  StatusMessage: string;
  SubmissionId: string;
  FormStatus: string;
  FormRecords: Array<{
    RecordId: string;
    RecordStatus: string;
    Errors: TaxBanditsError[] | null;
  }> | null;
  Errors: TaxBanditsError[] | null;
}

// ============================================================
// API Response envelope
// ============================================================

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; details?: unknown };
