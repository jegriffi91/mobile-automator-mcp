import { describe, it, expect } from 'vitest';
import { SegmentFingerprint } from './fingerprint.js';
import type { CorrelatedStep } from '../synthesis/correlator.js';
import type { UIInteraction, NetworkEvent } from '../types.js';

// ── Test helpers ──

function makeInteraction(
    actionType: UIInteraction['actionType'],
    elementId: string,
    textInput?: string
): UIInteraction {
    return {
        sessionId: 'test-session',
        timestamp: '2026-01-01T00:00:00.000Z',
        actionType,
        element: { id: elementId },
        textInput,
    };
}

function makeNetworkEvent(method: string, path: string): NetworkEvent {
    return {
        sessionId: 'test-session',
        timestamp: '2026-01-01T00:00:01.000Z',
        method,
        url: `http://localhost:3030${path}`,
        statusCode: 200,
    };
}

function makeStep(
    index: number,
    interaction: UIInteraction,
    endpoints: Array<{ method: string; path: string }> = []
): CorrelatedStep {
    const networkEvents = endpoints.map((e) => makeNetworkEvent(e.method, e.path));
    const networkCaptures = endpoints.map((e) => ({
        event: makeNetworkEvent(e.method, e.path),
        requestPattern: { method: e.method, pathPattern: e.path },
        fixtureId: `${e.method.toLowerCase()}_${e.path.replace(/\//g, '_').replace(/^_/, '')}`,
    }));
    return { index, interaction, networkEvents, networkCaptures };
}

// ── Tests ──

describe('SegmentFingerprint', () => {
    describe('compute()', () => {
        it('should produce the same fingerprint for identical step sequences', () => {
            const steps: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'usernameField')),
                makeStep(1, makeInteraction('type', 'usernameField', 'user@test.com')),
                makeStep(2, makeInteraction('tap', 'loginButton'), [
                    { method: 'POST', path: '/api/login' },
                ]),
            ];

            const fp1 = SegmentFingerprint.compute(steps);
            const fp2 = SegmentFingerprint.compute(steps);
            expect(fp1).toBe(fp2);
        });

        it('should produce a 12-character hex string', () => {
            const steps: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton')),
            ];
            const fp = SegmentFingerprint.compute(steps);
            expect(fp).toMatch(/^[0-9a-f]{12}$/);
        });

        it('should produce different fingerprints for different action sequences', () => {
            const stepsA: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton')),
            ];
            const stepsB: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'signupButton')),
            ];
            expect(SegmentFingerprint.compute(stepsA)).not.toBe(
                SegmentFingerprint.compute(stepsB)
            );
        });

        it('should produce different fingerprints when endpoints differ', () => {
            const stepsA: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton'), [
                    { method: 'POST', path: '/api/login' },
                ]),
            ];
            const stepsB: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton'), [
                    { method: 'POST', path: '/api/signup' },
                ]),
            ];
            expect(SegmentFingerprint.compute(stepsA)).not.toBe(
                SegmentFingerprint.compute(stepsB)
            );
        });

        it('should be order-sensitive for actions', () => {
            const stepsA: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'fieldA')),
                makeStep(1, makeInteraction('tap', 'fieldB')),
            ];
            const stepsB: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'fieldB')),
                makeStep(1, makeInteraction('tap', 'fieldA')),
            ];
            expect(SegmentFingerprint.compute(stepsA)).not.toBe(
                SegmentFingerprint.compute(stepsB)
            );
        });

        it('should handle steps with no network captures', () => {
            const steps: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'someButton')),
                makeStep(1, makeInteraction('scroll', '_')),
            ];
            const fp = SegmentFingerprint.compute(steps);
            expect(fp).toMatch(/^[0-9a-f]{12}$/);
        });

        it('should handle empty steps array', () => {
            const fp = SegmentFingerprint.compute([]);
            expect(fp).toMatch(/^[0-9a-f]{12}$/);
        });
    });

    describe('similarity()', () => {
        it('should return 1.0 for identical sequences', () => {
            const steps: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton')),
                makeStep(1, makeInteraction('type', 'usernameField', 'test')),
            ];
            expect(SegmentFingerprint.similarity(steps, steps)).toBe(1.0);
        });

        it('should return 0 for completely different sequences', () => {
            const stepsA: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton')),
            ];
            const stepsB: CorrelatedStep[] = [
                makeStep(0, makeInteraction('scroll', 'feedList')),
            ];
            expect(SegmentFingerprint.similarity(stepsA, stepsB)).toBe(0);
        });

        it('should return partial similarity for overlapping sequences', () => {
            const stepsA: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton')),
                makeStep(1, makeInteraction('type', 'usernameField', 'test')),
            ];
            const stepsB: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton')),
                makeStep(1, makeInteraction('tap', 'signupButton')),
            ];
            const sim = SegmentFingerprint.similarity(stepsA, stepsB);
            // Jaccard: intersection={tap|loginButton} / union={tap|loginButton, type|usernameField, tap|signupButton}
            expect(sim).toBeCloseTo(1 / 3, 5);
        });

        it('should return 1.0 for two empty sequences', () => {
            expect(SegmentFingerprint.similarity([], [])).toBe(1.0);
        });
    });

    describe('sequenceString()', () => {
        it('should produce a human-readable sequence', () => {
            const steps: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'loginButton'), [
                    { method: 'POST', path: '/api/login' },
                ]),
            ];
            const seq = SegmentFingerprint.sequenceString(steps);
            expect(seq).toBe('tap|loginButton|POST:/api/login');
        });

        it('should join multiple steps with arrow separator', () => {
            const steps: CorrelatedStep[] = [
                makeStep(0, makeInteraction('tap', 'fieldA')),
                makeStep(1, makeInteraction('type', 'fieldA', 'hello')),
            ];
            const seq = SegmentFingerprint.sequenceString(steps);
            expect(seq).toBe('tap|fieldA|→type|fieldA|');
        });
    });
});
