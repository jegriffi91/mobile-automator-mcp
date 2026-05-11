import { describe, it, expect } from 'vitest';
import { gridLabel, type Bounds } from './spatial.js';

const ROOT: Bounds = { x: 0, y: 0, width: 393, height: 852 };

describe('gridLabel', () => {
    it('lands a top-left point in tl', () => {
        expect(gridLabel({ x: 10, y: 10, width: 20, height: 20 }, ROOT)).toBe('tl');
    });

    it('lands a top-center point in tc', () => {
        expect(gridLabel({ x: 180, y: 10, width: 30, height: 30 }, ROOT)).toBe('tc');
    });

    it('lands a top-right point in tr', () => {
        expect(gridLabel({ x: 350, y: 10, width: 30, height: 30 }, ROOT)).toBe('tr');
    });

    it('lands a middle-center point in mc', () => {
        expect(gridLabel({ x: 180, y: 400, width: 30, height: 30 }, ROOT)).toBe('mc');
    });

    it('lands a bottom-right point in br', () => {
        expect(gridLabel({ x: 360, y: 800, width: 20, height: 20 }, ROOT)).toBe('br');
    });

    it('puts a full-width top banner in tc (center is at width/2)', () => {
        expect(gridLabel({ x: 0, y: 0, width: 393, height: 80 }, ROOT)).toBe('tc');
    });

    it('puts a full-width bottom tab bar in bc', () => {
        expect(gridLabel({ x: 0, y: 780, width: 393, height: 70 }, ROOT)).toBe('bc');
    });

    it('clamps off-screen-right centers to the right column', () => {
        expect(gridLabel({ x: 1000, y: 10, width: 50, height: 50 }, ROOT)).toBe('tr');
    });

    it('clamps off-screen-top centers to the top row', () => {
        expect(gridLabel({ x: 180, y: -100, width: 30, height: 30 }, ROOT)).toBe('tc');
    });

    it('returns mc for degenerate root bounds', () => {
        expect(gridLabel({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 0 })).toBe('mc');
    });

    it('handles a root that does not start at (0,0)', () => {
        const offsetRoot: Bounds = { x: 100, y: 100, width: 300, height: 300 };
        // Node at (110, 110) is top-left of the offset root.
        expect(gridLabel({ x: 110, y: 110, width: 20, height: 20 }, offsetRoot)).toBe('tl');
        // Node at (390, 390) is bottom-right.
        expect(gridLabel({ x: 380, y: 380, width: 20, height: 20 }, offsetRoot)).toBe('br');
    });

    it('lands exactly on cell boundaries deterministically (floor)', () => {
        // x = 131 → col = floor(131/131) = 1 (tc), not 0 (tl)
        // This documents the boundary behavior so we don't accidentally regress.
        const nodeAtBoundary = { x: 131, y: 5, width: 1, height: 1 };
        // center.x = 131.5 → 131.5/131 ≈ 1.003 → floor = 1
        expect(gridLabel(nodeAtBoundary, ROOT)).toBe('tc');
    });
});
