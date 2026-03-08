/**
 * SegmentFingerprint — Deterministic hashing of correlated recording flows.
 *
 * Produces a content-addressable fingerprint from the sequence of
 * (actionType, target, endpoints) in a recording. Two recordings of the
 * same user flow at different times produce the same fingerprint.
 */

import { createHash } from 'crypto';
import type { CorrelatedStep } from '../synthesis/correlator.js';

export class SegmentFingerprint {
    /**
     * Compute a deterministic SHA-256 fingerprint from correlated steps.
     *
     * The fingerprint is based on:
     *   - actionType (tap, type, scroll, etc.)
     *   - target element (id > accessibilityLabel > text)
     *   - correlated endpoint patterns (method:path, sorted)
     *
     * Timestamps, response bodies, and durations are intentionally excluded
     * so identical flows recorded at different times produce the same hash.
     */
    static compute(steps: CorrelatedStep[]): string {
        const sequence = steps
            .map((step) => {
                const action = step.interaction.actionType;
                const target =
                    step.interaction.element.id ??
                    step.interaction.element.accessibilityLabel ??
                    step.interaction.element.text ??
                    '_';
                const endpoints = step.networkCaptures
                    .map((c) => `${c.requestPattern.method}:${c.requestPattern.pathPattern}`)
                    .sort()
                    .join(',');
                return `${action}|${target}|${endpoints}`;
            })
            .join('→');

        return createHash('sha256').update(sequence).digest('hex').slice(0, 12);
    }

    /**
     * Build the raw sequence string (useful for debugging / display).
     */
    static sequenceString(steps: CorrelatedStep[]): string {
        return steps
            .map((step) => {
                const action = step.interaction.actionType;
                const target =
                    step.interaction.element.id ??
                    step.interaction.element.accessibilityLabel ??
                    step.interaction.element.text ??
                    '_';
                const endpoints = step.networkCaptures
                    .map((c) => `${c.requestPattern.method}:${c.requestPattern.pathPattern}`)
                    .sort()
                    .join(',');
                return `${action}|${target}|${endpoints}`;
            })
            .join('→');
    }

    /**
     * Compute Jaccard similarity (0–1) between two step sequences.
     *
     * Uses the set of `action|target` pairs (ignoring network captures)
     * so partial flow overlaps are detected even if endpoints differ.
     */
    static similarity(stepsA: CorrelatedStep[], stepsB: CorrelatedStep[]): number {
        const setA = new Set(
            stepsA.map((s) => {
                const target =
                    s.interaction.element.id ??
                    s.interaction.element.accessibilityLabel ??
                    s.interaction.element.text ??
                    '_';
                return `${s.interaction.actionType}|${target}`;
            })
        );
        const setB = new Set(
            stepsB.map((s) => {
                const target =
                    s.interaction.element.id ??
                    s.interaction.element.accessibilityLabel ??
                    s.interaction.element.text ??
                    '_';
                return `${s.interaction.actionType}|${target}`;
            })
        );

        const intersection = new Set([...setA].filter((x) => setB.has(x)));
        const union = new Set([...setA, ...setB]);

        if (union.size === 0) return 1.0; // both empty
        return intersection.size / union.size;
    }
}
