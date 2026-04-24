import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkEvent } from '../types.js';

const getMergedEventsMock = vi.fn<
    (sessionId: string, opts?: unknown) => Promise<{ merged: NetworkEvent[]; scopedProxymanEvents: NetworkEvent[] }>
>();

vi.mock('./event-source.js', () => ({
    getMergedEvents: (sessionId: string, opts?: unknown) => getMergedEventsMock(sessionId, opts),
}));

// The handler is defined in src/handlers.ts, which pulls in a lot of side-effectful
// modules (sessionManager, McpServer, proxyman, etc.). To keep this test focused on
// the assertion logic, we import the handler indirectly via a dynamic import and
// stub sessionManager as well.
vi.mock('../session/index.js', () => ({
    sessionManager: {
        getInteractions: vi.fn().mockResolvedValue([]),
        getNetworkEvents: vi.fn().mockResolvedValue([]),
        getSession: vi.fn().mockResolvedValue(null),
        batchLogNetworkEvents: vi.fn().mockResolvedValue(undefined),
    },
}));

const { handleVerifyNetworkParallelism } = await import('../handlers.js');

function makeEvent(ts: string, op: string): NetworkEvent {
    return {
        sessionId: 's1',
        timestamp: ts,
        method: 'POST',
        url: 'https://api.example.com/graphql',
        statusCode: 200,
        requestBody: JSON.stringify({ operationName: op }),
    };
}

beforeEach(() => {
    getMergedEventsMock.mockReset();
});

describe('handleVerifyNetworkParallelism', () => {
    it('passes when enough matching requests fire within the window', async () => {
        const events = [
            makeEvent('2024-01-01T00:00:00.000Z', 'SduiAsset'),
            makeEvent('2024-01-01T00:00:00.200Z', 'SduiListV2'),
            makeEvent('2024-01-01T00:00:00.500Z', 'SduiTabs'),
        ];
        getMergedEventsMock.mockResolvedValue({ merged: events, scopedProxymanEvents: events });

        const result = await handleVerifyNetworkParallelism({
            sessionId: 's1',
            matcher: { operationMatches: '^Sdui' },
            maxWindowMs: 1000,
            minExpectedCount: 3,
        });

        expect(result.passed).toBe(true);
        expect(result.count).toBe(3);
        expect(result.actualSpanMs).toBe(500);
    });

    it('fails when fewer than minExpectedCount match', async () => {
        const events = [makeEvent('2024-01-01T00:00:00.000Z', 'SduiAsset')];
        getMergedEventsMock.mockResolvedValue({ merged: events, scopedProxymanEvents: events });

        const result = await handleVerifyNetworkParallelism({
            sessionId: 's1',
            matcher: { operationMatches: '^Sdui' },
            maxWindowMs: 1000,
            minExpectedCount: 3,
        });

        expect(result.passed).toBe(false);
        expect(result.verdict).toContain('≥3');
    });

    it('fails when the span exceeds maxWindowMs', async () => {
        const events = [
            makeEvent('2024-01-01T00:00:00.000Z', 'SduiAsset'),
            makeEvent('2024-01-01T00:00:03.000Z', 'SduiListV2'),
        ];
        getMergedEventsMock.mockResolvedValue({ merged: events, scopedProxymanEvents: events });

        const result = await handleVerifyNetworkParallelism({
            sessionId: 's1',
            matcher: { operationMatches: '^Sdui' },
            maxWindowMs: 1000,
            minExpectedCount: 2,
        });

        expect(result.passed).toBe(false);
        expect(result.verdict).toContain('exceeds');
    });

    it('returns zero counts when nothing matches', async () => {
        getMergedEventsMock.mockResolvedValue({ merged: [], scopedProxymanEvents: [] });

        const result = await handleVerifyNetworkParallelism({
            sessionId: 's1',
            matcher: { pathContains: '/nomatch' },
            maxWindowMs: 1000,
            minExpectedCount: 1,
        });

        expect(result.passed).toBe(false);
        expect(result.count).toBe(0);
    });
});
