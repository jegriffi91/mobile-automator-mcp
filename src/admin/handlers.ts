/**
 * Admin tool handlers — Phase 1: orphan visibility + force-cleanup.
 *
 * Five tools:
 *   list_active_sessions      — what sessions are alive, drivers, pollers, mocks
 *   list_active_mocks         — Proxyman rules tagged "mca:" (with drift report)
 *   force_cleanup_session     — kill poller/driver, delete tagged Proxyman rules,
 *                               mark session aborted; never throws
 *   force_cleanup_mocks       — bulk delete Proxyman rules by tag scope; never throws
 *   audit_state               — single-shot snapshot of everything orphan-relevant
 *
 * "Never throws" matters because these are recovery tools — if they fail, the
 * agent has no escape hatch. They surface partial-failure detail in the
 * `errors[]` field of the structured output instead.
 */

import { z } from 'zod';
import {
    ListActiveSessionsInputSchema,
    ListActiveSessionsOutputSchema,
    ListActiveMocksInputSchema,
    ListActiveMocksOutputSchema,
    ForceCleanupSessionInputSchema,
    ForceCleanupSessionOutputSchema,
    ForceCleanupMocksInputSchema,
    ForceCleanupMocksOutputSchema,
    AuditStateInputSchema,
    AuditStateOutputSchema,
} from '../schemas.js';
import { sessionManager } from '../session/index.js';
import { getProxymanMcpClient, type ProxymanMcpClient, type ProxymanRuleSummary } from '../proxymanMcp/client.js';

export type ListActiveSessionsInput = z.infer<typeof ListActiveSessionsInputSchema>;
export type ListActiveSessionsOutput = z.infer<typeof ListActiveSessionsOutputSchema>;
export type ListActiveMocksInput = z.infer<typeof ListActiveMocksInputSchema>;
export type ListActiveMocksOutput = z.infer<typeof ListActiveMocksOutputSchema>;
export type ForceCleanupSessionInput = z.infer<typeof ForceCleanupSessionInputSchema>;
export type ForceCleanupSessionOutput = z.infer<typeof ForceCleanupSessionOutputSchema>;
export type ForceCleanupMocksInput = z.infer<typeof ForceCleanupMocksInputSchema>;
export type ForceCleanupMocksOutput = z.infer<typeof ForceCleanupMocksOutputSchema>;
export type AuditStateInput = z.infer<typeof AuditStateInputSchema>;
export type AuditStateOutput = z.infer<typeof AuditStateOutputSchema>;

// ── Test seam: handlers go through the singleton, but tests need to swap it.
let _proxymanClientFactory: () => ProxymanMcpClient = getProxymanMcpClient;
export function _setAdminProxymanClientFactory(
    factory: () => ProxymanMcpClient,
): () => ProxymanMcpClient {
    const prev = _proxymanClientFactory;
    _proxymanClientFactory = factory;
    return prev;
}

const MCA_PREFIX = 'mca:';
const STANDALONE_PREFIX = 'mca:standalone';

function classifyRule(name: string): {
    scope: 'session' | 'standalone' | 'unknown';
    sessionId?: string;
    mockId?: string;
} {
    if (!name.startsWith(MCA_PREFIX)) return { scope: 'unknown' };
    if (name.startsWith(STANDALONE_PREFIX)) {
        const parts = name.split(':'); // ["mca","standalone","mockId"]
        return { scope: 'standalone', mockId: parts[2] };
    }
    // Session-scoped: mca:<sessionId>:<mockId>
    const parts = name.split(':');
    if (parts.length >= 3) {
        return { scope: 'session', sessionId: parts[1], mockId: parts.slice(2).join(':') };
    }
    return { scope: 'unknown' };
}

// ── list_active_sessions ────────────────────────────────────────────────────

export async function handleListActiveSessions(
    _input: ListActiveSessionsInput,
): Promise<ListActiveSessionsOutput> {
    const sessions = sessionManager.listActiveSessions();
    const driverIds = new Set(sessionManager.listActiveDrivers());
    const pollerIds = new Set(sessionManager.listActivePollers());

    const out = sessions.map((s) => {
        const pollingStatus = sessionManager.getPollingStatus(s.id);
        // PollingStatus doesn't track a wall-clock lastPollAt directly; surface
        // the most recent PollRecord's timestamp when available.
        const records = sessionManager.getPollRecords(s.id);
        const lastPollAt = records.length > 0 ? records[records.length - 1].timestamp : undefined;
        return {
            sessionId: s.id,
            appBundleId: s.appBundleId,
            platform: s.platform,
            status: s.status,
            startedAt: s.startedAt,
            stoppedAt: s.stoppedAt,
            abortedReason: s.abortedReason,
            driverActive: driverIds.has(s.id),
            pollerActive: pollerIds.has(s.id),
            pollerHealth: pollingStatus
                ? {
                      pollCount: pollingStatus.pollCount,
                      successCount: pollingStatus.successCount,
                      errorCount: pollingStatus.errorCount,
                      lastPollAt,
                  }
                : null,
            mockCount: sessionManager.listSessionMocks(s.id).length,
        };
    });

    return {
        sessions: out,
        totalSessions: out.length,
        totalActiveDrivers: driverIds.size,
        totalActivePollers: pollerIds.size,
    };
}

