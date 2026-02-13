import type { Env, TaxFilingRequest, ValidationResult, ValidationIssue } from './types';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Build a structured prompt for the AI to validate tax data.
 * We ask it to return JSON with specific fields.
 */
function buildValidationPrompt(data: TaxFilingRequest): string {
  return `You are a tax data validation assistant. Review the following tax filing data for errors, inconsistencies, or missing information. Respond ONLY with valid JSON matching this schema:

{
  "valid": boolean,
  "issues": [{ "field": "string", "message": "string", "severity": "error" | "warning" | "info" }],
  "summary": "one-sentence summary"
}

Tax Filing Data:
- Name: ${data.taxpayer.first_name} ${data.taxpayer.last_name}
- SSN: ***-**-${data.taxpayer.social_security_number.slice(-4)}
- DOB: ${data.taxpayer.date_of_birth}
- Occupation: ${data.taxpayer.occupation}
- Address: ${data.address.address}, ${data.address.city}, ${data.address.state} ${data.address.zip_code}
- Filing Year: ${data.filing_year ?? new Date().getFullYear()}
${data.w2s?.length ? `- W-2s: ${data.w2s.length} form(s), total wages $${data.w2s.reduce((sum, w) => sum + w.wages, 0) / 100}` : '- W-2s: none'}
${data.income_1099s?.length ? `- 1099s: ${data.income_1099s.length} form(s), total $${data.income_1099s.reduce((sum, i) => sum + i.amount, 0) / 100}` : '- 1099s: none'}
${data.schedule_c_businesses?.length ? `- Schedule C: ${data.schedule_c_businesses.length} business(es)` : '- Schedule C: none'}
${data.refund_bank_account ? '- Refund bank account: provided' : '- Refund bank account: not provided'}

Validate:
1. SSN is 9 digits
2. DOB makes the person at least 16 years old
3. State is a valid 2-letter US state abbreviation
4. ZIP code is 5 digits
5. Phone is 10 digits
6. At least one income source (W-2 or 1099 or Schedule C)
7. Bank routing number is 9 digits (if provided)
8. W-2 EINs are in XX-XXXXXXX format (if provided)
9. All monetary amounts are non-negative
10. Filing year is current or previous year

Return ONLY the JSON object, no markdown, no explanation.`;
}

/**
 * Run local (non-AI) structural validations that don't need a model.
 * These catch obvious format errors before wasting an AI call.
 */
function runStructuralValidations(data: TaxFilingRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // SSN format
  if (!/^\d{9}$/.test(data.taxpayer.social_security_number)) {
    issues.push({ field: 'taxpayer.social_security_number', message: 'SSN must be exactly 9 digits', severity: 'error' });
  }

  // Phone format
  if (!/^\d{10}$/.test(data.taxpayer.phone)) {
    issues.push({ field: 'taxpayer.phone', message: 'Phone must be exactly 10 digits', severity: 'error' });
  }

  // State format
  const validStates = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC',
  ]);
  if (!validStates.has(data.address.state)) {
    issues.push({ field: 'address.state', message: `Invalid state: ${data.address.state}`, severity: 'error' });
  }

  // ZIP format
  if (!/^\d{5}$/.test(data.address.zip_code)) {
    issues.push({ field: 'address.zip_code', message: 'ZIP code must be 5 digits', severity: 'error' });
  }

  // DOB — must be at least 16
  const dob = new Date(data.taxpayer.date_of_birth);
  const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (age < 16) {
    issues.push({ field: 'taxpayer.date_of_birth', message: 'Taxpayer must be at least 16 years old', severity: 'error' });
  }

  // At least one income source
  const hasIncome = (data.w2s?.length ?? 0) > 0
    || (data.income_1099s?.length ?? 0) > 0
    || (data.schedule_c_businesses?.length ?? 0) > 0;
  if (!hasIncome) {
    issues.push({ field: 'income', message: 'At least one income source (W-2, 1099, or Schedule C) is required', severity: 'error' });
  }

  // Bank routing numbers
  if (data.refund_bank_account && !/^\d{9}$/.test(data.refund_bank_account.routing_number)) {
    issues.push({ field: 'refund_bank_account.routing_number', message: 'Routing number must be 9 digits', severity: 'error' });
  }
  if (data.payment_bank_account && !/^\d{9}$/.test(data.payment_bank_account.routing_number)) {
    issues.push({ field: 'payment_bank_account.routing_number', message: 'Routing number must be 9 digits', severity: 'error' });
  }

  // W-2 EIN format
  data.w2s?.forEach((w2, i) => {
    if (!/^\d{2}-\d{7}$/.test(w2.employer_ein)) {
      issues.push({ field: `w2s[${i}].employer_ein`, message: `Invalid EIN format: ${w2.employer_ein}`, severity: 'error' });
    }
    if (w2.wages < 0) {
      issues.push({ field: `w2s[${i}].wages`, message: 'Wages cannot be negative', severity: 'error' });
    }
  });

  // Filing year
  const currentYear = new Date().getFullYear();
  const filingYear = data.filing_year ?? currentYear;
  if (filingYear < currentYear - 1 || filingYear > currentYear) {
    issues.push({ field: 'filing_year', message: `Filing year must be ${currentYear - 1} or ${currentYear}`, severity: 'warning' });
  }

  return issues;
}

