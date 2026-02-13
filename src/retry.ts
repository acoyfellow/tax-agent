// ============================================================
// Lightweight retry with exponential backoff + jitter
// ============================================================

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 500) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 5000) */
  maxDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5000;

/** HTTP status codes considered transient (retriable). */
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Determine whether an error is transient and worth retrying.
 *
 * Transient errors include:
 * - Network failures (TypeError from fetch)
 * - HTTP 429 (rate limited)
 * - HTTP 5xx server errors (500, 502, 503, 504)
 *
 * Non-transient errors (4xx client errors except 429) are NOT retried.
 */
export function isTransientError(error: unknown): boolean {
  // Network failures surface as TypeError in fetch
  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof Error) {
    const msg = error.message;

    // Check for HTTP status code patterns in error messages.
    // Matches patterns like "(429):", "(500):", etc.
    const statusMatch = /\((\d{3})\)/.exec(msg);
    if (statusMatch?.[1]) {
      const code = Number(statusMatch[1]);
      return TRANSIENT_STATUS_CODES.has(code);
    }

    // Common network error indicators
    if (
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('socket hang up')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Compute the delay for a given attempt using exponential backoff with jitter.
 *
 * Formula: min(maxDelay, baseDelay * 2^attempt) * random(0.5, 1.0)
 */
export function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  // Full jitter: random value between 50% and 100% of the exponential delay
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.floor(exponential * jitter);
}

/**
 * Retry an async function with exponential backoff and jitter.
 *
 * Only retries on transient errors (network failures, 429, 500, 502, 503, 504).
 * Non-transient errors (e.g. 400, 401, 403, 404) are thrown immediately.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // Don't retry non-transient errors
      if (!isTransientError(error)) {
        throw error;
      }

      // Don't retry if we've exhausted all attempts
      if (attempt >= maxRetries) {
        break;
      }

      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  throw lastError;
}