// ── list_active_mocks ───────────────────────────────────────────────────────

export async function handleListActiveMocks(
    input: ListActiveMocksInput,
): Promise<ListActiveMocksOutput> {
    const client = _proxymanClientFactory();
    const reachable = await client.healthCheck();
    if (!reachable) {
        return {
            proxymanReachable: false,
            rules: [],
            drift: { rulesNotInLedger: [], ledgerNotInProxyman: [] },
        };
    }

    let proxymanRules: ProxymanRuleSummary[] = [];
    try {
        proxymanRules = await client.listRulesByTagPrefix(MCA_PREFIX, 'scripting');
    } catch {
        // Treat as unreachable for the purposes of drift reporting.
        return {
            proxymanReachable: false,
            rules: [],
            drift: { rulesNotInLedger: [], ledgerNotInProxyman: [] },
        };
    }

    // Build the local-ledger view. If a sessionId filter was given, only
    // include that session's mocks; standalone mocks are always included
    // unless filtering by session.
    const ledgerRuleIds = new Set<string>();
    const ledgerRuleIdToCtx = new Map<string, { scope: 'session' | 'standalone'; sessionId?: string; mockId: string }>();
    if (input.sessionId) {
        for (const e of sessionManager.listSessionMocks(input.sessionId)) {
            ledgerRuleIds.add(e.ruleId);
            ledgerRuleIdToCtx.set(e.ruleId, { scope: 'session', sessionId: input.sessionId, mockId: e.mockId });
        }
    } else {
        for (const sessionId of sessionManager.listSessionMockSessionIds()) {
            for (const e of sessionManager.listSessionMocks(sessionId)) {
                ledgerRuleIds.add(e.ruleId);
                ledgerRuleIdToCtx.set(e.ruleId, { scope: 'session', sessionId, mockId: e.mockId });
            }
        }
        for (const e of sessionManager.listStandaloneMocks()) {
            ledgerRuleIds.add(e.ruleId);
            ledgerRuleIdToCtx.set(e.ruleId, { scope: 'standalone', mockId: e.mockId });
        }
    }

    // Optional name-prefix filter for session-scope listing.
    const filtered = input.sessionId
        ? proxymanRules.filter((r) => r.name.startsWith(`mca:${input.sessionId}:`))
        : proxymanRules;

    const rules = filtered.map((r) => {
        const cls = classifyRule(r.name);
        return {
            ruleId: r.id,
            name: r.name,
            url: r.url,
            enabled: r.enabled,
            scope: cls.scope,
            sessionId: cls.sessionId,
            mockId: cls.mockId,
            inLocalLedger: ledgerRuleIds.has(r.id),
        };
    });

    const proxymanIds = new Set(filtered.map((r) => r.id));
    const rulesNotInLedger = rules
        .filter((r) => !r.inLocalLedger)
        .map((r) => r.ruleId);
    const ledgerNotInProxyman = [...ledgerRuleIds].filter((id) => !proxymanIds.has(id));

    return {
        proxymanReachable: true,
        rules,
        drift: { rulesNotInLedger, ledgerNotInProxyman },
    };
}

// ── force_cleanup_session ───────────────────────────────────────────────────

export async function handleForceCleanupSession(
    input: ForceCleanupSessionInput,
): Promise<ForceCleanupSessionOutput> {
    const errors: string[] = [];
    const reason = input.reason || 'manual force-cleanup';

    // 1. Stop poller + driver, drop registrations.
    let pollerStopped = false;
    let driverRemoved = false;
    try {
        const r = await sessionManager.forceCleanup(input.sessionId, reason);
        pollerStopped = r.pollerStopped;
        driverRemoved = r.driverRemoved;
    } catch (err) {
        errors.push(`forceCleanup: ${(err as Error).message}`);
    }

    // 2. Delete tagged Proxyman rules (best-effort).
    const client = _proxymanClientFactory();
    const reachable = await client.healthCheck();
    let rulesDeleted = 0;
    if (reachable) {
        try {
            const result = await client.deleteRulesByTagPrefix(`mca:${input.sessionId}:`, 'scripting');
            rulesDeleted = result.deleted.length;
            for (const f of result.failed) {
                errors.push(`deleteRule(${f.id}): ${f.error}`);
            }
        } catch (err) {
            errors.push(`deleteRulesByTagPrefix: ${(err as Error).message}`);
        }
    }
    // Always drop the local ledger so the session is fully gone.
    sessionManager.clearSessionMocks(input.sessionId);

    // 3. Mark the session aborted (idempotent on terminal states).
    let sessionMarkedAborted = false;
    try {
        const before = await sessionManager.getSession(input.sessionId);
        await sessionManager.markAborted(input.sessionId, reason);
        const after = await sessionManager.getSession(input.sessionId);
        sessionMarkedAborted = !!after && after.status === 'aborted' && before?.status !== 'aborted';
    } catch (err) {
        errors.push(`markAborted: ${(err as Error).message}`);
    }

    return {
        sessionId: input.sessionId,
        pollerStopped,
        driverRemoved,
        proxymanRulesDeleted: rulesDeleted,
        proxymanReachable: reachable,
        sessionMarkedAborted,
        errors,
    };
}

