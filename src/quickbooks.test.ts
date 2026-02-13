import { describe, it, expect } from 'vitest';
import {
  parseVendor1099Report,
  vendorTo1099,
  type QBVendor,
  type QBGenerateResult,
} from './quickbooks';
import type { Form1099NECRequest } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYER: Form1099NECRequest['payer'] = {
  name: 'Acme Corp',
  tin: '27-1234567',
  tin_type: 'EIN',
  address: '100 Main St',
  city: 'New York',
  state: 'NY',
  zip_code: '10001',
  phone: '2125551234',
  email: 'payroll@acme.com',
};

const VENDOR: QBVendor = {
  Id: '56',
  DisplayName: 'Jane Smith',
  GivenName: 'Jane',
  FamilyName: 'Smith',
  PrimaryEmailAddr: { Address: 'jane@example.com' },
  PrimaryPhone: { FreeFormNumber: '5125551234' },
  BillAddr: {
    Line1: '200 Oak Ave',
    City: 'Austin',
    CountrySubDivisionCode: 'TX',
    PostalCode: '78701',
  },
  TaxIdentifier: '9654', // last 4 only
  Vendor1099: true,
  Active: true,
};

// ---------------------------------------------------------------------------
// parseVendor1099Report
// ---------------------------------------------------------------------------

describe('parseVendor1099Report', () => {
  it('extracts vendor rows with NEC amounts', () => {
    const report = {
      Header: { ReportName: 'Vendor1099' },
      Columns: {
        Column: [
          { ColTitle: 'Vendor', ColType: 'String' },
          { ColTitle: 'Box 1', ColType: 'Amount' },
        ],
      },
      Rows: {
        Row: [
          { ColData: [{ value: 'Jane Smith', id: '56' }, { value: '7500.00' }] },
          { ColData: [{ value: 'Bob Jones', id: '78' }, { value: '1200.50' }] },
          { ColData: [{ value: 'Grand Total' }, { value: '8700.50' }], type: 'GrandTotal' },
        ],
      },
    };
    const rows = parseVendor1099Report(report);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ vendorId: '56', vendorName: 'Jane Smith', tin: '', nec: 7500 });
    expect(rows[1]).toEqual({ vendorId: '78', vendorName: 'Bob Jones', tin: '', nec: 1200.5 });
  });

  it('skips grand total rows', () => {
    const report = {
      Header: { ReportName: 'Vendor1099' },
      Columns: { Column: [] },
      Rows: {
        Row: [{ ColData: [{ value: 'Total' }, { value: '5000' }], type: 'GrandTotal' }],
      },
    };
    expect(parseVendor1099Report(report)).toHaveLength(0);
  });

  it('skips zero/negative amounts', () => {
    const report = {
      Header: { ReportName: 'Vendor1099' },
      Columns: { Column: [] },
      Rows: {
        Row: [
          { ColData: [{ value: 'Zero Vendor', id: '1' }, { value: '0.00' }] },
          { ColData: [{ value: 'Negative Vendor', id: '2' }, { value: '-100' }] },
        ],
      },
    };
    expect(parseVendor1099Report(report)).toHaveLength(0);
  });

  it('handles empty report', () => {
    const report = {
      Header: { ReportName: 'Vendor1099' },
      Columns: { Column: [] },
      Rows: {},
    };
    expect(parseVendor1099Report(report)).toHaveLength(0);
  });

  it('handles missing ColData gracefully', () => {
    const report = {
      Header: { ReportName: 'Vendor1099' },
      Columns: { Column: [] },
      Rows: {
        Row: [{ ColData: [{ value: 'Only one col' }] }],
      },
    };
    expect(parseVendor1099Report(report)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// vendorTo1099
// ---------------------------------------------------------------------------

describe('vendorTo1099', () => {
  it('converts a QB vendor to Form1099NECRequest', () => {
    const form = vendorTo1099(VENDOR, 7500, PAYER, '412789654', '2024');
    expect(form.payer.name).toBe('Acme Corp');
    expect(form.recipient.first_name).toBe('Jane');
    expect(form.recipient.last_name).toBe('Smith');
    expect(form.recipient.tin).toBe('412789654');
    expect(form.recipient.tin_type).toBe('SSN');
    expect(form.recipient.address).toBe('200 Oak Ave');
    expect(form.recipient.city).toBe('Austin');
    expect(form.recipient.state).toBe('TX');
    expect(form.recipient.zip_code).toBe('78701');
    expect(form.nonemployee_compensation).toBe(7500);
    expect(form.is_federal_tax_withheld).toBe(false);
    expect(form.is_state_filing).toBe(false);
    expect(form.tax_year).toBe('2024');
  });

  it('detects EIN format from TIN with dash', () => {
    const form = vendorTo1099(VENDOR, 1000, PAYER, '27-1234567', '2024');
    expect(form.recipient.tin_type).toBe('EIN');
  });

  it('detects SSN format from TIN without dash', () => {
    const form = vendorTo1099(VENDOR, 1000, PAYER, '412789654', '2024');
    expect(form.recipient.tin_type).toBe('SSN');
  });

  it('falls back to DisplayName when GivenName/FamilyName missing', () => {
    const vendor: QBVendor = {
      ...VENDOR,
      GivenName: undefined,
      FamilyName: undefined,
      DisplayName: 'Smith Consulting LLC',
    };
    const form = vendorTo1099(vendor, 5000, PAYER, '27-9999999', '2024');
    expect(form.recipient.first_name).toBe('Smith');
    expect(form.recipient.last_name).toBe('Consulting LLC');
  });

  it('handles single-word DisplayName', () => {
    const vendor: QBVendor = {
      ...VENDOR,
      GivenName: undefined,
      FamilyName: undefined,
      DisplayName: 'Madonna',
    };
    const form = vendorTo1099(vendor, 5000, PAYER, '412789654', '2024');
    expect(form.recipient.first_name).toBe('Madonna');
    expect(form.recipient.last_name).toBe('Madonna');
  });

  it('handles missing address fields', () => {
    const vendor: QBVendor = { ...VENDOR, BillAddr: undefined };
    const form = vendorTo1099(vendor, 5000, PAYER, '412789654', '2024');
    expect(form.recipient.address).toBe('');
    expect(form.recipient.city).toBe('');
    expect(form.recipient.state).toBe('');
    expect(form.recipient.zip_code).toBe('');
  });
});
