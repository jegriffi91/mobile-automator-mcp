import { describe, it, expect, vi } from 'vitest';
import { retry, defaultIsRetryable, RetryAbortError } from './retry.js';

describe('retry', () => {
    it('returns first-try success without sleeping', async () => {
        const fn = vi.fn(async () => 'ok');
        const result = await retry(fn, { jitter: 'none' });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns after 2 failures + success on attempt 3', async () => {
        let calls = 0;
        const fn = vi.fn(async () => {
            calls += 1;
            if (calls < 3) {
                const err: NodeJS.ErrnoException = new Error('flake');
                err.code = 'ECONNRESET';
                throw err;
            }
            return 'ok';
        });
        const result = await retry(fn, { retries: 2, initialDelayMs: 1, maxDelayMs: 1, jitter: 'none' });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('throws after retries+1 failures, preserving the last error', async () => {
        let calls = 0;
        const fn = vi.fn(async () => {
            calls += 1;
            const err: NodeJS.ErrnoException = new Error(`fail-${calls}`);
            err.code = 'ECONNRESET';
            throw err;
        });
        await expect(
            retry(fn, { retries: 2, initialDelayMs: 1, maxDelayMs: 1, jitter: 'none' }),
        ).rejects.toThrow('fail-3');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-retryable error (ENOENT)', async () => {
        const fn = vi.fn(async () => {
            const err: NodeJS.ErrnoException = new Error('missing');
            err.code = 'ENOENT';
            throw err;
        });
        await expect(
            retry(fn, { retries: 3, initialDelayMs: 1, jitter: 'none' }),
        ).rejects.toThrow('missing');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws RetryAbortError immediately when signal already aborted', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const fn = vi.fn(async () => 'ok');
        await expect(
            retry(fn, { retries: 2, signal: ctrl.signal, jitter: 'none' }),
        ).rejects.toBeInstanceOf(RetryAbortError);
        expect(fn).not.toHaveBeenCalled();
    });

    it('aborts during sleep', async () => {
        const ctrl = new AbortController();
        let calls = 0;
        const fn = vi.fn(async () => {
            calls += 1;
            const err: NodeJS.ErrnoException = new Error('flake');
            err.code = 'ECONNRESET';
            throw err;
        });
        const promise = retry(fn, {
            retries: 5,
            initialDelayMs: 5_000,
            maxDelayMs: 5_000,
            signal: ctrl.signal,
            jitter: 'none',
        });
        // Abort on next tick (after first failure starts sleeping)
        setTimeout(() => ctrl.abort(), 10);
        await expect(promise).rejects.toBeInstanceOf(RetryAbortError);
        // Only the first attempt ran; the sleep was aborted.
        expect(calls).toBe(1);
    });

    it('jitter=none yields exact exponential delay (cap-honoring)', async () => {
        const fn = vi.fn(async (attempt: number) => {
            if (attempt < 2) throw new Error('timeout');
            return 'ok';
        });
        const start = Date.now();
        await retry(fn, {
            retries: 2,
            initialDelayMs: 50,
            maxDelayMs: 1000,
            factor: 2,
            jitter: 'none',
        });
        const elapsed = Date.now() - start;
        // Expected: 50ms (after attempt 0) + 100ms (after attempt 1) = 150ms
        expect(elapsed).toBeGreaterThanOrEqual(140);
        // Loose upper bound — CI scheduler may add overhead.
        expect(elapsed).toBeLessThan(1000);
    });
});

describe('defaultIsRetryable', () => {
    it('treats timeout messages as retryable', () => {
        expect(defaultIsRetryable(new Error('operation timed out'))).toBe(true);
        expect(defaultIsRetryable(new Error('TIMEOUT exceeded'))).toBe(true);
    });

    it('treats ENOENT errors as non-retryable', () => {
        const err: NodeJS.ErrnoException = new Error('not found');
        err.code = 'ENOENT';
        expect(defaultIsRetryable(err)).toBe(false);
    });

    it('treats AbortError as non-retryable', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        expect(defaultIsRetryable(err)).toBe(false);
    });

    it('treats RetryAbortError as non-retryable', () => {
        expect(defaultIsRetryable(new RetryAbortError())).toBe(false);
    });

    it('treats ECONNRESET as retryable', () => {
        const err: NodeJS.ErrnoException = new Error('boom');
        err.code = 'ECONNRESET';
        expect(defaultIsRetryable(err)).toBe(true);
    });

    it('treats bare non-Error values as non-retryable', () => {
        expect(defaultIsRetryable('string error')).toBe(false);
        expect(defaultIsRetryable(null)).toBe(false);
    });
});
