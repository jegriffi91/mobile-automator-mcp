/**
 * Retry helper for transient Maestro CLI / daemon failures.
 *
 * Scope is intentionally narrow: only hierarchy *reads* use this. Retrying a
 * tap or swipe is dangerous because the action may have partially succeeded on
 * the device — a retry can cause a double-tap, an extra text input, etc.
 * Reads are idempotent and safe to retry.
 */

export interface RetryOptions {
    /** Maximum number of attempts, including the first. Default: 3. */
    maxAttempts?: number;
    /** Initial delay in ms between attempts. Default: 200. Grows exponentially. */
    baseDelayMs?: number;
    /** Cap on the exponential backoff delay. Default: 2000ms. */
    maxDelayMs?: number;
    /** Decide whether an error is worth retrying. Default: always retry. */
    isRetryable?: (err: unknown, attempt: number) => boolean;
    /** Observer for logging / metrics. Called before each backoff sleep. */
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 200;
    const maxDelayMs = options.maxDelayMs ?? 2000;
    const isRetryable = options.isRetryable ?? (() => true);

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts || !isRetryable(err, attempt)) {
                throw err;
            }
            const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
            options.onRetry?.(err, attempt, delayMs);
            await sleep(delayMs);
        }
    }
    // Unreachable — the final attempt always throws or returns.
    throw lastError;
}

/**
 * Classifier for Maestro CLI / daemon errors that are likely transient.
 *
 * Matches on common failure strings we have seen in practice. Leans toward
 * false positives (retry a non-transient error once) rather than false
 * negatives (fail on an otherwise-recoverable hiccup), because the worst case
 * of over-retry is a small latency hit; the worst case of under-retry is a
 * spurious session failure.
 */
export function isTransientMaestroError(err: unknown): boolean {
    const e = err as { message?: string; stderr?: string; code?: string };
    const combined = `${e?.message ?? ''}\n${e?.stderr ?? ''}\n${e?.code ?? ''}`.toLowerCase();
    if (!combined.trim()) return false;
    return (
        combined.includes('timeout') ||
        combined.includes('timed out') ||
        combined.includes('broken pipe') ||
        combined.includes('stream closed') ||
        combined.includes('connection refused') ||
        combined.includes('stdin not writable') ||
        combined.includes('daemon process exited') ||
        combined.includes('eof') ||
        combined.includes('econnreset') ||
        combined.includes('etimedout') ||
        combined.includes('enotconn')
    );
}
