import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { verifyWebhookSignature, parseWebhookPayload } from './webhook';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function computeSignature(
  clientId: string,
  clientSecret: string,
  timestamp: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const message = `${clientId}\n${timestamp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'super-secret-key';
const TIMESTAMP = '2024-01-15T12:00:00Z';

// ---------------------------------------------------------------------------
// Tests — verifyWebhookSignature
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature', () => {
  it('returns true for a valid signature', async () => {
    const sig = await computeSignature(CLIENT_ID, CLIENT_SECRET, TIMESTAMP);
    const result = await Effect.runPromise(
      verifyWebhookSignature(CLIENT_ID, CLIENT_SECRET, sig, TIMESTAMP),
    );
    expect(result).toBe(true);
  });

  it('returns false for an invalid signature', async () => {
    const result = await Effect.runPromise(
      verifyWebhookSignature(CLIENT_ID, CLIENT_SECRET, 'bad-signature', TIMESTAMP),
    );
    expect(result).toBe(false);
  });

  it('returns false for empty inputs', async () => {
    const result = await Effect.runPromise(verifyWebhookSignature('', '', '', ''));
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — parseWebhookPayload
// ---------------------------------------------------------------------------

describe('parseWebhookPayload', () => {
  const validPayload = {
    SubmissionId: 'sub-123',
    FormType: 'FORM1099NEC',
    Records: [
      {
        RecordId: 'rec-1',
        RecipientId: null,
        PayeeRef: null,
        AccountNum: null,
        Status: 'ACCEPTED',
        StatusCode: 1,
        FilingReference: null,
        StatusTime: '2024-01-15T12:00:00Z',
        RejectedBy: null,
        Errors: null,
      },
    ],
  };

  it('parses a valid payload correctly', () => {
    const result = parseWebhookPayload(validPayload);
    expect(result).not.toBeNull();
    expect(result!.SubmissionId).toBe('sub-123');
    expect(result!.FormType).toBe('FORM1099NEC');
    expect(result!.Records).toHaveLength(1);
    expect(result!.Records[0]!.Status).toBe('ACCEPTED');
  });

  it('returns null for null input', () => {
    expect(parseWebhookPayload(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseWebhookPayload(undefined)).toBeNull();
  });

  it('returns null when SubmissionId is missing', () => {
    const { SubmissionId: _, ...rest } = validPayload;
    expect(parseWebhookPayload(rest)).toBeNull();
  });

  it('returns null when Records is missing', () => {
    const { Records: _, ...rest } = validPayload;
    expect(parseWebhookPayload(rest)).toBeNull();
  });

  it('returns null when Records is not an array', () => {
    expect(parseWebhookPayload({ ...validPayload, Records: 'not-an-array' })).toBeNull();
  });
});
