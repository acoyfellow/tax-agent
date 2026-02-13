// ---------------------------------------------------------------------------
// PII scrubbing utilities
// ---------------------------------------------------------------------------

/**
 * Patterns that look like TINs (SSN / EIN).
 * - SSN: 3 digits, dash, 2 digits, dash, 4 digits (XXX-XX-XXXX)
 * - SSN raw: 9 consecutive digits (not inside a longer digit sequence)
 * - EIN: 2 digits, dash, 7 digits (XX-XXXXXXX)
 */
const SSN_FORMATTED = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN_FORMATTED = /\b\d{2}-\d{7}\b/g;
const NINE_DIGITS = /(?<!\d)\d{9}(?!\d)/g;

/**
 * Replace anything that looks like a TIN with a masked version
 * showing only the last 4 digits. Safe to call on any string.
 *
 * "412-78-9654" → "***-**-9654"
 * "27-1234567"  → "**-***4567"
 * "412789654"   → "*****9654"
 */
export function scrubTINs(input: string): string {
  return input
    .replace(SSN_FORMATTED, (m) => `***-**-${m.slice(-4)}`)
    .replace(EIN_FORMATTED, (m) => `**-***${m.slice(-4)}`)
    .replace(NINE_DIGITS, (m) => `*****${m.slice(-4)}`);
}

/**
 * Mask a TIN to show only last 4 digits.
 * Input can be formatted (with dashes) or raw.
 */
export function maskTIN(tin: string): string {
  const raw = tin.replace(/-/g, '');
  return `***${raw.slice(-4)}`;
}
