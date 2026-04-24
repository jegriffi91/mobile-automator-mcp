import { describe, it, expect } from 'vitest';
import { percentile, computeDurationStats } from './percentiles.js';

describe('percentile', () => {
    it('returns undefined for an empty array', () => {
        expect(percentile([], 50)).toBeUndefined();
    });

    it('returns the single value when array has one element', () => {
        expect(percentile([42], 50)).toBe(42);
        expect(percentile([42], 95)).toBe(42);
    });

    it('computes the median correctly for odd-length arrays', () => {
        expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    });

    it('interpolates the median for even-length arrays', () => {
        expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5);
    });

    it('computes p95', () => {
        const values = Array.from({ length: 20 }, (_, i) => i + 1);
        expect(percentile(values, 95)).toBeCloseTo(19.05, 1);
    });

    it('rejects out-of-range percentiles', () => {
        expect(() => percentile([1, 2], -1)).toThrow();
        expect(() => percentile([1, 2], 101)).toThrow();
    });

    it('ignores original array order', () => {
        expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    });
});

describe('computeDurationStats', () => {
    it('returns zero counts for an empty input', () => {
        expect(computeDurationStats([])).toEqual({ count: 0, unknownDurationCount: 0 });
    });

    it('reports unknownDurationCount separately', () => {
        const stats = computeDurationStats([100, undefined, 200, undefined]);
        expect(stats.count).toBe(2);
        expect(stats.unknownDurationCount).toBe(2);
        expect(stats.min).toBe(100);
        expect(stats.max).toBe(200);
    });

    it('computes min/max/p50/p95 for known values', () => {
        const stats = computeDurationStats([100, 200, 300, 400, 500]);
        expect(stats.min).toBe(100);
        expect(stats.max).toBe(500);
        expect(stats.p50).toBe(300);
    });

    it('handles all-unknown durations gracefully', () => {
        expect(computeDurationStats([undefined, undefined])).toEqual({
            count: 0,
            unknownDurationCount: 2,
        });
    });
});
