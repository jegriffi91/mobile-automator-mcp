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
import type { PollingStatus, PollingNotifier } from './touch-inferrer.js';
import { HierarchyParser } from '../maestro/hierarchy.js';
import type { MaestroWrapper } from '../maestro/wrapper.js';
import type { MaestroDaemon } from '../maestro/daemon.js';

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
    idle: ['recording'],
    recording: ['compiling'],
    compiling: ['done'],
    done: [],
};

export class SessionManager {
    private db: SessionDatabase;

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
    private activeDaemons: Map<string, MaestroDaemon> = new Map();

    /**
     * Start background hierarchy polling to capture manual UI touches.
     * Uses TouchInferrer to diff consecutive hierarchy snapshots and
     * infer UIInteraction records from detected changes.
     *
     * When a MaestroDaemon is provided, it is used for sub-second hierarchy
     * reads on a warm JVM. Otherwise falls back to MaestroWrapper CLI calls.
     */
    async startPolling(
        sessionId: string,
        platform: MobilePlatform,
        appBundleId: string,
        maestro?: MaestroWrapper,
        daemon?: MaestroDaemon,
        notifier?: PollingNotifier,
    ): Promise<void> {
        if (this.activePollers.has(sessionId)) return;

        const session = this.db.getSession(sessionId);
        const pollingIntervalMs = session?.pollingIntervalMs ?? 500;
        const logger = (interaction: UIInteraction) => this.logInteraction(interaction);

        // Prefer daemon (sub-second) over wrapper (5s+ per call)
        if (daemon) {
            try {
                const deviceId = maestro ? undefined : undefined; // deviceId resolved during session start
                await daemon.start(deviceId);
                this.activeDaemons.set(sessionId, daemon);

                console.error(`[SessionManager] startPolling: using MaestroDaemon for ${sessionId} (interval: ${pollingIntervalMs}ms)`);

                const hierarchyReader = daemon.createTreeReader();
                const inferrer = new TouchInferrer(logger, hierarchyReader, { pollingIntervalMs }, notifier);
                inferrer.start(sessionId);
                this.activePollers.set(sessionId, inferrer);
                return;
            } catch (err) {
                console.error(`[SessionManager] startPolling: daemon start failed, falling back to CLI:`, err);
                this.activeDaemons.delete(sessionId);
            }
        }

        // Fallback: use MaestroWrapper CLI calls
        if (!maestro) {
            console.error(`[SessionManager] startPolling: no MaestroWrapper provided, skipping passive capture for ${sessionId}`);
            return;
        }

        console.error(`[SessionManager] startPolling: using CLI wrapper for ${sessionId} on ${platform} (interval: ${pollingIntervalMs}ms)`);

        const hierarchyReader = async () => {
            const raw = await maestro.dumpHierarchyLite();
            return HierarchyParser.parse(raw);
        };
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
     * Stop background polling for a session.
     * Also stops the daemon if one was started.
     */
    async stopPolling(sessionId: string): Promise<void> {
        const inferrer = this.activePollers.get(sessionId);
        if (inferrer) {
            inferrer.stop();
            this.activePollers.delete(sessionId);
            console.error(`[SessionManager] stopPolling: stopped passive capture for ${sessionId}`);
        }

        const daemon = this.activeDaemons.get(sessionId);
        if (daemon) {
            await daemon.stop();
            this.activeDaemons.delete(sessionId);
            console.error(`[SessionManager] stopPolling: stopped daemon for ${sessionId}`);
        }
    }
}
