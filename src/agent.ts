import type { Env, TaxFilingRequest, ValidationResult, ValidationIssue } from './types';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Build a structured prompt for the AI to validate tax data.
 * We ask it to return JSON with specific fields.
 */
function buildValidationPrompt(data: TaxFilingRequest): string {
  const totalWages = data.w2s?.reduce((sum, w) => sum + w.wages, 0) ?? 0;
  const totalWithheld = data.w2s?.reduce((sum, w) => sum + w.federal_tax_withheld, 0) ?? 0;
  const total1099 = data.income_1099s?.reduce((sum, i) => sum + i.amount, 0) ?? 0;
  const totalScheduleC = data.schedule_c_businesses?.reduce((sum, b) => sum + b.gross_income - b.expenses, 0) ?? 0;
  const totalIncome = (totalWages + total1099 + totalScheduleC) / 100;

  return `You are a tax data reviewer. Format and field validation has ALREADY PASSED — do NOT re-check SSN length, phone format, state codes, ZIP codes, or whether fields exist. Those are correct.

Your job is ONLY to check for semantic issues a human tax preparer would catch:
- Is the withholding ratio reasonable for the income level?
- Does the occupation match the income sources (e.g., W-2 vs 1099)?
- Are there any red flags the IRS would question?
- Is anything inconsistent between the data points?

If everything looks reasonable, return {"valid": true, "issues": [], "summary": "Data looks ready for filing"}

If you find real issues, return {"valid": false, "issues": [{"field": "...", "message": "...", "severity": "warning"}], "summary": "..."}

Use severity "warning" for things worth reviewing and "info" for suggestions. Never use "error" — that is reserved for the structural validator.

Tax Filing Data:
- Name: ${data.taxpayer.first_name} ${data.taxpayer.last_name}
- DOB: ${data.taxpayer.date_of_birth}
- Occupation: ${data.taxpayer.occupation}
- Location: ${data.address.city}, ${data.address.state}
- Filing Year: ${data.filing_year ?? new Date().getFullYear()}
- Total Income: $${totalIncome.toLocaleString()}
${data.w2s?.length ? `- W-2s: ${data.w2s.length} (wages $${(totalWages / 100).toLocaleString()}, withheld $${(totalWithheld / 100).toLocaleString()})` : '- W-2s: none'}
${data.income_1099s?.length ? `- 1099s: ${data.income_1099s.length} (total $${(total1099 / 100).toLocaleString()})` : '- 1099s: none'}
${data.schedule_c_businesses?.length ? `- Schedule C: ${data.schedule_c_businesses.length} (net $${(totalScheduleC / 100).toLocaleString()})` : '- Schedule C: none'}
- Bank account for refund: ${data.refund_bank_account ? 'yes' : 'no'}

Return ONLY valid JSON, no markdown fences, no explanation.`;
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
function parseAiResponse(raw: unknown): { issues: ValidationIssue[]; summary: string } {
  const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    let cleaned = rawStr.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    // Try to extract the outermost JSON object
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return { issues: [], summary: `AI returned non-JSON response: ${rawStr.slice(0, 100)}` };
    }

    const jsonStr = cleaned.slice(start, end + 1);
    const parsed = JSON.parse(jsonStr) as {
      valid?: boolean;
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
  } catch (e) {
    return { issues: [], summary: `AI parse error: ${e instanceof Error ? e.message : String(e)} | raw: ${rawStr.slice(0, 200)}` };
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

    const responseText = typeof aiResponse.response === 'string'
      ? aiResponse.response
      : JSON.stringify(aiResponse.response ?? aiResponse);
    const aiResult = parseAiResponse(responseText);

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
