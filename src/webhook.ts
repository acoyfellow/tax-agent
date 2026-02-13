import { Effect } from 'effect';
import type { Env } from './types';

/** TaxBandits webhook payload for e-file status changes */
export interface WebhookPayload {
  SubmissionId: string;
  FormType: string;
  Records: Array<{
    RecordId: string;
    RecipientId: string | null;
    PayeeRef: string | null;
    AccountNum: string | null;
    Status: string;
    StatusCode: number;
    FilingReference: unknown;
    StatusTime: string;
    RejectedBy: string | null;
    Errors: Array<{
      Id: string | null;
      Code: string;
      Name: string;
      Message: string;
      Type: string;
    }> | null;
  }>;
}

/** Verify HMAC-SHA256 signature from TaxBandits webhook */
export function verifyWebhookSignature(
  clientId: string,
  clientSecret: string,
  signature: string,
  timestamp: string,
): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => {
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
      const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
      return expected === signature;
    },
    catch: () => false, // signature verification failure = reject
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

/** Parse and validate a webhook payload */
export function parseWebhookPayload(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== 'object') return null;
  const payload = body as Record<string, unknown>;
  if (typeof payload['SubmissionId'] !== 'string') return null;
  if (typeof payload['FormType'] !== 'string') return null;
  if (!Array.isArray(payload['Records'])) return null;
  return body as WebhookPayload;
}
