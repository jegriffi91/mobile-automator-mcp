/**
 * Correlator — Maps network events to UI interactions by timestamp proximity.
 *
 * Uses a sliding time window to associate network events that occurred
 * shortly after a UI interaction (e.g., a tap triggering an API call).
 */

import type { UIInteraction, NetworkEvent } from '../types.js';

export interface CorrelatedNetworkCapture {
    /** Original network event with full response body */
    event: NetworkEvent;
    /** Request pattern for WireMock matching */
    requestPattern: { method: string; pathPattern: string };
    /** Generated fixture ID, e.g., "get_api_lore_doom" */
    fixtureId: string;
}

export interface CorrelatedStep {
    /** Chronological index in the test flow */
    index: number;
    /** The UI action that was performed */
    interaction: UIInteraction;
    /** Network event(s) that occurred within a time window of this interaction */
    networkEvents: NetworkEvent[];
    /** Enhanced network captures with request patterns and fixture IDs */
    networkCaptures: CorrelatedNetworkCapture[];
}

export class Correlator {
    /** Time window (ms) to match network events to a UI action */
    private windowMs: number;

    constructor(windowMs = 3000) {
        this.windowMs = windowMs;
    }

    /**
     * Correlate UI interactions with network events by timestamp proximity.
     *
     * Algorithm (nearest-preceding):
     * 1. Sort both arrays chronologically
     * 2. For each network event, find the nearest interaction that precedes it
     *    within `windowMs`
     * 3. If multiple interactions precede a network event, the closest one wins
     *
     * This produces better causal attribution than greedy earliest-claim when
     * UI steps are sparse (e.g., missed login flow) and network bursts are dense.
     */
    correlate(
        interactions: UIInteraction[],
        networkEvents: NetworkEvent[]
    ): CorrelatedStep[] {
        // Pre-parse timestamps to avoid repeated Date allocations in sort + correlation
        const timeCache = new Map<string, number>();
        const getTime = (ts: string): number => {
            let t = timeCache.get(ts);
            if (t === undefined) {
                t = new Date(ts).getTime();
                timeCache.set(ts, t);
            }
            return t;
        };

        // Sort both by timestamp ascending
        const sortedInteractions = [...interactions].sort(
            (a, b) => getTime(a.timestamp) - getTime(b.timestamp)
        );
        const sortedEvents = [...networkEvents].sort(
            (a, b) => getTime(a.timestamp) - getTime(b.timestamp)
        );

        // Map: interaction index → collected network events
        const matchMap = new Map<number, { events: NetworkEvent[] }>();
        for (let i = 0; i < sortedInteractions.length; i++) {
            matchMap.set(i, { events: [] });
        }

        // For each network event, find the nearest preceding interaction within the window
        for (const event of sortedEvents) {
            const eventTime = getTime(event.timestamp);
            let bestIdx = -1;
            let bestDelta = Infinity;

            for (let i = sortedInteractions.length - 1; i >= 0; i--) {
                const interactionTime = getTime(sortedInteractions[i].timestamp);
                const delta = eventTime - interactionTime;

                // Event must be after the interaction and within the window
                if (delta >= 0 && delta <= this.windowMs) {
                    if (delta < bestDelta) {
                        bestDelta = delta;
                        bestIdx = i;
                    }
                    // Since interactions are sorted ascending and we're iterating
                    // backwards, the first match is the nearest preceding one.
                    break;
                }

                // If this interaction is after the event, keep looking backwards
                if (delta < 0) continue;

                // If delta > windowMs, all earlier interactions are even further away
                if (delta > this.windowMs) break;
            }

            if (bestIdx >= 0) {
                matchMap.get(bestIdx)!.events.push(event);
            }
        }

        // Build correlated steps
        const steps: CorrelatedStep[] = [];
        for (let i = 0; i < sortedInteractions.length; i++) {
            const interaction = sortedInteractions[i];
            const matched = matchMap.get(i)!.events;

            // Build enhanced network captures with fixture metadata
            const captures: CorrelatedNetworkCapture[] = matched.map((event) => {
                let pathname: string;
                try {
                    pathname = new URL(event.url).pathname;
                } catch {
                    // Relative URL (e.g., "/api/login") — use as-is
                    pathname = event.url.split('?')[0];
                }
                return {
                    event,
                    requestPattern: {
                        method: event.method,
                        pathPattern: pathname,
                    },
                    fixtureId: Correlator.toFixtureId(event.method, pathname),
                };
            });

            steps.push({
                index: i,
                interaction,
                networkEvents: matched,
                networkCaptures: captures,
            });
        }

        return steps;
    }

    /**
     * Generate a filesystem-safe fixture ID from HTTP method + URL path.
     * e.g., "GET", "/api/lore/doom" → "get_api_lore_doom"
     */
    static toFixtureId(method: string, urlPath: string): string {
        const sanitized = urlPath
            .replace(/^\//, '')        // strip leading slash
            .replace(/[^a-zA-Z0-9]/g, '_')  // replace non-alphanumeric with _
            .replace(/_+/g, '_')       // collapse multiple underscores
            .replace(/_$/, '');        // strip trailing underscore
        return `${method.toLowerCase()}_${sanitized}`;
    }
}
