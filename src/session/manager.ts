/**
 * SessionManager — High-level session lifecycle management.
 *
 * Phase 2 will implement:
 *   • create(): start a new recording session
 *   • transition(): move session through states (recording → compiling → done)
 *   • logInteraction(): record a UI action to the session
 *   • logNetworkEvent(): record a network transaction to the session
 *   • getSession(): retrieve session metadata
 *   • getInteractions() / getNetworkEvents(): query session logs
 */

import type { Session, SessionStatus, UIInteraction, NetworkEvent, MobilePlatform, HierarchySnapshot, CaptureMode } from '../types.js';
import { SessionDatabase } from './database.js';
import { TouchInferrer } from './touch-inferrer.js';
import type { PollingStatus, PollingNotifier, PollRecord } from './touch-inferrer.js';
import type { AutomationDriver } from '../maestro/driver.js';

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
    idle: ['recording'],
    recording: ['compiling', 'aborted'],
    compiling: ['done', 'aborted'],
    done: [],
    // Aborted is terminal — same as 'done'.
    aborted: [],
};

export class SessionManager {
    private db: SessionDatabase;

    // ── Per-session driver / mock state, formerly module-level in handlers.ts ──
    private activeDrivers: Map<string, AutomationDriver> = new Map();
    private sessionMocks: Map<string, Map<string, string>> = new Map();
    private standaloneMocks: Map<string, string> = new Map();

    constructor(db?: SessionDatabase) {
        this.db = db || new SessionDatabase();
    }

    /**
     * Initialize the session database.
     */
    async initialize(): Promise<void> {
        await this.db.initialize();
    }

    /**
     * Create a new recording session.
     */
    async create(
        sessionId: string,
        appBundleId: string,
        platform: MobilePlatform,
        filterDomains?: string[],
        captureMode?: CaptureMode,
        pollingIntervalMs?: number,
        settleTimeoutMs?: number,
        trackEventPaths?: string[],
    ): Promise<Session> {
        const session: Session = {
            id: sessionId,
            appBundleId,
            platform,
            status: 'recording',
            startedAt: new Date().toISOString(),
            filterDomains,
            captureMode: captureMode || 'event-triggered',
            pollingIntervalMs: pollingIntervalMs ?? 500,
            settleTimeoutMs: settleTimeoutMs ?? 3000,
            trackEventPaths,
        };
        this.db.insertSession(session);
        console.error(`[SessionManager] create: ${sessionId} started (captureMode: ${session.captureMode}).`);
        return session;
    }

