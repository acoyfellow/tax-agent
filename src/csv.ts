import type { Form1099NECRequest } from './types';

// ============================================================
// CSV parsing — zero dependencies
// ============================================================

/** Parse CSV text into rows of string values. Handles quoted fields with commas. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++; // skip opening quote
        let val = '';
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') {
            val += '"';
            i += 2;
          } else if (line[i] === '"') {
            i++; // skip closing quote
            break;
          } else {
            val += line[i];
            i++;
          }
        }
        fields.push(val);
        if (line[i] === ',') i++; // skip delimiter
      } else {
        const next = line.indexOf(',', i);
        if (next === -1) {
          fields.push(line.slice(i));
          break;
        }
        fields.push(line.slice(i, next));
        i = next + 1;
      }
    }
    rows.push(fields);
  }
  return rows;
}

// ============================================================
// CSV column mapping
// ============================================================

/** Expected CSV columns. Order doesn't matter — matched by header name. */
const COLUMN_MAP: Record<string, string> = {
  // Payer
  payer_name: 'payer.name',
  payer_tin: 'payer.tin',
  payer_tin_type: 'payer.tin_type',
  payer_address: 'payer.address',
  payer_city: 'payer.city',
  payer_state: 'payer.state',
  payer_zip: 'payer.zip_code',
  payer_zip_code: 'payer.zip_code',
  payer_phone: 'payer.phone',
  payer_email: 'payer.email',
  payer_business_type: 'payer.business_type',
  // Recipient
  recipient_first_name: 'recipient.first_name',
  recipient_last_name: 'recipient.last_name',
  recipient_tin: 'recipient.tin',
  recipient_tin_type: 'recipient.tin_type',
  recipient_address: 'recipient.address',
  recipient_city: 'recipient.city',
  recipient_state: 'recipient.state',
  recipient_zip: 'recipient.zip_code',
  recipient_zip_code: 'recipient.zip_code',
  // Amounts / flags
  amount: 'nonemployee_compensation',
  nonemployee_compensation: 'nonemployee_compensation',
  compensation: 'nonemployee_compensation',
  federal_withheld: 'federal_tax_withheld',
  federal_tax_withheld: 'federal_tax_withheld',
  is_federal_withheld: 'is_federal_tax_withheld',
  is_federal_tax_withheld: 'is_federal_tax_withheld',
  is_state_filing: 'is_state_filing',
  state: 'state',
  state_income: 'state_income',
  state_tax_withheld: 'state_tax_withheld',
  tax_year: 'tax_year',
};

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!(key in cur) || typeof cur[key] !== 'object') {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function coerce(field: string, value: string): unknown {
  const v = value.trim();
  if (
    field === 'nonemployee_compensation' ||
    field === 'federal_tax_withheld' ||
    field === 'state_income' ||
    field === 'state_tax_withheld'
  ) {
    return parseFloat(v.replace(/[$,]/g, '')) || 0;
  }
  if (field === 'is_federal_tax_withheld' || field === 'is_state_filing') {
    return v === 'true' || v === '1' || v === 'yes' || v === 'Y';
  }
  return v;
}

// ============================================================
// CSV to Form1099NECRequest[]
// ============================================================

export interface CSVParseError {
  row: number;
  errors: string[];
}

export interface CSVParseResult {
  forms: Form1099NECRequest[];
  errors: CSVParseError[];
  totalRows: number;
}

/**
 * Parse CSV text into Form1099NECRequest objects.
 * First row must be headers. Columns matched by name (case-insensitive, underscores/dashes/spaces normalized).
 * Payer fields can be provided per-row or via `defaultPayer` for shared payer across all rows.
 */
export function csvToForms(
  csvText: string,
  defaultPayer?: Form1099NECRequest['payer'],
): CSVParseResult {
  const rows = parseCSV(csvText);
  if (rows.length < 2) {
    return {
      forms: [],
      errors: [{ row: 0, errors: ['CSV must have a header row and at least one data row'] }],
      totalRows: 0,
    };
  }

  const headers = rows[0]!.map(normalizeHeader);
  const fieldMap: Array<string | null> = headers.map((h) => COLUMN_MAP[h] ?? null);

  const unmapped = headers.filter((h, i) => !fieldMap[i] && h);
  if (fieldMap.every((f) => f === null)) {
    return {
      forms: [],
      errors: [
        {
          row: 0,
          errors: [
            `No recognized columns. Expected: ${Object.keys(COLUMN_MAP).slice(0, 10).join(', ')}...`,
          ],
        },
      ],
      totalRows: 0,
    };
  }

  const forms: Form1099NECRequest[] = [];
  const errors: CSVParseError[] = [];
  const dataRows = rows.slice(1);

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!;
    const obj: Record<string, unknown> = {};

    // Apply default payer if provided
    if (defaultPayer) {
      obj['payer'] = { ...defaultPayer };
    }

    // Map CSV columns to nested object
    for (let j = 0; j < row.length; j++) {
      const field = fieldMap[j];
      if (!field || !row[j]?.trim()) continue;
      const leafField = field.split('.').pop()!;
      setNested(obj, field, coerce(leafField, row[j]!));
    }

    // Defaults
    if (obj['is_federal_tax_withheld'] === undefined) obj['is_federal_tax_withheld'] = false;
    if (obj['is_state_filing'] === undefined) obj['is_state_filing'] = false;

    // Type-assert and collect
    const form = obj as unknown as Form1099NECRequest;
    const rowErrors: string[] = [];

    // Basic validation before Zod (fast feedback)
    if (!form.payer?.name) rowErrors.push('Missing payer_name');
    if (!form.payer?.tin) rowErrors.push('Missing payer_tin');
    if (!form.recipient?.first_name) rowErrors.push('Missing recipient_first_name');
    if (!form.recipient?.last_name) rowErrors.push('Missing recipient_last_name');
    if (!form.recipient?.tin) rowErrors.push('Missing recipient_tin');
    if (!form.nonemployee_compensation) rowErrors.push('Missing amount/nonemployee_compensation');

    if (rowErrors.length > 0) {
      errors.push({ row: i + 2, errors: rowErrors }); // +2: 1-indexed + header
    } else {
      forms.push(form);
    }
  }

  return { forms, errors, totalRows: dataRows.length };
}
