/**
 * retry<T>: bounded exponential backoff with full jitter and AbortSignal support.
 *
 * Defaults: 2 retries (3 total attempts), 250ms→2s capped, factor=2, jitter=full.
 * Sleeps respect `signal` — aborting unblocks immediately and rejects with
 * a RetryAbortError. `isRetryable` decides per-thrown-error whether to keep
 * going; default treats timeouts/network/EAI as retryable, ENOENT/EACCES/EPERM
 * as fatal.
 *
 * Logs each retry attempt to console.error with attempt number, error class,
 * and computed delay so flaky behavior is visible without enabling debug
 * logging.
 */

export interface RetryOptions {
    /** Number of retry attempts after the first try. Default 2. */
    retries?: number;
    /** Base delay in ms before attempt 1. Default 250. */
    initialDelayMs?: number;
    /** Cap on the computed delay. Default 2000. */
    maxDelayMs?: number;
    /** Exponential growth factor. Default 2. */
    factor?: number;
    /** Jitter strategy. 'full' (default) = random in [0, base*factor^n]. */
    jitter?: 'full' | 'none';
    /** Abort-aware: cancels both the in-flight fn and any pending sleep. */
    signal?: AbortSignal;
    /** Per-error decision. Default: see defaultIsRetryable. */
    isRetryable?: (err: unknown, attempt: number) => boolean;
    /** Tag for log lines. Default 'retry'. */
    name?: string;
}

export class RetryAbortError extends Error {
    constructor(message = 'retry aborted') {
        super(message);
        this.name = 'AbortError';
    }
}

const RETRYABLE_CODES = new Set([
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN',
    'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
]);
const NON_RETRYABLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR']);

export function defaultIsRetryable(err: unknown): boolean {
    if (err instanceof RetryAbortError) return false;
    if (err instanceof Error && err.name === 'AbortError') return false;
    const code = (err as { code?: string } | null)?.code;
    if (code && NON_RETRYABLE_CODES.has(code)) return false;
    if (code && RETRYABLE_CODES.has(code)) return true;
    // Heuristic: any "timed out" or "timeout" message is retryable.
    if (err instanceof Error && /timed?\s*out|timeout/i.test(err.message)) return true;
    // Default: retry on Error subclasses, fatal on bare values.
    return err instanceof Error;
}

function computeDelay(
    attempt: number,
    initialDelayMs: number,
    maxDelayMs: number,
    factor: number,
    jitter: 'full' | 'none',
): number {
    const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(factor, attempt));
    return jitter === 'full' ? Math.random() * base : base;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new RetryAbortError('aborted before sleep'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new RetryAbortError('aborted during sleep'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export async function retry<T>(
    fn: (attempt: number) => Promise<T>,
    opts: RetryOptions = {},
): Promise<T> {
    const retries = opts.retries ?? 2;
    const initialDelayMs = opts.initialDelayMs ?? 250;
    const maxDelayMs = opts.maxDelayMs ?? 2000;
    const factor = opts.factor ?? 2;
    const jitter = opts.jitter ?? 'full';
    const isRetryable = opts.isRetryable ?? defaultIsRetryable;
    const name = opts.name ?? 'retry';

    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (opts.signal?.aborted) {
            throw new RetryAbortError(`${name}: aborted before attempt ${attempt + 1}`);
        }
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            if (attempt === retries || !isRetryable(err, attempt)) {
                throw err;
            }
            const delayMs = Math.round(computeDelay(attempt, initialDelayMs, maxDelayMs, factor, jitter));
            // eslint-disable-next-line no-console
            console.error(
                `[${name}] attempt=%d/%d errClass=%s nextDelayMs=%d msg=%s`,
                attempt + 1, retries + 1,
                (err as { name?: string } | null)?.name ?? typeof err,
                delayMs,
                err instanceof Error ? err.message : String(err),
            );
            await sleepWithAbort(delayMs, opts.signal);
        }
    }
    // Unreachable — last iteration throws — but TS narrowing wants this.
    throw lastErr;
}
