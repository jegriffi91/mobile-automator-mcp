/**
 * Anchor resolution and windowing for verify_network_* tools.
 *
 * An `AfterActionRef` points at a prior UIInteraction using one of:
 *  - an ISO-8601 timestamp (exact escape hatch)
 *  - a 0-based index into `getInteractions()` (deterministic for generated tests)
 *  - a case-insensitive substring on `UIInteraction.element` (ergonomic default)
 */

import { sessionManager } from '../session/index.js';
import type { NetworkEvent, UIElement, UIInteraction } from '../types.js';

export type AfterActionRef =
    | { kind: 'timestamp'; value: string }
    | { kind: 'index'; value: number }
    | { kind: 'elementText'; value: string };

export interface ResolvedAnchor {
    /** ISO-8601 timestamp of the anchor */
    timestamp: string;
    /** The interaction the anchor resolved to, when available */
    interaction?: UIInteraction;
}

function elementHaystack(el: UIElement): string {
    return [el.id, el.testId, el.accessibilityLabel, el.text]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' | ')
        .toLowerCase();
}

/**
 * Resolve an `AfterActionRef` to a session-anchored timestamp.
 * Returns `null` if the reference cannot be matched (e.g., out-of-range index).
 */
export async function resolveAfterAction(
    sessionId: string,
    ref: AfterActionRef,
): Promise<ResolvedAnchor | null> {
    if (ref.kind === 'timestamp') {
        const t = new Date(ref.value).getTime();
        if (Number.isNaN(t)) return null;
        return { timestamp: ref.value };
    }

    const interactions = await sessionManager.getInteractions(sessionId);

    if (ref.kind === 'index') {
        if (ref.value < 0 || ref.value >= interactions.length) return null;
        const hit = interactions[ref.value];
        return { timestamp: hit.timestamp, interaction: hit };
    }

    // elementText: first interaction whose element fields contain the substring.
    const needle = ref.value.toLowerCase();
    const hit = interactions.find((i) => elementHaystack(i.element).includes(needle));
    if (!hit) return null;
    return { timestamp: hit.timestamp, interaction: hit };
}

/** Events whose timestamps fall in `[anchorMs, anchorMs + windowMs]`. */
export function eventsInWindow(
    events: NetworkEvent[],
    anchorMs: number,
    windowMs: number,
): NetworkEvent[] {
    const endMs = anchorMs + windowMs;
    return events.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= anchorMs && t <= endMs;
    });
}
