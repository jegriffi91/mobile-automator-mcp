import { describe, it, expect, vi } from 'vitest';
import { withRetry, isTransientMaestroError } from './retry.js';

describe('withRetry()', () => {
    it('returns the result on first success without retrying', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await withRetry(fn);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries when fn rejects and eventually succeeds', async () => {
        let calls = 0;
        const fn = vi.fn().mockImplementation(() => {
            calls += 1;
            if (calls < 3) return Promise.reject(new Error('boom'));
            return Promise.resolve('ok');
        });
        const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('stops after maxAttempts and rethrows the last error', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('still broken'));
        await expect(
            withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }),
        ).rejects.toThrow('still broken');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry when isRetryable returns false', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fatal'));
        await expect(
            withRetry(fn, {
                maxAttempts: 3,
                baseDelayMs: 1,
                isRetryable: () => false,
            }),
        ).rejects.toThrow('fatal');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('invokes onRetry callback before each backoff', async () => {
        const onRetry = vi.fn();
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('a'))
            .mockRejectedValueOnce(new Error('b'))
            .mockResolvedValueOnce('ok');
        const result = await withRetry(fn, {
            baseDelayMs: 1,
            maxDelayMs: 1,
            onRetry,
        });
        expect(result).toBe('ok');
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry.mock.calls[0][1]).toBe(1);
        expect(onRetry.mock.calls[1][1]).toBe(2);
    });

    it('applies exponential backoff capped by maxDelayMs', async () => {
        const delays: number[] = [];
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('a'))
            .mockRejectedValueOnce(new Error('b'))
            .mockRejectedValueOnce(new Error('c'))
            .mockResolvedValueOnce('ok');
        await withRetry(fn, {
            maxAttempts: 4,
            baseDelayMs: 100,
            maxDelayMs: 250,
            onRetry: (_err, _attempt, delayMs) => {
                delays.push(delayMs);
            },
        });
        // Attempt 1 fails → delay 100
        // Attempt 2 fails → delay 200
        // Attempt 3 fails → delay 400 → capped at 250
        expect(delays).toEqual([100, 200, 250]);
    });
});

describe('isTransientMaestroError()', () => {
    it('flags common Maestro transient-failure strings', () => {
        expect(isTransientMaestroError(new Error('Command timed out'))).toBe(true);
        expect(isTransientMaestroError(new Error('broken pipe'))).toBe(true);
        expect(isTransientMaestroError(new Error('Stream closed'))).toBe(true);
        expect(isTransientMaestroError(new Error('Daemon stdin not writable'))).toBe(true);
        expect(
            isTransientMaestroError(new Error('MaestroDaemon process exited (code: 1, signal: null)')),
        ).toBe(true);
        expect(isTransientMaestroError({ code: 'ECONNRESET' })).toBe(true);
        expect(isTransientMaestroError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    it('does not flag non-transient errors', () => {
        expect(isTransientMaestroError(new Error('Syntax error in YAML'))).toBe(false);
        expect(isTransientMaestroError(new Error('Element not found'))).toBe(false);
        expect(isTransientMaestroError(null)).toBe(false);
        expect(isTransientMaestroError({})).toBe(false);
    });

    it('inspects stderr in addition to message', () => {
        const err = { message: '', stderr: 'connection refused by remote host' };
        expect(isTransientMaestroError(err)).toBe(true);
    });
});
