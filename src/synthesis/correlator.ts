/**
 * Correlator — Maps network events to UI interactions by timestamp proximity.
 *
 * Uses a sliding time window to associate network events that occurred
 * shortly after a UI interaction (e.g., a tap triggering an API call).
 */

import type { UIInteraction, NetworkEvent } from '../types.js';

export interface CorrelatedStep {
    /** Chronological index in the test flow */
    index: number;
    /** The UI action that was performed */
    interaction: UIInteraction;
    /** Network event(s) that occurred within a time window of this interaction */
    networkEvents: NetworkEvent[];
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
        // Sort both by timestamp ascending
        const sortedInteractions = [...interactions].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        const sortedEvents = [...networkEvents].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        const claimed = new Set<number>(); // indices of already-matched network events
        const steps: CorrelatedStep[] = [];

        for (let i = 0; i < sortedInteractions.length; i++) {
            const interaction = sortedInteractions[i];
            const interactionTime = new Date(interaction.timestamp).getTime();
            const matched: NetworkEvent[] = [];

            for (let j = 0; j < sortedEvents.length; j++) {
                if (claimed.has(j)) continue;

                const eventTime = new Date(sortedEvents[j].timestamp).getTime();
                const delta = eventTime - interactionTime;

                // Event must be after the interaction and within the window
                if (delta >= 0 && delta <= this.windowMs) {
                    matched.push(sortedEvents[j]);
                    claimed.add(j);
                }

                // Optimization: if we've passed the window on an unclaimed event, stop
                if (delta > this.windowMs && !claimed.has(j)) break;
            }

            steps.push({
                index: i,
                interaction,
                networkEvents: matched,
            });
        }

        return steps;
    }
}