/**
 * Parse the AI response, handling malformed JSON gracefully.
 */
function parseAiResponse(raw: string): { issues: ValidationIssue[]; summary: string } {
  try {
    // Try to extract JSON from the response (AI might wrap it in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch?.[0]) {
      return { issues: [], summary: 'AI returned non-JSON response' };
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      issues?: Array<{ field?: string; message?: string; severity?: string }>;
      summary?: string;
    };
    const issues: ValidationIssue[] = (parsed.issues ?? []).map((i) => ({
      field: i.field ?? 'unknown',
      message: i.message ?? 'Unknown issue',
      severity: (i.severity === 'error' || i.severity === 'warning' || i.severity === 'info')
        ? i.severity
        : 'warning',
    }));
    return { issues, summary: parsed.summary ?? 'Validation complete' };
  } catch {
    return { issues: [], summary: 'AI response could not be parsed' };
  }
}

/**
 * Validate tax filing data using both structural checks and Workers AI.
 */
export async function validateTaxData(
  env: Env,
  data: TaxFilingRequest,
): Promise<ValidationResult> {
  // 1. Run structural validations first (fast, no AI needed)
  const structuralIssues = runStructuralValidations(data);

  // If there are hard errors, don't bother calling AI
  const hasErrors = structuralIssues.some((i) => i.severity === 'error');
  if (hasErrors) {
    return {
      valid: false,
      issues: structuralIssues,
      summary: `Found ${structuralIssues.length} structural issue(s) — fix these before AI review`,
      ai_model: 'none (structural checks only)',
    };
  }

  // 2. Call Workers AI for deeper semantic validation
  try {
    const prompt = buildValidationPrompt(data);
    const aiResponse = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'You are a precise tax data validator. Return ONLY valid JSON.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0.1, // low temp for consistent structured output
    }) as { response?: string };

    const aiResult = parseAiResponse(aiResponse.response ?? '');

    // Merge structural warnings with AI findings
    const allIssues = [...structuralIssues, ...aiResult.issues];
    const valid = !allIssues.some((i) => i.severity === 'error');

    return {
      valid,
      issues: allIssues,
      summary: aiResult.summary,
      ai_model: AI_MODEL,
    };
  } catch (err) {
    // AI failed — still return structural results
    return {
      valid: !hasErrors,
      issues: structuralIssues,
      summary: `AI validation unavailable (${err instanceof Error ? err.message : 'unknown error'}), structural checks passed`,
      ai_model: `${AI_MODEL} (failed)`,
    };
  }
}
