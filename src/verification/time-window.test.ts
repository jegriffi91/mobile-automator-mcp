import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIInteraction, NetworkEvent } from '../types.js';

const getInteractionsMock = vi.fn<(sessionId: string) => Promise<UIInteraction[]>>();

vi.mock('../session/index.js', () => ({
    sessionManager: {
        getInteractions: (sessionId: string) => getInteractionsMock(sessionId),
    },
}));

// Import after mocking so the module picks up the mocked sessionManager.
const { resolveAfterAction, eventsInWindow } = await import('./time-window.js');

const interactions: UIInteraction[] = [
    {
        sessionId: 's1',
        timestamp: '2024-01-01T00:00:01.000Z',
        actionType: 'tap',
        element: { id: 'login-button', text: 'Sign in' },
    },
    {
        sessionId: 's1',
        timestamp: '2024-01-01T00:00:02.000Z',
        actionType: 'tap',
        element: { text: 'Equifax', accessibilityLabel: 'equifax-tab' },
    },
    {
        sessionId: 's1',
        timestamp: '2024-01-01T00:00:03.000Z',
        actionType: 'tap',
        element: { id: 'dashboard' },
    },
];

beforeEach(() => {
    getInteractionsMock.mockReset();
    getInteractionsMock.mockResolvedValue(interactions);
});

describe('resolveAfterAction', () => {
    it('resolves a timestamp reference to itself', async () => {
        const anchor = await resolveAfterAction('s1', {
            kind: 'timestamp',
            value: '2024-01-01T00:00:05.000Z',
        });
        expect(anchor?.timestamp).toBe('2024-01-01T00:00:05.000Z');
        expect(getInteractionsMock).not.toHaveBeenCalled();
    });

    it('returns null for an invalid timestamp', async () => {
        const anchor = await resolveAfterAction('s1', { kind: 'timestamp', value: 'not-a-date' });
        expect(anchor).toBeNull();
    });

    it('resolves an index to the corresponding interaction timestamp', async () => {
        const anchor = await resolveAfterAction('s1', { kind: 'index', value: 1 });
        expect(anchor?.timestamp).toBe('2024-01-01T00:00:02.000Z');
        expect(anchor?.interaction?.element.text).toBe('Equifax');
    });

    it('returns null for an out-of-range index', async () => {
        expect(await resolveAfterAction('s1', { kind: 'index', value: 99 })).toBeNull();
        expect(await resolveAfterAction('s1', { kind: 'index', value: -1 })).toBeNull();
    });

    it('resolves elementText via case-insensitive substring across id/label/text', async () => {
        const byText = await resolveAfterAction('s1', { kind: 'elementText', value: 'equifax' });
        expect(byText?.interaction?.element.text).toBe('Equifax');

        const byLabel = await resolveAfterAction('s1', { kind: 'elementText', value: 'LOGIN' });
        expect(byLabel?.interaction?.element.id).toBe('login-button');
    });

    it('returns null when elementText does not match any interaction', async () => {
        expect(
            await resolveAfterAction('s1', { kind: 'elementText', value: 'nonexistent' }),
        ).toBeNull();
    });
});

describe('eventsInWindow', () => {
    const anchorMs = new Date('2024-01-01T00:00:00.000Z').getTime();
    const ev = (ts: string): NetworkEvent => ({
        sessionId: 's1',
        timestamp: ts,
        method: 'GET',
        url: 'https://api.example.com',
        statusCode: 200,
    });

    it('includes events at the lower boundary', () => {
        const result = eventsInWindow([ev('2024-01-01T00:00:00.000Z')], anchorMs, 1000);
        expect(result).toHaveLength(1);
    });

    it('includes events at the upper boundary', () => {
        const result = eventsInWindow([ev('2024-01-01T00:00:01.000Z')], anchorMs, 1000);
        expect(result).toHaveLength(1);
    });

    it('excludes events before the anchor', () => {
        const result = eventsInWindow([ev('2023-12-31T23:59:59.000Z')], anchorMs, 1000);
        expect(result).toHaveLength(0);
    });

    it('excludes events after the window', () => {
        const result = eventsInWindow([ev('2024-01-01T00:00:01.001Z')], anchorMs, 1000);
        expect(result).toHaveLength(0);
    });
});
