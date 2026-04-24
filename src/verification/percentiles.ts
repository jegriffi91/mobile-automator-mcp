/**
 * Percentile helpers for verify_network_performance.
 *
 * Uses linear interpolation between nearest ranks (method R-7, the NumPy default).
 * Returns `undefined` for empty arrays — callers decide how to surface that.
 */

export function percentile(values: number[], p: number): number | undefined {
    if (values.length === 0) return undefined;
    if (p < 0 || p > 100) {
        throw new Error(`Percentile must be in [0, 100], got ${p}`);
    }
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];

    const rank = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    const frac = rank - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export interface DurationStats {
    /** Number of values contributing to the stats (excludes `undefined`). */
    count: number;
    /** Number of events whose `durationMs` was unavailable. */
    unknownDurationCount: number;
    min?: number;
    max?: number;
    p50?: number;
    p95?: number;
}

export function computeDurationStats(durationsMs: Array<number | undefined>): DurationStats {
    const known = durationsMs.filter((d): d is number => typeof d === 'number');
    const unknownDurationCount = durationsMs.length - known.length;
    if (known.length === 0) {
        return { count: 0, unknownDurationCount };
    }
    return {
        count: known.length,
        unknownDurationCount,
        min: Math.min(...known),
        max: Math.max(...known),
        p50: percentile(known, 50),
        p95: percentile(known, 95),
    };
}
