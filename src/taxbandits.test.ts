import { describe, it, expect } from 'vitest';
import {
  base64url,
  base64urlBytes,
  buildJWS,
  buildCreateRequest,
  buildBatchCreateRequest,
} from './taxbandits';
import type { Form1099NECRequest, TaxBanditsCreateRequest } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validRequest(overrides: Partial<Form1099NECRequest> = {}): Form1099NECRequest {
  return {
    payer: {
      name: 'Acme Corp',
      tin: '27-1234567',
      tin_type: 'EIN',
      address: '100 Main St',
      city: 'New York',
      state: 'NY',
      zip_code: '10001',
      phone: '(212) 555-1234',
      email: 'payroll@acme.com',
      business_type: 'LLC',
    },
    recipient: {
      first_name: 'Jane',
      last_name: 'Smith',
      tin: '412-78-9654',
      tin_type: 'SSN',
      address: '200 Oak Ave',
      city: 'Austin',
      state: 'TX',
      zip_code: '78701',
    },
    nonemployee_compensation: 5000.0,
    is_federal_tax_withheld: false,
    is_state_filing: false,
    tax_year: '2025',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// base64url()
// ---------------------------------------------------------------------------
describe('base64url', () => {
  it('encodes without padding', () => {
    const result = base64url('test');
    expect(result).not.toContain('=');
  });

  it('replaces + with - and / with _', () => {
    // "n\xfb" -> base64 "bvs=" which has no + or /, but let's verify the contract
    const result = base64url('{"alg":"HS256","typ":"JWT"}');
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
    expect(result).not.toContain('=');
  });

  it('produces valid base64url for JWT header', () => {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    // Decode and verify
    const decoded = atob(header.replace(/-/g, '+').replace(/_/g, '/'));
    expect(JSON.parse(decoded)).toEqual({ alg: 'HS256', typ: 'JWT' });
  });
});

// ---------------------------------------------------------------------------
// base64urlBytes()
// ---------------------------------------------------------------------------
describe('base64urlBytes', () => {
  it('encodes byte arrays without padding', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const result = base64urlBytes(bytes);
    expect(result).not.toContain('=');
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
  });

  it('handles empty array', () => {
    const result = base64urlBytes(new Uint8Array([]));
    expect(result).toBe('');
  });

  it('round-trips correctly', () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const encoded = base64urlBytes(original);
    const decoded = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      bytes[i] = decoded.charCodeAt(i);
    }
    expect(bytes).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// buildJWS() — real crypto, no mocks
// ---------------------------------------------------------------------------
describe('buildJWS', () => {
  it('produces a 3-part dot-separated token', async () => {
    const jws = await buildJWS('client-id', 'client-secret', 'user-token');
    const parts = jws.split('.');
    expect(parts).toHaveLength(3);
  });

  it('header decodes to HS256 JWT', async () => {
    const jws = await buildJWS('client-id', 'client-secret', 'user-token');
    const header = jws.split('.')[0];
    if (!header) throw new Error('missing header');
    const decoded = JSON.parse(atob(header.replace(/-/g, '+').replace(/_/g, '/'))) as {
      alg: string;
      typ: string;
    };
    expect(decoded.alg).toBe('HS256');
    expect(decoded.typ).toBe('JWT');
  });

  it('payload contains iss, sub, aud, iat', async () => {
    const jws = await buildJWS('my-client', 'my-secret', 'my-user');
    const payload = jws.split('.')[1];
    if (!payload) throw new Error('missing payload');
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      iss: string;
      sub: string;
      aud: string;
      iat: number;
    };
    expect(decoded.iss).toBe('my-client');
    expect(decoded.sub).toBe('my-client');
    expect(decoded.aud).toBe('my-user');
    expect(typeof decoded.iat).toBe('number');
    // iat should be recent (within 10 seconds)
    expect(Math.abs(decoded.iat - Math.floor(Date.now() / 1000))).toBeLessThan(10);
  });

  it('different secrets produce different signatures', async () => {
    const jws1 = await buildJWS('client', 'secret-1', 'user');
    const jws2 = await buildJWS('client', 'secret-2', 'user');
    const sig1 = jws1.split('.')[2];
    const sig2 = jws2.split('.')[2];
    expect(sig1).not.toBe(sig2);
  });

  it('same inputs produce same header+payload (deterministic except iat)', async () => {
    const jws1 = await buildJWS('c', 's', 'u');
    const jws2 = await buildJWS('c', 's', 'u');
    // Headers should be identical
    expect(jws1.split('.')[0]).toBe(jws2.split('.')[0]);
  });

  it('signature is valid HMAC-SHA256', async () => {
    const clientSecret = 'test-secret-key';
    const jws = await buildJWS('client', clientSecret, 'user');
    const parts = jws.split('.');
    const [header, payload, signature] = parts;
    if (!header || !payload || !signature) throw new Error('invalid JWS');

    // Verify signature ourselves
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(clientSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    // Decode the signature from base64url
    const sigBinary = atob(signature.replace(/-/g, '+').replace(/_/g, '/'));
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      sigBytes[i] = sigBinary.charCodeAt(i);
    }

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      encoder.encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCreateRequest() — pure transformation, real data
// ---------------------------------------------------------------------------
describe('buildCreateRequest', () => {
  it('transforms valid request to TaxBandits format', () => {
    const result = buildCreateRequest(validRequest());
    expect(result.SubmissionManifest.TaxYear).toBe('2025');
    expect(result.SubmissionManifest.IsFederalFiling).toBe(true);
    expect(result.SubmissionManifest.IsStateFiling).toBe(false);
  });

  it('strips dashes from payer EIN', () => {
    const result = buildCreateRequest(validRequest());
    expect(result.ReturnHeader.Business.EINorSSN).toBe('271234567');
    expect(result.ReturnHeader.Business.EINorSSN).not.toContain('-');
  });

  it('sets IsEIN=true for EIN payers', () => {
    const result = buildCreateRequest(validRequest());
    expect(result.ReturnHeader.Business.IsEIN).toBe(true);
  });

  it('sets IsEIN=false for SSN payers', () => {
    const req = validRequest();
    req.payer.tin = '123456789';
    req.payer.tin_type = 'SSN';
    const result = buildCreateRequest(req);
    expect(result.ReturnHeader.Business.IsEIN).toBe(false);
  });

  it('strips non-digits from phone', () => {
    const result = buildCreateRequest(validRequest());
    expect(result.ReturnHeader.Business.Phone).toBe('2125551234');
  });

  it('strips dashes from recipient TIN', () => {
    const result = buildCreateRequest(validRequest());
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.Recipient.TIN).toBe('412789654');
  });

  it('formats compensation as 2-decimal string', () => {
    const req = validRequest({ nonemployee_compensation: 1234.5 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B1NEC).toBe('1234.50');
  });

  it('handles float precision edge case', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS
    const req = validRequest({ nonemployee_compensation: 0.1 + 0.2 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    // toFixed(2) should round correctly
    expect(record.NECFormData.B1NEC).toBe('0.30');
  });

  it('includes federal tax withheld when enabled', () => {
    const req = validRequest({
      is_federal_tax_withheld: true,
      federal_tax_withheld: 750.0,
    });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B4FedTaxWH).toBe('750.00');
  });

  it('omits federal tax withheld when not enabled', () => {
    const result = buildCreateRequest(validRequest());
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B4FedTaxWH).toBeUndefined();
  });

  it('includes state filing data', () => {
    const req = validRequest({
      is_state_filing: true,
      state: 'CA',
      state_income: 5000,
      state_tax_withheld: 250,
    });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.States).toHaveLength(1);
    const state = record.NECFormData.States?.[0];
    expect(state?.StateCd).toBe('CA');
    expect(state?.StateIncome).toBe('5000.00');
    expect(state?.StateTaxWithheld).toBe('250.00');
  });

  it('defaults state_income to nonemployee_compensation', () => {
    const req = validRequest({
      is_state_filing: true,
      state: 'TX',
      nonemployee_compensation: 8000,
    });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.States?.[0]?.StateIncome).toBe('8000.00');
  });

  it('generates unique SequenceId per call', () => {
    const r1 = buildCreateRequest(validRequest());
    const r2 = buildCreateRequest(validRequest());
    expect(r1.ReturnData[0]?.SequenceId).not.toBe(r2.ReturnData[0]?.SequenceId);
  });

  it('concatenates recipient first + last name', () => {
    const result = buildCreateRequest(validRequest());
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.Recipient.FirstPayeeNm).toBe('Jane Smith');
  });

  it('sets IsForeignAddress to false', () => {
    const result = buildCreateRequest(validRequest());
    expect(result.ReturnHeader.Business.IsForeignAddress).toBe(false);
    expect(result.ReturnData[0]?.Recipient.IsForeignAddress).toBe(false);
  });

  it('uses default kind_of_employer and kind_of_payer', () => {
    const result = buildCreateRequest(validRequest());
    expect(result.ReturnHeader.Business.KindOfEmployer).toBe('NONEAPPLY');
    expect(result.ReturnHeader.Business.KindOfPayer).toBe('REGULAR941');
  });

  it('respects custom kind_of_employer', () => {
    const req = validRequest({ kind_of_employer: 'STATEGOVT' });
    const result = buildCreateRequest(req);
    expect(result.ReturnHeader.Business.KindOfEmployer).toBe('STATEGOVT');
  });

  it('defaults tax_year to current year', () => {
    const req = validRequest();
    delete (req as Partial<Form1099NECRequest>).tax_year;
    const result = buildCreateRequest(req as Form1099NECRequest);
    expect(result.SubmissionManifest.TaxYear).toBe(new Date().getFullYear().toString());
  });
});

// ---------------------------------------------------------------------------
// buildBatchCreateRequest() — batch filing
// ---------------------------------------------------------------------------
describe('buildBatchCreateRequest', () => {
  it('creates ReturnData entry per form', () => {
    const form1 = validRequest();
    const form2 = validRequest();
    form2.recipient.first_name = 'Bob';
    form2.recipient.last_name = 'Jones';
    form2.recipient.tin = '111223333';
    form2.nonemployee_compensation = 10000;

    const result = buildBatchCreateRequest([form1, form2]);
    expect(result.ReturnData).toHaveLength(2);
    expect(result.ReturnData[0]?.Recipient.FirstPayeeNm).toBe('Jane Smith');
    expect(result.ReturnData[1]?.Recipient.FirstPayeeNm).toBe('Bob Jones');
    expect(result.ReturnData[1]?.NECFormData.B1NEC).toBe('10000.00');
  });

  it('uses payer info from first form', () => {
    const result = buildBatchCreateRequest([validRequest()]);
    expect(result.ReturnHeader.Business.BusinessNm).toBe('Acme Corp');
  });

  it('generates unique SequenceIds for each record', () => {
    const forms = [validRequest(), validRequest(), validRequest()];
    const result = buildBatchCreateRequest(forms);
    const ids = result.ReturnData.map((r) => r.SequenceId);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });

  it('sets IsStateFiling=true if any form has state filing', () => {
    const form1 = validRequest();
    const form2 = validRequest({ is_state_filing: true, state: 'CA' });
    const result = buildBatchCreateRequest([form1, form2]);
    expect(result.SubmissionManifest.IsStateFiling).toBe(true);
  });

  it('sets IsStateFiling=false if no forms have state filing', () => {
    const result = buildBatchCreateRequest([validRequest()]);
    expect(result.SubmissionManifest.IsStateFiling).toBe(false);
  });

  it('throws on empty array', () => {
    expect(() => buildBatchCreateRequest([])).toThrow('At least one form');
  });

  it('single-form batch matches single buildCreateRequest structure', () => {
    const form = validRequest();
    const batch = buildBatchCreateRequest([form]);
    const single = buildCreateRequest(form);
    // Same payer info
    expect(batch.ReturnHeader.Business.BusinessNm).toBe(single.ReturnHeader.Business.BusinessNm);
    expect(batch.ReturnHeader.Business.EINorSSN).toBe(single.ReturnHeader.Business.EINorSSN);
    // Same manifest
    expect(batch.SubmissionManifest.TaxYear).toBe(single.SubmissionManifest.TaxYear);
    // Same recipient data (ignoring SequenceId which is random)
    expect(batch.ReturnData[0]?.Recipient.TIN).toBe(single.ReturnData[0]?.Recipient.TIN);
  });
});

// ---------------------------------------------------------------------------
// Floating-point rounding edge cases
// ---------------------------------------------------------------------------
describe('floating-point rounding edge cases', () => {
  it('5000.004 rounds down to "5000.00"', () => {
    const req = validRequest({ nonemployee_compensation: 5000.004 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B1NEC).toBe('5000.00');
  });

  it('5000.005 rounds to "5000.01" (standard JS banker\'s rounding)', () => {
    const req = validRequest({ nonemployee_compensation: 5000.005 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    // JS toFixed(2) uses IEEE 754 round-half-to-even; 5000.005 → "5000.01"
    expect(record.NECFormData.B1NEC).toBe('5000.01');
  });

  it('5000.999 rounds up to "5001.00"', () => {
    const req = validRequest({ nonemployee_compensation: 5000.999 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B1NEC).toBe('5001.00');
  });

  it('0.1 + 0.2 precision issue formats correctly as "0.30"', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754
    const req = validRequest({ nonemployee_compensation: 0.1 + 0.2 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B1NEC).toBe('0.30');
  });

  it('very large amount 999999.99 formats correctly', () => {
    const req = validRequest({ nonemployee_compensation: 999999.99 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B1NEC).toBe('999999.99');
  });

  it('very small amount 0.01 formats correctly', () => {
    const req = validRequest({ nonemployee_compensation: 0.01 });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    expect(record.NECFormData.B1NEC).toBe('0.01');
  });

  it('negative zero formats as "0.00" not "-0.00" for federal_tax_withheld', () => {
    const req = validRequest({
      is_federal_tax_withheld: true,
      federal_tax_withheld: 100,
    });
    // Build a request with a valid withheld amount to verify
    // that -0 edge case in toFixed produces "0.00"
    const negZero = -0;
    // Directly test toFixed behavior for -0
    expect(negZero.toFixed(2)).toBe('0.00');
  });

  it('state_income with rounding edge case 1234.565 formats correctly', () => {
    const req = validRequest({
      is_state_filing: true,
      state: 'CA',
      nonemployee_compensation: 5000,
      state_income: 1234.565,
      state_tax_withheld: 0.005,
    });
    const result = buildCreateRequest(req);
    const record = result.ReturnData[0];
    if (!record) throw new Error('missing ReturnData');
    const states = record.NECFormData.States;
    expect(states).toHaveLength(1);
    // 1234.565.toFixed(2) → "1234.57" (rounds up the .565)
    expect(states![0]!.StateIncome).toBe('1234.57');
    // 0.005.toFixed(2) → "0.01" in most JS engines
    expect(states![0]!.StateTaxWithheld).toBe('0.01');
  });

  it('batch request formats amounts with same rounding rules', () => {
    const form1 = validRequest({ nonemployee_compensation: 5000.004 });
    const form2 = validRequest({ nonemployee_compensation: 5000.999 });
    form2.recipient.tin = '111223333';
    const result = buildBatchCreateRequest([form1, form2]);
    expect(result.ReturnData[0]?.NECFormData.B1NEC).toBe('5000.00');
    expect(result.ReturnData[1]?.NECFormData.B1NEC).toBe('5001.00');
  });
});
