/**
 * Local char-based token estimator.
 *
 * Approximate, ±15% in practice. We never get ground truth without an
 * Anthropic API call — when `--with-llm` is on, the bed cross-checks this
 * heuristic against `usage.input_tokens` from the `claude -p` response and
 * logs the delta so we can recalibrate if it drifts.
 *
 * The 3.5 chars/token divisor sits slightly below the ~4 chars/token English
 * average so the estimate overshoots by default — that gives us margin
 * against the 2,000-token hard cap.
 */

const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface TokenSpread {
    heuristic: number;
    real: number;
    deltaPct: number;     // (real - heuristic) / heuristic
    withinTolerance: boolean;
}

/**
 * Compare a heuristic estimate against a real `usage.input_tokens` value.
 * `tolerance` defaults to 0.15 (±15%).
 */
export function compareTokens(heuristic: number, real: number, tolerance = 0.15): TokenSpread {
    const deltaPct = heuristic === 0 ? 0 : (real - heuristic) / heuristic;
    return {
        heuristic,
        real,
        deltaPct,
        withinTolerance: Math.abs(deltaPct) <= tolerance,
    };
}
