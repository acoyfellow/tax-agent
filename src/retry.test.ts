import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryWithBackoff, isTransientError, computeDelay } from './retry';

// ---------------------------------------------------------------------------
// isTransientError()
// ---------------------------------------------------------------------------
describe('isTransientError', () => {
  it('returns true for TypeError (network failure)', () => {
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true);
  });

  it('returns true for 429 Too Many Requests', () => {
    expect(isTransientError(new Error('API error (429): rate limited'))).toBe(true);
  });

  it('returns true for 500 Internal Server Error', () => {
    expect(isTransientError(new Error('TaxBandits API error (500): internal'))).toBe(true);
  });

  it('returns true for 502 Bad Gateway', () => {
    expect(isTransientError(new Error('API error (502): bad gateway'))).toBe(true);
  });

  it('returns true for 503 Service Unavailable', () => {
    expect(isTransientError(new Error('API error (503): unavailable'))).toBe(true);
  });

  it('returns true for 504 Gateway Timeout', () => {
    expect(isTransientError(new Error('API error (504): timeout'))).toBe(true);
  });

  it('returns false for 400 Bad Request', () => {
    expect(isTransientError(new Error('API error (400): bad request'))).toBe(false);
  });

  it('returns false for 401 Unauthorized', () => {
    expect(isTransientError(new Error('API error (401): unauthorized'))).toBe(false);
  });

  it('returns false for 403 Forbidden', () => {
    expect(isTransientError(new Error('API error (403): forbidden'))).toBe(false);
  });

  it('returns false for 404 Not Found', () => {
    expect(isTransientError(new Error('API error (404): not found'))).toBe(false);
  });

  it('returns true for ECONNRESET errors', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns true for ETIMEDOUT errors', () => {
    expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('returns true for ECONNREFUSED errors', () => {
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('returns false for generic errors', () => {
    expect(isTransientError(new Error('something went wrong'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeDelay()
// ---------------------------------------------------------------------------
describe('computeDelay', () => {
  it('applies exponential growth', () => {
    // With jitter between 0.5-1.0, delay is in [base*2^attempt*0.5, base*2^attempt]
    // Attempt 0: base=500 -> [250, 500]
    // Attempt 1: base=500*2=1000 -> [500, 1000]
    // Attempt 2: base=500*4=2000 -> [1000, 2000]
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(computeDelay(0, 500, 5000));
    }
    // All delays at attempt 0 should be in [250, 500]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(500);
    }
  });

  it('respects maxDelayMs cap', () => {
    // Attempt 10 with base 500 would be 500*1024 = 512000 without cap
    for (let i = 0; i < 50; i++) {
      const delay = computeDelay(10, 500, 5000);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });

  it('applies jitter (not always the same value)', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) {
      delays.add(computeDelay(1, 500, 5000));
    }
    // With jitter, we should get multiple distinct values
    expect(delays.size).toBeGreaterThan(1);
  });

  it('increases delay with attempt number', () => {
    // Average of many samples should be higher for higher attempts
    let sum0 = 0;
    let sum2 = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      sum0 += computeDelay(0, 500, 50000);
      sum2 += computeDelay(2, 500, 50000);
    }
    expect(sum2 / n).toBeGreaterThan(sum0 / n);
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff()
// ---------------------------------------------------------------------------
describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on first try without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const promise = retryWithBackoff(fn);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('TaxBandits API error (500): internal'))
      .mockResolvedValue('recovered');

    const promise = retryWithBackoff(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    // Advance past the backoff delay
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries exhausted', async () => {
    const transientError = new Error('TaxBandits API error (503): unavailable');
    const fn = vi.fn().mockRejectedValue(transientError);

    const promise = retryWithBackoff(fn, {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 500,
    });

    // Advance timers enough for all retries
    await vi.advanceTimersByTimeAsync(10000);

    await expect(promise).rejects.toThrow('(503)');
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 400 Bad Request', async () => {
    const clientError = new Error('TaxBandits API error (400): bad request');
    const fn = vi.fn().mockRejectedValue(clientError);

    await expect(retryWithBackoff(fn)).rejects.toThrow('(400)');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 Unauthorized', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('API error (401): unauthorized'));

    await expect(retryWithBackoff(fn)).rejects.toThrow('(401)');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 403 Forbidden', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('API error (403): forbidden'));

    await expect(retryWithBackoff(fn)).rejects.toThrow('(403)');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 Too Many Requests', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('API error (429): rate limited'))
      .mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 Internal Server Error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('API error (500): server error'))
      .mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 Bad Gateway', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('API error (502): bad gateway'))
      .mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 Service Unavailable', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('API error (503): unavailable'))
      .mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 504 Gateway Timeout', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('API error (504): timeout'))
      .mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on network TypeError', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects custom maxRetries option', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('API error (500): fail'));

    const promise = retryWithBackoff(fn, {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });
    await vi.advanceTimersByTimeAsync(10000);

    await expect(promise).rejects.toThrow('(500)');
    // 1 initial + 5 retries = 6
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('respects maxRetries=0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('API error (500): fail'));

    await expect(retryWithBackoff(fn, { maxRetries: 0 })).rejects.toThrow('(500)');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits with exponential backoff between retries', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('API error (500): fail'))
      .mockRejectedValueOnce(new Error('API error (500): fail'))
      .mockResolvedValue('ok');

    // Use deterministic jitter by mocking Math.random to return 1.0
    // jitter = 0.5 + 1.0 * 0.5 = 1.0, so delay = baseDelay * 2^attempt
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1.0);

    const promise = retryWithBackoff(fn, {
      baseDelayMs: 100,
      maxDelayMs: 10000,
    });

    // After attempt 0 fails: delay = 100 * 2^0 * 1.0 = 100ms
    // fn should not be called again yet
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // After attempt 1 fails: delay = 100 * 2^1 * 1.0 = 200ms
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(3);

    expect(await promise).toBe('ok');

    randomSpy.mockRestore();
  });

  it('preserves the original error on exhaustion', async () => {
    const originalError = new Error('TaxBandits API error (503): service down');
    const fn = vi.fn().mockRejectedValue(originalError);

    const promise = retryWithBackoff(fn, {
      maxRetries: 1,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });
    await vi.advanceTimersByTimeAsync(10000);

    await expect(promise).rejects.toBe(originalError);
  });

  it('returns the resolved value type correctly', async () => {
    const fn = vi.fn().mockResolvedValue({ id: 123, name: 'test' });
    const result = await retryWithBackoff(fn);
    expect(result).toEqual({ id: 123, name: 'test' });
  });
});
