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
     * Algorithm:
     * 1. Sort both arrays chronologically
     * 2. For each interaction, collect network events within `windowMs` after it
     * 3. Greedy first-match: once a network event is claimed, it's not reused
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

        const claimed = new Set<number>(); // indices of already-matched network events
        const steps: CorrelatedStep[] = [];

        for (let i = 0; i < sortedInteractions.length; i++) {
            const interaction = sortedInteractions[i];
            const interactionTime = getTime(interaction.timestamp);
            const matched: NetworkEvent[] = [];

            for (let j = 0; j < sortedEvents.length; j++) {
                if (claimed.has(j)) continue;

                const eventTime = getTime(sortedEvents[j].timestamp);
                const delta = eventTime - interactionTime;

                // Event must be after the interaction and within the window
                if (delta >= 0 && delta <= this.windowMs) {
                    matched.push(sortedEvents[j]);
                    claimed.add(j);
                }

                // Optimization: if we've passed the window on an unclaimed event, stop
                if (delta > this.windowMs && !claimed.has(j)) break;
            }

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
