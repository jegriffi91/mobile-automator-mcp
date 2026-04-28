/**
 * Admin tool handler tests — Phase 1 + Phase 6.
 *
 * Mocks the Proxyman client and the SessionManager-side state so tests run
 * fully in-memory without touching real Proxyman or a simulator.
 */

import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { sessionManager } from '../session/index.js';
import {
    handleListActiveSessions,
    handleListActiveMocks,
    handleForceCleanupSession,
    handleForceCleanupMocks,
    handleAuditState,
    handleForceCleanupArtifacts,
    _setAdminProxymanClientFactory,
} from './handlers.js';
import type { ProxymanMcpClient } from '../proxymanMcp/client.js';
import type { FlowExecutionRecord } from '../types.js';

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

    // ── force_cleanup_artifacts ───────────────────────────────────────────────

    describe('force_cleanup_artifacts', () => {
        // Per-test tmpdir so tests are fully isolated.
        let testTmpDir: string;

        beforeEach(async () => {
            testTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mca-test-artifacts-'));
        });

        afterEach(async () => {
            vi.restoreAllMocks();
            try {
                await fs.rm(testTmpDir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        });

        function makeOldDebugDir(name: string): string {
            return path.join(testTmpDir, name);
        }

        async function createOldDir(dirPath: string, contentBytes = 512): Promise<void> {
            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(path.join(dirPath, 'commands-1.json'), 'x'.repeat(contentBytes));
            // Back-date mtime to 48 hours ago so it exceeds the 24h default cutoff.
            const oldTime = new Date(Date.now() - 48 * 3600 * 1000);
            await fs.utimes(dirPath, oldTime, oldTime);
        }

        async function createRecentDir(dirPath: string): Promise<void> {
            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(path.join(dirPath, 'commands-1.json'), 'data');
            // mtime is now (within the last second) — newer than the 24h cutoff.
        }

        it('removes an old debug-output dir and reports correct counters', async () => {
            const debugDir = makeOldDebugDir('old-debug');
            await createOldDir(debugDir, 256);

            const executions: FlowExecutionRecord[] = [{
                flowName: 'myFlow',
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationMs: 1000,
                output: '',
                succeeded: true,
                debugOutputDir: debugDir,
            }];
            vi.spyOn(sessionManager, 'listAllSessions').mockReturnValue([{ id: 'sess-a' }] as ReturnType<typeof sessionManager.listAllSessions>);
            vi.spyOn(sessionManager, 'getFlowExecutions').mockReturnValue(executions);

            const out = await handleForceCleanupArtifacts({});

            expect(out.artifactsRemoved).toBe(1);
            expect(out.bytesFreed).toBeGreaterThan(0);
            expect(out.directoriesScanned).toBe(1);
            expect(out.dryRun).toBe(false);
            expect(out.errors).toEqual([]);
            expect(out.perSession).toHaveLength(1);
            expect(out.perSession[0].sessionId).toBe('sess-a');
            expect(out.perSession[0].artifactsRemoved).toBe(1);

            // Directory should be gone.
            await expect(fs.stat(debugDir)).rejects.toThrow();
        });

        it('skips a recently-created dir (mtime newer than cutoff)', async () => {
            const debugDir = makeOldDebugDir('recent-debug');
            await createRecentDir(debugDir);

            const executions: FlowExecutionRecord[] = [{
                flowName: 'myFlow',
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationMs: 500,
                output: '',
                succeeded: true,
                debugOutputDir: debugDir,
            }];
            vi.spyOn(sessionManager, 'listAllSessions').mockReturnValue([{ id: 'sess-b' }] as ReturnType<typeof sessionManager.listAllSessions>);
            vi.spyOn(sessionManager, 'getFlowExecutions').mockReturnValue(executions);

            const out = await handleForceCleanupArtifacts({ olderThanHours: 24 });

            expect(out.artifactsRemoved).toBe(0);
            expect(out.bytesFreed).toBe(0);
            expect(out.directoriesScanned).toBe(1);
            expect(out.errors).toEqual([]);

            // Directory should still exist.
            const stat = await fs.stat(debugDir);
            expect(stat.isDirectory()).toBe(true);
        });

        it('dryRun:true reports counts but does NOT delete', async () => {
            const debugDir = makeOldDebugDir('dry-run-debug');
            await createOldDir(debugDir, 128);

            const executions: FlowExecutionRecord[] = [{
                flowName: 'myFlow',
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationMs: 200,
                output: '',
                succeeded: true,
                debugOutputDir: debugDir,
            }];
            vi.spyOn(sessionManager, 'listAllSessions').mockReturnValue([{ id: 'sess-c' }] as ReturnType<typeof sessionManager.listAllSessions>);
            vi.spyOn(sessionManager, 'getFlowExecutions').mockReturnValue(executions);

            const out = await handleForceCleanupArtifacts({ dryRun: true });

            expect(out.dryRun).toBe(true);
            expect(out.artifactsRemoved).toBe(1);
            expect(out.bytesFreed).toBeGreaterThan(0);
            expect(out.errors).toEqual([]);

            // Directory must still exist — dryRun should not delete.
            const stat = await fs.stat(debugDir);
            expect(stat.isDirectory()).toBe(true);
        });

        it('scoped to one sessionId: only that session\'s artifacts are touched', async () => {
            const debugDirA = makeOldDebugDir('scope-sess-a');
            const debugDirB = makeOldDebugDir('scope-sess-b');
            await createOldDir(debugDirA, 64);
            await createOldDir(debugDirB, 64);

            const session: ReturnType<typeof sessionManager.listAllSessions>[number] = { id: 'scope-sess-a' } as ReturnType<typeof sessionManager.listAllSessions>[number];
            vi.spyOn(sessionManager, 'getSession').mockImplementation(async (id: string) => {
                if (id === 'scope-sess-a') return session as Awaited<ReturnType<typeof sessionManager.getSession>>;
                return undefined;
            });
            vi.spyOn(sessionManager, 'getFlowExecutions').mockImplementation((id: string) => {
                if (id === 'scope-sess-a') {
                    return [{
                        flowName: 'f',
                        startedAt: new Date().toISOString(),
                        endedAt: new Date().toISOString(),
                        durationMs: 100,
                        output: '',
                        succeeded: true,
                        debugOutputDir: debugDirA,
                    }];
                }
                return [{
                    flowName: 'f',
                    startedAt: new Date().toISOString(),
                    endedAt: new Date().toISOString(),
                    durationMs: 100,
                    output: '',
                    succeeded: true,
                    debugOutputDir: debugDirB,
                }];
            });

            const out = await handleForceCleanupArtifacts({ sessionId: 'scope-sess-a' });

            expect(out.artifactsRemoved).toBe(1);
            expect(out.errors).toEqual([]);

            // Only sess-a's dir deleted; sess-b's dir untouched.
            await expect(fs.stat(debugDirA)).rejects.toThrow();
            const statB = await fs.stat(debugDirB);
            expect(statB.isDirectory()).toBe(true);
        });

        it('missing dir on disk adds to errors[] but does not throw', async () => {
            const missingDir = makeOldDebugDir('nonexistent-dir-xyz');
            // Do NOT create this directory.

            const executions: FlowExecutionRecord[] = [{
                flowName: 'myFlow',
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationMs: 100,
                output: '',
                succeeded: true,
                debugOutputDir: missingDir,
            }];
            vi.spyOn(sessionManager, 'listAllSessions').mockReturnValue([{ id: 'sess-missing' }] as ReturnType<typeof sessionManager.listAllSessions>);
            vi.spyOn(sessionManager, 'getFlowExecutions').mockReturnValue(executions);

            const out = await handleForceCleanupArtifacts({});

            expect(out.errors).toHaveLength(1);
            expect(out.errors[0]).toContain(missingDir);
            expect(out.artifactsRemoved).toBe(0);
        });
    });
});