// ── force_cleanup_mocks ─────────────────────────────────────────────────────

export async function handleForceCleanupMocks(
    input: ForceCleanupMocksInput,
): Promise<ForceCleanupMocksOutput> {
    const errors: string[] = [];
    const client = _proxymanClientFactory();
    const reachable = await client.healthCheck();

    let prefix: string;
    if (input.scope === 'all') prefix = MCA_PREFIX;
    else if (input.scope === 'standalone') prefix = STANDALONE_PREFIX;
    else prefix = `mca:${input.sessionId}:`;

    let rulesDeleted = 0;
    if (reachable) {
        try {
            const result = await client.deleteRulesByTagPrefix(prefix, 'scripting');
            rulesDeleted = result.deleted.length;
            for (const f of result.failed) {
                errors.push(`deleteRule(${f.id}): ${f.error}`);
            }
        } catch (err) {
            errors.push(`deleteRulesByTagPrefix: ${(err as Error).message}`);
        }
    }

    let ledgerEntriesCleared = 0;
    if (input.scope === 'all') {
        for (const sid of sessionManager.listSessionMockSessionIds()) {
            ledgerEntriesCleared += sessionManager.listSessionMocks(sid).length;
            sessionManager.clearSessionMocks(sid);
        }
        ledgerEntriesCleared += sessionManager.standaloneMockCount();
        sessionManager.clearStandaloneMocks();
    } else if (input.scope === 'standalone') {
        ledgerEntriesCleared = sessionManager.standaloneMockCount();
        sessionManager.clearStandaloneMocks();
    } else {
        ledgerEntriesCleared = sessionManager.listSessionMocks(input.sessionId!).length;
        sessionManager.clearSessionMocks(input.sessionId!);
    }

    return {
        scope: input.scope,
        proxymanReachable: reachable,
        rulesDeleted,
        ledgerEntriesCleared,
        errors,
    };
}

// ── audit_state ─────────────────────────────────────────────────────────────

export async function handleAuditState(_input: AuditStateInput): Promise<AuditStateOutput> {
    const generatedAt = new Date().toISOString();
    const allSessions = sessionManager.listAllSessions();

    const byStatus: Record<string, number> = {};
    for (const s of allSessions) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

    const driverIds = sessionManager.listActiveDrivers();
    const pollerIds = sessionManager.listActivePollers();
    const knownSessionIds = new Set(allSessions.map((s) => s.id));

    // ── Proxyman view (best-effort) ──
    const client = _proxymanClientFactory();
    const reachable = await client.healthCheck();
    let totalRules = 0;
    let mcaTaggedRules = 0;
    let proxymanOrphans: string[] = [];
    const rulesByTagPrefix: Record<string, number> = {};
    if (reachable) {
        try {
            const all = await client.listRules('scripting');
            totalRules = all.length;
            for (const r of all) {
                if (!r.name.startsWith(MCA_PREFIX)) continue;
                mcaTaggedRules++;
                const cls = classifyRule(r.name);
                const key = cls.scope === 'session'
                    ? `mca:${cls.sessionId}:`
                    : cls.scope === 'standalone'
                        ? STANDALONE_PREFIX
                        : 'mca:unknown';
                rulesByTagPrefix[key] = (rulesByTagPrefix[key] ?? 0) + 1;
                if (cls.scope === 'session' && cls.sessionId && !knownSessionIds.has(cls.sessionId)) {
                    proxymanOrphans.push(r.id);
                }
            }
        } catch {
            // Treat as unreachable from this point on.
        }
    }

    const driverIdSet = new Set(driverIds);
    const pollerIdSet = new Set(pollerIds);

    const sessionsWithoutDriver = allSessions
        .filter((s) => s.status === 'recording' && !driverIdSet.has(s.id))
        .map((s) => s.id);
    const pollersWithoutSession = pollerIds.filter((id) => !knownSessionIds.has(id));

    return {
        generatedAt,
        sessions: { total: allSessions.length, byStatus },
        drivers: { active: driverIds.length, sessionIds: driverIds },
        pollers: { active: pollerIds.length, sessionIds: pollerIds },
        proxyman: {
            reachable,
            totalRules,
            mcaTaggedRules,
            rulesByTagPrefix,
        },
        orphans: {
            proxymanRulesWithoutSession: proxymanOrphans,
            sessionsWithoutDriver,
            pollersWithoutSession,
        },
    };
    // (driverIdSet / pollerIdSet kept above for clarity even if pollerIdSet
    // currently isn't read — ESLint will flag if it goes unused.)
}
