/**
 * Admin tool handler tests — Phase 1.
 *
 * Mocks the Proxyman client and the SessionManager-side state so tests run
 * fully in-memory without touching real Proxyman or a simulator.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { sessionManager } from '../session/index.js';
import {
    handleListActiveSessions,
    handleListActiveMocks,
    handleForceCleanupSession,
    handleForceCleanupMocks,
    handleAuditState,
    _setAdminProxymanClientFactory,
} from './handlers.js';
import type { ProxymanMcpClient } from '../proxymanMcp/client.js';

function makeMockProxymanClient(overrides: Partial<Record<keyof ProxymanMcpClient, unknown>> = {}) {
    const base = {
        isConnected: vi.fn().mockReturnValue(true),
        healthCheck: vi.fn().mockResolvedValue(true),
        listRules: vi.fn().mockResolvedValue([]),
        listRulesByTagPrefix: vi.fn().mockResolvedValue([]),
        deleteRulesByTagPrefix: vi.fn().mockResolvedValue({ deleted: [], failed: [] }),
        deleteRule: vi.fn().mockResolvedValue(undefined),
        getProxyStatus: vi.fn().mockResolvedValue('Recording: Active'),
    };
    return { ...base, ...overrides } as unknown as ProxymanMcpClient;
}

describe('Admin tools (Phase 1)', () => {
    beforeAll(async () => {
        await sessionManager.initialize();
    });

    let restoreFactory: () => unknown;

    beforeEach(() => {
        // Default — replaced per-test as needed.
        restoreFactory = _setAdminProxymanClientFactory(() => makeMockProxymanClient());
    });

    afterEach(() => {
        _setAdminProxymanClientFactory(restoreFactory as () => ProxymanMcpClient);
        // Wipe per-test state on the manager.
        for (const sid of sessionManager.listActiveDrivers()) sessionManager.removeActiveDriver(sid);
        sessionManager.clearStandaloneMocks();
    });

    describe('list_active_sessions', () => {
        it('reports an empty inventory when nothing is running', async () => {
            const out = await handleListActiveSessions({});
            expect(out.totalActiveDrivers).toBe(0);
            expect(out.totalActivePollers).toBe(0);
            // We don't assert sessions==[] — other tests in the same vitest run
            // may leave inactive 'recording' sessions in the shared DB.
        });
    });

    describe('list_active_mocks', () => {
        it('returns proxymanReachable=false when healthCheck fails', async () => {
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({
                    healthCheck: vi.fn().mockResolvedValue(false),
                }),
            );
            const out = await handleListActiveMocks({});
            expect(out.proxymanReachable).toBe(false);
            expect(out.rules).toEqual([]);
        });

        it('classifies rules and reports drift between Proxyman and local ledger', async () => {
            sessionManager.addStandaloneMock('mock-keep', 'RULE-KEEP');
            sessionManager.addStandaloneMock('mock-only-ledger', 'RULE-LEDGER-ONLY');

            const proxymanRules = [
                { id: 'RULE-KEEP', name: 'mca:standalone:mock-keep', url: '*', enabled: true, ruleType: 'scripting' },
                { id: 'RULE-NEW', name: 'mca:standalone:mock-orphan', url: '*', enabled: true, ruleType: 'scripting' },
            ];
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({
                    listRulesByTagPrefix: vi.fn().mockResolvedValue(proxymanRules),
                }),
            );

            const out = await handleListActiveMocks({});
            expect(out.proxymanReachable).toBe(true);
            expect(out.rules.find((r) => r.ruleId === 'RULE-KEEP')?.inLocalLedger).toBe(true);
            expect(out.rules.find((r) => r.ruleId === 'RULE-NEW')?.inLocalLedger).toBe(false);
            expect(out.drift.rulesNotInLedger).toContain('RULE-NEW');
            expect(out.drift.ledgerNotInProxyman).toContain('RULE-LEDGER-ONLY');
        });
    });

    describe('force_cleanup_session', () => {
        it('returns a clean structured result when nothing is registered', async () => {
            const out = await handleForceCleanupSession({ sessionId: 'never-existed', reason: 'test' });
            expect(out.errors).toEqual([]);
            expect(out.pollerStopped).toBe(false);
            expect(out.driverRemoved).toBe(false);
            expect(out.sessionMarkedAborted).toBe(false);
        });

        it('reports proxymanReachable=false when health check fails', async () => {
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({
                    healthCheck: vi.fn().mockResolvedValue(false),
                }),
            );
            const out = await handleForceCleanupSession({ sessionId: 'x', reason: 'test' });
            expect(out.proxymanReachable).toBe(false);
            expect(out.proxymanRulesDeleted).toBe(0);
        });

        it('forwards Proxyman delete failures into errors[] without throwing', async () => {
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({
                    deleteRulesByTagPrefix: vi.fn().mockResolvedValue({
                        deleted: ['ID1'],
                        failed: [{ id: 'ID2', error: 'denied' }],
                    }),
                }),
            );
            const out = await handleForceCleanupSession({ sessionId: 'x', reason: 'test' });
            expect(out.proxymanRulesDeleted).toBe(1);
            expect(out.errors.some((e) => e.includes('ID2'))).toBe(true);
        });
    });

    describe('force_cleanup_mocks', () => {
        it('clears standalone-scope mocks even when Proxyman is offline', async () => {
            sessionManager.addStandaloneMock('m1', 'R1');
            sessionManager.addStandaloneMock('m2', 'R2');
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({ healthCheck: vi.fn().mockResolvedValue(false) }),
            );
            const out = await handleForceCleanupMocks({ scope: 'standalone' });
            expect(out.proxymanReachable).toBe(false);
            expect(out.rulesDeleted).toBe(0);
            expect(out.ledgerEntriesCleared).toBe(2);
            expect(sessionManager.standaloneMockCount()).toBe(0);
        });

        it('all-scope clears standalone + per-session ledgers and drives prefix delete', async () => {
            sessionManager.addStandaloneMock('m', 'R-STAND');
            sessionManager.addSessionMock('sess-1', 'mock-1', 'R-SESS-1');

            const deleteSpy = vi.fn().mockResolvedValue({ deleted: ['R-STAND', 'R-SESS-1'], failed: [] });
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({ deleteRulesByTagPrefix: deleteSpy }),
            );

            const out = await handleForceCleanupMocks({ scope: 'all' });
            expect(out.scope).toBe('all');
            expect(out.rulesDeleted).toBe(2);
            expect(out.ledgerEntriesCleared).toBe(2);
            // Tag prefix is "mca:" for all-scope.
            expect(deleteSpy).toHaveBeenCalledWith('mca:', 'scripting');
            expect(sessionManager.listSessionMocks('sess-1')).toEqual([]);
            expect(sessionManager.standaloneMockCount()).toBe(0);
        });
    });

    describe('audit_state', () => {
        it('returns a structured snapshot with reachable=false when Proxyman is down', async () => {
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({ healthCheck: vi.fn().mockResolvedValue(false) }),
            );
            const out = await handleAuditState({});
            expect(out.proxyman.reachable).toBe(false);
            expect(out.proxyman.totalRules).toBe(0);
            expect(typeof out.generatedAt).toBe('string');
            expect(out.sessions.byStatus).toBeTypeOf('object');
        });

        it('counts mca-tagged rules and surfaces session-orphans', async () => {
            const allRules = [
                { id: 'A', name: 'mca:ghost-session:m1', url: '*', enabled: true, ruleType: 'scripting' },
                { id: 'B', name: 'mca:standalone:m1', url: '*', enabled: true, ruleType: 'scripting' },
                { id: 'C', name: 'UnrelatedUserRule', url: '*', enabled: true, ruleType: 'scripting' },
            ];
            _setAdminProxymanClientFactory(() =>
                makeMockProxymanClient({
                    listRules: vi.fn().mockResolvedValue(allRules),
                }),
            );
            const out = await handleAuditState({});
            expect(out.proxyman.reachable).toBe(true);
            expect(out.proxyman.totalRules).toBe(3);
            expect(out.proxyman.mcaTaggedRules).toBe(2);
            expect(out.orphans.proxymanRulesWithoutSession).toContain('A');
            // Standalone rules are tagged mca:standalone — not session-orphans.
            expect(out.orphans.proxymanRulesWithoutSession).not.toContain('B');
        });
    });
});
