import { describe, it, expect } from 'vitest';
import { parseCSV, csvToForms } from './csv';

// ---------------------------------------------------------------------------
// parseCSV
// ---------------------------------------------------------------------------

describe('parseCSV', () => {
  it('parses simple CSV', () => {
    const rows = parseCSV('a,b,c\n1,2,3\n4,5,6');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('handles quoted fields with commas', () => {
    const rows = parseCSV('name,address\n"Smith, Jane","123 Main St, Apt 4"');
    expect(rows[1]).toEqual(['Smith, Jane', '123 Main St, Apt 4']);
  });

  it('handles escaped quotes', () => {
    const rows = parseCSV('name\n"She said ""hello"""');
    expect(rows[1]).toEqual(['She said "hello"']);
  });

  it('handles Windows line endings', () => {
    const rows = parseCSV('a,b\r\n1,2\r\n3,4');
    expect(rows).toHaveLength(3);
  });

  it('skips empty lines', () => {
    const rows = parseCSV('a,b\n\n1,2\n\n');
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// csvToForms
// ---------------------------------------------------------------------------

const HEADER =
  'recipient_first_name,recipient_last_name,recipient_tin,recipient_tin_type,recipient_address,recipient_city,recipient_state,recipient_zip,amount,is_federal_withheld,is_state_filing';
const ROW = 'Jane,Smith,412789654,SSN,200 Oak Ave,Austin,TX,78701,5000.00,false,false';

const DEFAULT_PAYER = {
  name: 'Acme Corp',
  tin: '27-1234567',
  tin_type: 'EIN' as const,
  address: '100 Main St',
  city: 'New York',
  state: 'NY',
  zip_code: '10001',
  phone: '2125551234',
  email: 'payroll@acme.com',
};

describe('csvToForms', () => {
  it('parses a valid CSV row with default payer', () => {
    const result = csvToForms(`${HEADER}\n${ROW}`, DEFAULT_PAYER);
    expect(result.forms).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.totalRows).toBe(1);
    const form = result.forms[0]!;
    expect(form.payer.name).toBe('Acme Corp');
    expect(form.recipient.first_name).toBe('Jane');
    expect(form.recipient.last_name).toBe('Smith');
    expect(form.recipient.tin).toBe('412789654');
    expect(form.nonemployee_compensation).toBe(5000);
  });

  it('parses multiple rows', () => {
    const csv = `${HEADER}\n${ROW}\nBob,Jones,27-9876543,EIN,300 Elm St,Dallas,TX,75201,12000,false,false`;
    const result = csvToForms(csv, DEFAULT_PAYER);
    expect(result.forms).toHaveLength(2);
    expect(result.forms[1]!.recipient.first_name).toBe('Bob');
    expect(result.forms[1]!.nonemployee_compensation).toBe(12000);
  });

  it('reports errors for rows missing required fields', () => {
    const csv = `${HEADER}\n,Smith,412789654,SSN,200 Oak Ave,Austin,TX,78701,5000,false,false`;
    const result = csvToForms(csv, DEFAULT_PAYER);
    expect(result.forms).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.row).toBe(2);
    expect(result.errors[0]!.errors).toContain('Missing recipient_first_name');
  });

  it('handles dollar signs and commas in amounts', () => {
    const csv = `${HEADER}\nJane,Smith,412789654,SSN,200 Oak Ave,Austin,TX,78701,"$5,000.00",false,false`;
    const result = csvToForms(csv, DEFAULT_PAYER);
    expect(result.forms[0]!.nonemployee_compensation).toBe(5000);
  });

  it('coerces boolean fields', () => {
    const csv = `${HEADER}\nJane,Smith,412789654,SSN,200 Oak Ave,Austin,TX,78701,5000,true,yes`;
    const result = csvToForms(csv, DEFAULT_PAYER);
    expect(result.forms[0]!.is_federal_tax_withheld).toBe(true);
    expect(result.forms[0]!.is_state_filing).toBe(true);
  });

  it('defaults booleans to false when missing', () => {
    const csv =
      'recipient_first_name,recipient_last_name,recipient_tin,recipient_tin_type,recipient_address,recipient_city,recipient_state,recipient_zip,amount\nJane,Smith,412789654,SSN,200 Oak Ave,Austin,TX,78701,5000';
    const result = csvToForms(csv, DEFAULT_PAYER);
    expect(result.forms[0]!.is_federal_tax_withheld).toBe(false);
    expect(result.forms[0]!.is_state_filing).toBe(false);
  });

  it('includes payer from CSV columns when no default', () => {
    const csv =
      'payer_name,payer_tin,payer_tin_type,payer_address,payer_city,payer_state,payer_zip,payer_phone,payer_email,recipient_first_name,recipient_last_name,recipient_tin,recipient_tin_type,recipient_address,recipient_city,recipient_state,recipient_zip,amount\nAcme Corp,27-1234567,EIN,100 Main St,New York,NY,10001,2125551234,payroll@acme.com,Jane,Smith,412789654,SSN,200 Oak Ave,Austin,TX,78701,5000';
    const result = csvToForms(csv);
    expect(result.forms).toHaveLength(1);
    expect(result.forms[0]!.payer.name).toBe('Acme Corp');
  });

  it('fails on empty CSV', () => {
    const result = csvToForms('');
    expect(result.forms).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it('fails on header-only CSV', () => {
    const result = csvToForms(HEADER);
    expect(result.forms).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });

  it('fails on unrecognized columns', () => {
    const result = csvToForms('foo,bar,baz\n1,2,3');
    expect(result.forms).toHaveLength(0);
    expect(result.errors[0]!.errors[0]).toContain('No recognized columns');
  });

  it('handles mixed valid and invalid rows', () => {
    const csv = `${HEADER}\n${ROW}\n,,,,,,,,,,`;
    const result = csvToForms(csv, DEFAULT_PAYER);
    expect(result.forms).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.totalRows).toBe(2);
  });

  it('normalizes headers with spaces and dashes', () => {
    const csv =
      'Recipient First Name,Recipient-Last-Name,recipient tin,RECIPIENT_TIN_TYPE,recipient address,recipient city,recipient state,recipient zip,Amount\nJane,Smith,412789654,SSN,200 Oak Ave,Austin,TX,78701,5000';
    const result = csvToForms(csv, DEFAULT_PAYER);
    expect(result.forms).toHaveLength(1);
    expect(result.forms[0]!.recipient.first_name).toBe('Jane');
  });
});
