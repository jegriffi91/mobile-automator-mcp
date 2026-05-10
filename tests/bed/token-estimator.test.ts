import { describe, it, expect } from 'vitest';
import { estimateTokens, compareTokens } from './token-estimator.js';

describe('estimateTokens', () => {
    it('returns 0 for an empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('uses ceil so single-character inputs round up to 1', () => {
        expect(estimateTokens('a')).toBe(1);
    });

    it('returns roughly chars/3.5 for typical English', () => {
        const text = 'a'.repeat(350);
        expect(estimateTokens(text)).toBe(100);
    });

    it('rounds up partial tokens', () => {
        expect(estimateTokens('a'.repeat(8))).toBe(3); // 8/3.5 = 2.28 → 3
    });
});

describe('compareTokens', () => {
    it('reports zero delta when heuristic equals real', () => {
        const s = compareTokens(100, 100);
        expect(s.deltaPct).toBe(0);
        expect(s.withinTolerance).toBe(true);
    });

    it('flags drift outside the default ±15% band', () => {
        const high = compareTokens(100, 120);
        expect(high.withinTolerance).toBe(false);
        const low = compareTokens(100, 80);
        expect(low.withinTolerance).toBe(false);
    });

    it('accepts a 10% spread within the default tolerance', () => {
        expect(compareTokens(100, 110).withinTolerance).toBe(true);
        expect(compareTokens(100, 90).withinTolerance).toBe(true);
    });

    it('handles a zero heuristic without dividing by zero', () => {
        const s = compareTokens(0, 5);
        expect(s.deltaPct).toBe(0);
        expect(s.withinTolerance).toBe(true);
    });

    it('honors a custom tolerance', () => {
        // 20% spread, 25% tolerance → within
        expect(compareTokens(100, 120, 0.25).withinTolerance).toBe(true);
        // 20% spread, 10% tolerance → outside
        expect(compareTokens(100, 120, 0.10).withinTolerance).toBe(false);
    });
});
