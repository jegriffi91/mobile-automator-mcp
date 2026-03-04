import { describe, it, expect } from 'vitest';
import { Correlator } from './correlator.js';
import type { UIInteraction, NetworkEvent } from '../types.js';

function makeInteraction(overrides: Partial<UIInteraction> = {}): UIInteraction {
    return {
        sessionId: 'test-session',
        timestamp: '2024-01-01T00:00:00.000Z',
        actionType: 'tap',
        element: { id: 'btn1' },
        ...overrides,
    };
}

function makeNetworkEvent(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
    return {
        sessionId: 'test-session',
        timestamp: '2024-01-01T00:00:01.000Z',
        method: 'GET',
        url: 'https://api.example.com/data',
        statusCode: 200,
        ...overrides,
    };
}

describe('Correlator', () => {
    it('should match network events within the default 3s window', () => {
        const correlator = new Correlator();
        const interactions = [
            makeInteraction({ timestamp: '2024-01-01T00:00:00.000Z' }),
        ];
        const events = [
            makeNetworkEvent({ timestamp: '2024-01-01T00:00:01.000Z' }), // +1s, within
            makeNetworkEvent({ timestamp: '2024-01-01T00:00:02.500Z' }), // +2.5s, within
        ];

        const steps = correlator.correlate(interactions, events);
        expect(steps).toHaveLength(1);
        expect(steps[0].networkEvents).toHaveLength(2);
    });

    it('should NOT match events outside the window', () => {
        const correlator = new Correlator(1000); // 1s window
        const interactions = [
            makeInteraction({ timestamp: '2024-01-01T00:00:00.000Z' }),
        ];
        const events = [
            makeNetworkEvent({ timestamp: '2024-01-01T00:00:02.000Z' }), // +2s, outside
        ];

        const steps = correlator.correlate(interactions, events);
        expect(steps[0].networkEvents).toHaveLength(0);
    });

    it('should NOT match events that occurred before the interaction', () => {
        const correlator = new Correlator();
        const interactions = [
            makeInteraction({ timestamp: '2024-01-01T00:00:05.000Z' }),
        ];
        const events = [
            makeNetworkEvent({ timestamp: '2024-01-01T00:00:01.000Z' }), // before
        ];

        const steps = correlator.correlate(interactions, events);
        expect(steps[0].networkEvents).toHaveLength(0);
    });

    it('should use greedy first-match (no event reuse)', () => {
        const correlator = new Correlator(5000);
        const interactions = [
            makeInteraction({ timestamp: '2024-01-01T00:00:00.000Z' }),
            makeInteraction({ timestamp: '2024-01-01T00:00:01.000Z', actionType: 'type' }),
        ];
        const events = [
            makeNetworkEvent({ timestamp: '2024-01-01T00:00:00.500Z' }), // +0.5s from first
        ];

        const steps = correlator.correlate(interactions, events);
        expect(steps[0].networkEvents).toHaveLength(1);
        expect(steps[1].networkEvents).toHaveLength(0); // already claimed
    });

    it('should handle empty interactions', () => {
        const correlator = new Correlator();
        const steps = correlator.correlate([], [makeNetworkEvent()]);
        expect(steps).toHaveLength(0);
    });

    it('should handle empty network events', () => {
        const correlator = new Correlator();
        const steps = correlator.correlate([makeInteraction()], []);
        expect(steps).toHaveLength(1);
        expect(steps[0].networkEvents).toHaveLength(0);
    });

    it('should sort inputs before correlating', () => {
        const correlator = new Correlator();
        // Provide in reverse order
        const interactions = [
            makeInteraction({ timestamp: '2024-01-01T00:00:05.000Z', actionType: 'type' }),
            makeInteraction({ timestamp: '2024-01-01T00:00:00.000Z', actionType: 'tap' }),
        ];
        const events = [
            makeNetworkEvent({ timestamp: '2024-01-01T00:00:01.000Z', url: '/early' }),
            makeNetworkEvent({ timestamp: '2024-01-01T00:00:06.000Z', url: '/late' }),
        ];

        const steps = correlator.correlate(interactions, events);
        // First chronologically is the tap at t=0
        expect(steps[0].interaction.actionType).toBe('tap');
        expect(steps[0].networkEvents[0].url).toBe('/early');
        // Second is the type at t=5
        expect(steps[1].interaction.actionType).toBe('type');
        expect(steps[1].networkEvents[0].url).toBe('/late');
    });
});
