import { describe, it, expect } from 'vitest';
import { scrubTINs, maskTIN } from './pii';

describe('scrubTINs', () => {
  it('masks SSN formatted XXX-XX-XXXX', () => {
    expect(scrubTINs('SSN: 412-78-9654')).toBe('SSN: ***-**-9654');
  });

  it('masks EIN formatted XX-XXXXXXX', () => {
    expect(scrubTINs('EIN: 27-1234567')).toBe('EIN: **-***4567');
  });

  it('masks raw 9-digit SSN', () => {
    expect(scrubTINs('TIN is 412789654 here')).toBe('TIN is *****9654 here');
  });

  it('masks multiple TINs in one string', () => {
    const input = 'Payer 27-1234567 paid recipient 412-78-9654';
    const result = scrubTINs(input);
    expect(result).not.toContain('27-1234567');
    expect(result).not.toContain('412-78-9654');
    expect(result).toContain('4567');
    expect(result).toContain('9654');
  });

  it('preserves non-TIN content', () => {
    expect(scrubTINs('No TINs here, just text.')).toBe('No TINs here, just text.');
  });

  it('does not mask numbers longer than 9 digits', () => {
    expect(scrubTINs('Phone: 12125551234')).toBe('Phone: 12125551234');
  });

  it('handles empty string', () => {
    expect(scrubTINs('')).toBe('');
  });

  it('handles error message with embedded TIN', () => {
    const msg = 'TaxBandits error: TIN 412789654 is invalid for recipient';
    const result = scrubTINs(msg);
    expect(result).not.toContain('412789654');
    expect(result).toContain('*****9654');
  });
});

describe('maskTIN', () => {
  it('masks formatted SSN', () => {
    expect(maskTIN('412-78-9654')).toBe('***9654');
  });

  it('masks raw SSN', () => {
    expect(maskTIN('412789654')).toBe('***9654');
  });

  it('masks EIN', () => {
    expect(maskTIN('27-1234567')).toBe('***4567');
  });
});