    /**
     * Transition a session to a new status.
     * Throws if the session does not exist or the transition is invalid.
     */
    async transition(sessionId: string, newStatus: SessionStatus): Promise<void> {
        const session = this.db.getSession(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        const allowedNext = VALID_TRANSITIONS[session.status];
        if (!allowedNext.includes(newStatus)) {
            throw new Error(
                `Invalid transition for session ${sessionId}: ${session.status} → ${newStatus}. Allowed: [${allowedNext.join(', ') || 'none'}]`
            );
        }
        this.db.updateSessionStatus(sessionId, newStatus);
        if (newStatus === 'done') {
            this.db.updateSessionStopped(sessionId, new Date().toISOString());
        }
        console.error(`[SessionManager] transition: ${sessionId} → ${newStatus}`);
    }

    /**
     * Get a session state.
     */
    async getSession(sessionId: string): Promise<Session | null> {
        return this.db.getSession(sessionId);
    }

    /**
     * Log a UI interaction to the session.
     * Throws if the session does not exist.
     */
    async logInteraction(interaction: UIInteraction): Promise<void> {
        const session = this.db.getSession(interaction.sessionId);
        if (!session) {
            throw new Error(`Session not found: ${interaction.sessionId}`);
        }
        this.db.insertUIInteraction(interaction);
        console.error(`[SessionManager] logInteraction: action ${interaction.actionType} logged for session ${interaction.sessionId}`);
    }

    /**
     * Log a network event to the session.
     * Throws if the session does not exist.
     */
    async logNetworkEvent(event: NetworkEvent): Promise<void> {
        const session = this.db.getSession(event.sessionId);
        if (!session) {
            throw new Error(`Session not found: ${event.sessionId}`);
        }
        this.db.insertNetworkEvent(event);
        console.error(`[SessionManager] logNetworkEvent: URL ${event.url} logged for session ${event.sessionId}`);
    }

    /**
     * Retrieve all interactions for a session, ordered chronologically.
     */
    async getInteractions(sessionId: string): Promise<UIInteraction[]> {
        return this.db.getUIInteractions(sessionId);
    }

    /**
     * Retrieve all network events for a session, ordered chronologically.
     */
    async getNetworkEvents(sessionId: string): Promise<NetworkEvent[]> {
        return this.db.getNetworkEvents(sessionId);
    }

    /**
     * Batch-insert network events in a single transaction.
     * Silently skips duplicate entries and events for non-existent sessions.
     */
    async batchLogNetworkEvents(events: NetworkEvent[]): Promise<void> {
        if (events.length === 0) return;
        try {
            this.db.batchInsertNetworkEvents(events);
        } catch {
            // Silently handle errors (e.g., session not found for completed sessions)
        }
    }

    /**
     * Store the Proxyman baseline entry count for a session.
     */
    async updateBaseline(sessionId: string, baseline: number): Promise<void> {
        this.db.updateSessionBaseline(sessionId, baseline);
        console.error(`[SessionManager] updateBaseline: session ${sessionId} baseline = ${baseline}`);
    }

    // ----- Hierarchy Snapshots -----

    /**
     * Store a hierarchy snapshot for the session.
     */
    async insertSnapshot(snapshot: HierarchySnapshot): Promise<number> {
        return this.db.insertSnapshot(snapshot);
    }

    /**
     * Get all hierarchy snapshots for a session.
     */
    async getSnapshots(sessionId: string): Promise<HierarchySnapshot[]> {
        return this.db.getSnapshots(sessionId);
    }

    /**
     * Purge hierarchy snapshots after compilation to free memory.
     */
    async purgeSnapshots(sessionId: string): Promise<void> {
        this.db.purgeSnapshots(sessionId);
        console.error(`[SessionManager] purgeSnapshots: purged snapshots for ${sessionId}`);
    }

    private activePollers: Map<string, TouchInferrer> = new Map();

    /**
     * Start background hierarchy polling to capture manual UI touches.
     * Uses TouchInferrer to diff consecutive hierarchy snapshots and
     * infer UIInteraction records from detected changes.
     *
     * The driver provides a hierarchy reader — whether it uses the daemon
     * (sub-second) or CLI (5s+ per call) is managed by the driver itself.
     */
    async startPolling(
        sessionId: string,
        platform: MobilePlatform,
        appBundleId: string,
        driver: AutomationDriver,
        notifier?: PollingNotifier,
    ): Promise<void> {
        if (this.activePollers.has(sessionId)) return;

        const session = this.db.getSession(sessionId);
        const pollingIntervalMs = session?.pollingIntervalMs ?? 500;
        const logger = (interaction: UIInteraction) => this.logInteraction(interaction);

        console.error(`[SessionManager] startPolling: using driver for ${sessionId} (interval: ${pollingIntervalMs}ms)`);

        const hierarchyReader = driver.createTreeReader();
        const inferrer = new TouchInferrer(logger, hierarchyReader, { pollingIntervalMs }, notifier);
        inferrer.start(sessionId);
        this.activePollers.set(sessionId, inferrer);
    }

    /**
     * Get polling health status for a session.
     * Returns null if no active poller exists.
     */
    getPollingStatus(sessionId: string): PollingStatus | null {
        const inferrer = this.activePollers.get(sessionId);
        return inferrer ? inferrer.getStatus() : null;
    }

    /**
     * Suppress the next inferred interaction for a session.
     * Used by execute_ui_action to prevent double-logging.
     */
    suppressNextInference(sessionId: string): void {
        const inferrer = this.activePollers.get(sessionId);
        if (inferrer) {
            inferrer.suppress();
        }
    }

    /**
     * Get per-poll timeline records for a session.
     * Returns empty array if no active poller exists.
     */
    getPollRecords(sessionId: string): PollRecord[] {
        const inferrer = this.activePollers.get(sessionId);
        return inferrer ? inferrer.getPollRecords() : [];
    }

    /**
     * Stop background polling for a session.
     */
    async stopPolling(sessionId: string): Promise<void> {
        const inferrer = this.activePollers.get(sessionId);
        if (inferrer) {
            inferrer.stop();
            this.activePollers.delete(sessionId);
            console.error(`[SessionManager] stopPolling: stopped passive capture for ${sessionId}`);
        }
    }

    /** List session IDs that currently have an active poller. */
    listActivePollers(): string[] {
        return [...this.activePollers.keys()];
    }

    // ── Active driver registry ──

    setActiveDriver(sessionId: string, driver: AutomationDriver): void {
        this.activeDrivers.set(sessionId, driver);
    }

    getActiveDriver(sessionId: string): AutomationDriver | undefined {
        return this.activeDrivers.get(sessionId);
    }

    removeActiveDriver(sessionId: string): boolean {
        return this.activeDrivers.delete(sessionId);
    }

    listActiveDrivers(): string[] {
        return [...this.activeDrivers.keys()];
    }

    // ── Per-session mock ledger ──

    addSessionMock(sessionId: string, mockId: string, ruleId: string): void {
        let perSession = this.sessionMocks.get(sessionId);
        if (!perSession) {
            perSession = new Map();
            this.sessionMocks.set(sessionId, perSession);
        }
        perSession.set(mockId, ruleId);
    }

    getSessionMockRule(sessionId: string, mockId: string): string | undefined {
        return this.sessionMocks.get(sessionId)?.get(mockId);
    }

    removeSessionMock(sessionId: string, mockId: string): boolean {
        const perSession = this.sessionMocks.get(sessionId);
        if (!perSession) return false;
        const removed = perSession.delete(mockId);
        if (perSession.size === 0) this.sessionMocks.delete(sessionId);
        return removed;
    }

    listSessionMocks(sessionId: string): { mockId: string; ruleId: string }[] {
        const perSession = this.sessionMocks.get(sessionId);
        if (!perSession) return [];
        return [...perSession.entries()].map(([mockId, ruleId]) => ({ mockId, ruleId }));
    }

    clearSessionMocks(sessionId: string): void {
        this.sessionMocks.delete(sessionId);
    }

    /** Session IDs that have at least one mock entry. */
    listSessionMockSessionIds(): string[] {
        return [...this.sessionMocks.keys()];
    }

    // ── Standalone mock ledger ──

    addStandaloneMock(mockId: string, ruleId: string): void {
        this.standaloneMocks.set(mockId, ruleId);
    }

    getStandaloneMockRule(mockId: string): string | undefined {
        return this.standaloneMocks.get(mockId);
    }

    removeStandaloneMock(mockId: string): boolean {
        return this.standaloneMocks.delete(mockId);
    }

    listStandaloneMocks(): { mockId: string; ruleId: string }[] {
        return [...this.standaloneMocks.entries()].map(([mockId, ruleId]) => ({ mockId, ruleId }));
    }

    clearStandaloneMocks(): void {
        this.standaloneMocks.clear();
    }

    standaloneMockCount(): number {
        return this.standaloneMocks.size;
    }

    // ── Aborted-session helpers ──

    listActiveSessions(): Session[] {
        return this.db.listActiveSessions();
    }

    listAllSessions(): Session[] {
        return this.db.listAllSessions();
    }

    /**
     * Mark a session aborted with a reason. Idempotent — if the session is
     * already terminal ('done' or 'aborted'), this is a no-op.
     */
    async markAborted(sessionId: string, reason: string): Promise<void> {
        const session = this.db.getSession(sessionId);
        if (!session) return;
        if (session.status === 'done' || session.status === 'aborted') return;
        this.db.markAborted(sessionId, reason);
        console.error(`[SessionManager] markAborted: ${sessionId} → aborted (${reason})`);
    }

    /**
     * Force-clean session-side state: stop poller, stop driver, remove from
     * registries. Used by force_cleanup_session and orphan rollback paths.
     * Never throws — failures are caught and surfaced via console.error.
     */
    async forceCleanup(
        sessionId: string,
        _reason: string,
    ): Promise<{ pollerStopped: boolean; driverRemoved: boolean }> {
        let pollerStopped = false;
        let driverRemoved = false;

        const inferrer = this.activePollers.get(sessionId);
        if (inferrer) {
            try {
                inferrer.stop();
                pollerStopped = true;
            } catch (err) {
                console.error(`[SessionManager] forceCleanup: poller stop failed for ${sessionId}`, err);
            }
            this.activePollers.delete(sessionId);
        }

        const driver = this.activeDrivers.get(sessionId);
        if (driver) {
            try {
                await driver.stop();
                driverRemoved = true;
            } catch (err) {
                console.error(`[SessionManager] forceCleanup: driver stop failed for ${sessionId}`, err);
                driverRemoved = true; // we still removed the registration
            }
            this.activeDrivers.delete(sessionId);
        }

        return { pollerStopped, driverRemoved };
    }
}
