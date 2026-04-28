import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { Session, SessionStatus, UIInteraction, NetworkEvent, MobilePlatform, HierarchySnapshot, CaptureMode, FlowExecutionRecord, TimeoutConfig } from '../types.js';

export class SessionDatabase {
    private db: Database | null = null;
    private SQL: SqlJsStatic | null = null;

    /**
     * Initialize the in-memory SQL database and create tables.
     */
    async initialize(): Promise<void> {
        if (!this.SQL) {
            this.SQL = await initSqlJs();
        }
        if (!this.db) {
            this.db = new this.SQL.Database();
        }

        this.db.run(`PRAGMA foreign_keys = ON;`);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                appBundleId TEXT NOT NULL,
                platform TEXT NOT NULL,
                status TEXT NOT NULL,
                startedAt TEXT NOT NULL,
                stoppedAt TEXT,
                abortedReason TEXT,
                proxymanBaseline INTEGER,
                filterDomains TEXT,
                captureMode TEXT,
                pollingIntervalMs INTEGER,
                settleTimeoutMs INTEGER,
                trackEventPaths TEXT,
                device_id TEXT,
                driver_timeouts_json TEXT
            );

            CREATE TABLE IF NOT EXISTS ui_interactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sessionId TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                actionType TEXT NOT NULL,
                element TEXT NOT NULL,
                textInput TEXT,
                source TEXT,
                FOREIGN KEY(sessionId) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS network_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sessionId TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                method TEXT NOT NULL,
                url TEXT NOT NULL,
                statusCode INTEGER NOT NULL,
                requestBody TEXT,
                responseBody TEXT,
                durationMs INTEGER,
                FOREIGN KEY(sessionId) REFERENCES sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_ui_interactions_sessionId
                ON ui_interactions(sessionId);

            CREATE INDEX IF NOT EXISTS idx_network_events_sessionId
                ON network_events(sessionId);

            CREATE TABLE IF NOT EXISTS hierarchy_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sessionId TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                trigger TEXT NOT NULL,
                actionId INTEGER,
                hierarchyJson TEXT NOT NULL,
                FOREIGN KEY(sessionId) REFERENCES sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_hierarchy_snapshots_sessionId
                ON hierarchy_snapshots(sessionId);

            CREATE TABLE IF NOT EXISTS flow_executions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                flow_name TEXT NOT NULL,
                flow_path TEXT,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                output TEXT,
                succeeded INTEGER NOT NULL,
                cancelled INTEGER NOT NULL DEFAULT 0,
                debug_output_dir TEXT,
                seq INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_flow_executions_session
                ON flow_executions(session_id, seq);
        `);
    }

    private getDb(): Database {
        if (!this.db) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        return this.db;
    }

    /**
     * Insert a new session.
     */
    insertSession(session: Session): void {
        const db = this.getDb();
        const stmt = db.prepare(`INSERT INTO sessions (id, appBundleId, platform, status, startedAt, stoppedAt, abortedReason, proxymanBaseline, filterDomains, captureMode, pollingIntervalMs, settleTimeoutMs, trackEventPaths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run([
            session.id,
            session.appBundleId,
            session.platform,
            session.status,
            session.startedAt,
            session.stoppedAt || null,
            session.abortedReason || null,
            session.proxymanBaseline ?? null,
            session.filterDomains ? JSON.stringify(session.filterDomains) : null,
            session.captureMode || null,
            session.pollingIntervalMs ?? null,
            session.settleTimeoutMs ?? null,
            session.trackEventPaths ? JSON.stringify(session.trackEventPaths) : null,
        ]);
        stmt.free();
    }

    /**
     * Mark a session as aborted with a reason. Sets stoppedAt to now()
     * if not already set.
     */
    markAborted(sessionId: string, reason: string): void {
        const db = this.getDb();
        const stoppedAt = new Date().toISOString();
        const stmt = db.prepare(
            `UPDATE sessions SET status = 'aborted', abortedReason = ?, stoppedAt = COALESCE(stoppedAt, ?) WHERE id = ?`,
        );
        stmt.run([reason, stoppedAt, sessionId]);
        stmt.free();
    }

    /**
     * List sessions with status in ('recording','compiling').
     */
    listActiveSessions(): Session[] {
        const db = this.getDb();
        const stmt = db.prepare(
            `SELECT * FROM sessions WHERE status IN ('recording','compiling') ORDER BY startedAt ASC`,
        );
        const results: Session[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.rowToSession(row));
        }
        stmt.free();
        return results;
    }

    /** List all sessions (no status filter). Used by audit_state. */
    listAllSessions(): Session[] {
        const db = this.getDb();
        const stmt = db.prepare(`SELECT * FROM sessions ORDER BY startedAt ASC`);
        const results: Session[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.rowToSession(row));
        }
        stmt.free();
        return results;
    }

    private rowToSession(row: Record<string, unknown>): Session {
        return {
            id: row.id as string,
            appBundleId: row.appBundleId as string,
            platform: row.platform as MobilePlatform,
            status: row.status as SessionStatus,
            startedAt: row.startedAt as string,
            stoppedAt: (row.stoppedAt as string) || undefined,
            abortedReason: (row.abortedReason as string) || undefined,
            proxymanBaseline: row.proxymanBaseline != null ? (row.proxymanBaseline as number) : undefined,
            filterDomains: row.filterDomains ? JSON.parse(row.filterDomains as string) : undefined,
            captureMode: (row.captureMode as CaptureMode) || undefined,
            pollingIntervalMs: row.pollingIntervalMs != null ? (row.pollingIntervalMs as number) : undefined,
            settleTimeoutMs: row.settleTimeoutMs != null ? (row.settleTimeoutMs as number) : undefined,
            trackEventPaths: row.trackEventPaths ? JSON.parse(row.trackEventPaths as string) : undefined,
            deviceId: (row.device_id as string) || undefined,
            driverTimeouts: row.driver_timeouts_json
                ? (JSON.parse(row.driver_timeouts_json as string) as Partial<TimeoutConfig>)
                : undefined,
        };
    }

    /**
     * Update session status.
     */
    updateSessionStatus(sessionId: string, status: SessionStatus): void {
        const db = this.getDb();
        const stmt = db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`);
        stmt.run([status, sessionId]);
        stmt.free();
    }

    /**
     * Set stoppedAt timestamp for a completed session.
     */
    updateSessionStopped(sessionId: string, stoppedAt: string): void {
        const db = this.getDb();
        const stmt = db.prepare(`UPDATE sessions SET stoppedAt = ? WHERE id = ?`);
        stmt.run([stoppedAt, sessionId]);
        stmt.free();
    }

    /**
     * Store the Proxyman baseline count for a session.
     */
    updateSessionBaseline(sessionId: string, baseline: number): void {
        const db = this.getDb();
        const stmt = db.prepare(`UPDATE sessions SET proxymanBaseline = ? WHERE id = ?`);
        stmt.run([baseline, sessionId]);
        stmt.free();
    }

    /**
     * Retrieve session details.
     */
    getSession(sessionId: string): Session | null {
        const db = this.getDb();
        const stmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
        stmt.bind([sessionId]);
        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return this.rowToSession(row);
        }
        stmt.free();
        return null;
    }

    /**
     * Insert a UI interaction.
     */
    insertUIInteraction(interaction: UIInteraction): void {
        const db = this.getDb();
        const stmt = db.prepare(`INSERT INTO ui_interactions (sessionId, timestamp, actionType, element, textInput, source) VALUES (?, ?, ?, ?, ?, ?)`);
        stmt.run([
            interaction.sessionId,
            interaction.timestamp,
            interaction.actionType,
            JSON.stringify(interaction.element),
            interaction.textInput || null,
            interaction.source || null,
        ]);
        stmt.free();
    }

    /**
     * Retrieve all UI interactions for a session.
     */
    getUIInteractions(sessionId: string): UIInteraction[] {
        const db = this.getDb();
        const stmt = db.prepare(`SELECT * FROM ui_interactions WHERE sessionId = ? ORDER BY timestamp ASC`);
        stmt.bind([sessionId]);
        const results: UIInteraction[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push({
                id: row.id as number,
                sessionId: row.sessionId as string,
                timestamp: row.timestamp as string,
                actionType: row.actionType as UIInteraction['actionType'],
                element: JSON.parse(row.element as string),
                textInput: row.textInput != null ? (row.textInput as string) : undefined,
                source: (row.source as UIInteraction['source']) || undefined,
            });
        }
        stmt.free();
        return results;
    }

    /**
     * Insert a network event.
     */
    insertNetworkEvent(event: NetworkEvent): void {
        const db = this.getDb();
        const stmt = db.prepare(`INSERT INTO network_events (sessionId, timestamp, method, url, statusCode, requestBody, responseBody, durationMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run([
            event.sessionId,
            event.timestamp,
            event.method,
            event.url,
            event.statusCode,
            event.requestBody || null,
            event.responseBody || null,
            event.durationMs || null,
        ]);
        stmt.free();
    }

    /**
     * Batch-insert network events in a single transaction.
     * Uses INSERT OR IGNORE to silently skip duplicates.
     * ~10-50x faster than individual insertNetworkEvent() calls.
     */
    batchInsertNetworkEvents(events: NetworkEvent[]): void {
        if (events.length === 0) return;
        const db = this.getDb();
        db.run('BEGIN TRANSACTION');
        try {
            const stmt = db.prepare(
                `INSERT OR IGNORE INTO network_events (sessionId, timestamp, method, url, statusCode, requestBody, responseBody, durationMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const event of events) {
                stmt.run([
                    event.sessionId,
                    event.timestamp,
                    event.method,
                    event.url,
                    event.statusCode,
                    event.requestBody || null,
                    event.responseBody || null,
                    event.durationMs || null,
                ]);
            }
            stmt.free();
            db.run('COMMIT');
        } catch (error) {
            db.run('ROLLBACK');
            throw error;
        }
    }

    /**
     * Retrieve all network events for a session.
     */
    getNetworkEvents(sessionId: string): NetworkEvent[] {
        const db = this.getDb();
        const stmt = db.prepare(`SELECT * FROM network_events WHERE sessionId = ? ORDER BY timestamp ASC`);
        stmt.bind([sessionId]);
        const results: NetworkEvent[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push({
                id: row.id as number,
                sessionId: row.sessionId as string,
                timestamp: row.timestamp as string,
                method: row.method as string,
                url: row.url as string,
                statusCode: row.statusCode as number,
                requestBody: row.requestBody != null ? (row.requestBody as string) : undefined,
                responseBody: row.responseBody != null ? (row.responseBody as string) : undefined,
                durationMs: row.durationMs != null ? (row.durationMs as number) : undefined,
            });
        }
        stmt.free();
        return results;
    }

    // ----- Hierarchy Snapshots -----

    /**
     * Insert a hierarchy snapshot.
     * Returns the auto-generated row ID.
     */
    insertSnapshot(snapshot: HierarchySnapshot): number {
        const db = this.getDb();
        const stmt = db.prepare(
            `INSERT INTO hierarchy_snapshots (sessionId, timestamp, trigger, actionId, hierarchyJson) VALUES (?, ?, ?, ?, ?)`
        );
        stmt.run([
            snapshot.sessionId,
            snapshot.timestamp,
            snapshot.trigger,
            snapshot.actionId ?? null,
            snapshot.hierarchyJson,
        ]);
        stmt.free();

        // Get the last inserted row ID
        const result = db.exec('SELECT last_insert_rowid() as id');
        return result[0]?.values[0]?.[0] as number;
    }

    /**
     * Get all hierarchy snapshots for a session, ordered by timestamp.
     */
    getSnapshots(sessionId: string): HierarchySnapshot[] {
        const db = this.getDb();
        const stmt = db.prepare(
            `SELECT * FROM hierarchy_snapshots WHERE sessionId = ? ORDER BY timestamp ASC`
        );
        stmt.bind([sessionId]);
        const results: HierarchySnapshot[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push({
                id: row.id as number,
                sessionId: row.sessionId as string,
                timestamp: row.timestamp as string,
                trigger: row.trigger as HierarchySnapshot['trigger'],
                actionId: row.actionId != null ? (row.actionId as number) : undefined,
                hierarchyJson: row.hierarchyJson as string,
            });
        }
        stmt.free();
        return results;
    }

    /**
     * Purge all hierarchy snapshots for a session.
     * Call after compilation to free memory.
     */
    purgeSnapshots(sessionId: string): void {
        const db = this.getDb();
        const stmt = db.prepare(`DELETE FROM hierarchy_snapshots WHERE sessionId = ?`);
        stmt.run([sessionId]);
        stmt.free();
    }

    // ── Phase 6: runtime-state persistence ──

    /**
     * Persist the device UDID associated with a session.
     * Used by resumeSession to recreate the daemon driver after a paused flow.
     */
    setDeviceId(sessionId: string, deviceId: string): void {
        const db = this.getDb();
        const stmt = db.prepare(`UPDATE sessions SET device_id = ? WHERE id = ?`);
        stmt.run([deviceId, sessionId]);
        stmt.free();
    }

    /**
     * Persist the timeout overrides supplied at session creation.
     * Stored as JSON so the original Partial<TimeoutConfig> shape is preserved.
     */
    setDriverTimeouts(sessionId: string, timeouts: Partial<TimeoutConfig>): void {
        const db = this.getDb();
        const stmt = db.prepare(`UPDATE sessions SET driver_timeouts_json = ? WHERE id = ?`);
        stmt.run([JSON.stringify(timeouts), sessionId]);
        stmt.free();
    }

    /**
     * Return the persisted timeout overrides for a session, or undefined if none.
     */
    getDriverTimeouts(sessionId: string): Partial<TimeoutConfig> | undefined {
        const db = this.getDb();
        const stmt = db.prepare(`SELECT driver_timeouts_json FROM sessions WHERE id = ?`);
        stmt.bind([sessionId]);
        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            if (row.driver_timeouts_json) {
                return JSON.parse(row.driver_timeouts_json as string) as Partial<TimeoutConfig>;
            }
            return undefined;
        }
        stmt.free();
        return undefined;
    }

    /**
     * Append a FlowExecutionRecord for a session.
     * `seq` is auto-assigned as (max existing seq + 1) for this session,
     * starting at 0.
     */
    addFlowExecution(sessionId: string, record: FlowExecutionRecord): void {
        const db = this.getDb();

        // Determine next seq
        const seqResult = db.exec(
            `SELECT COALESCE(MAX(seq) + 1, 0) as next_seq FROM flow_executions WHERE session_id = '${sessionId.replace(/'/g, "''")}'`
        );
        const nextSeq = (seqResult[0]?.values[0]?.[0] as number) ?? 0;

        const stmt = db.prepare(
            `INSERT INTO flow_executions
                (session_id, flow_name, flow_path, started_at, ended_at, duration_ms, output, succeeded, cancelled, debug_output_dir, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        stmt.run([
            sessionId,
            record.flowName,
            record.flowPath ?? null,
            record.startedAt,
            record.endedAt,
            record.durationMs,
            record.output ?? null,
            record.succeeded ? 1 : 0,
            record.cancelled ? 1 : 0,
            record.debugOutputDir ?? null,
            nextSeq,
        ]);
        stmt.free();
    }

    /**
     * Retrieve all FlowExecutionRecords for a session, ordered by seq.
     */
    getFlowExecutions(sessionId: string): FlowExecutionRecord[] {
        const db = this.getDb();
        const stmt = db.prepare(
            `SELECT * FROM flow_executions WHERE session_id = ? ORDER BY seq ASC`
        );
        stmt.bind([sessionId]);
        const results: FlowExecutionRecord[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            const rec: FlowExecutionRecord = {
                flowName: row.flow_name as string,
                startedAt: row.started_at as string,
                endedAt: row.ended_at as string,
                durationMs: row.duration_ms as number,
                output: (row.output as string) ?? '',
                succeeded: (row.succeeded as number) !== 0,
            };
            if (row.cancelled as number) {
                rec.cancelled = true;
            }
            if (row.debug_output_dir != null) {
                rec.debugOutputDir = row.debug_output_dir as string;
            }
            if (row.flow_path != null) {
                rec.flowPath = row.flow_path as string;
            }
            results.push(rec);
        }
        stmt.free();
        return results;
    }

    /**
     * Delete all flow_executions rows for a session.
     * Called from forceCleanup to release storage.
     */
    deleteFlowExecutions(sessionId: string): void {
        const db = this.getDb();
        const stmt = db.prepare(`DELETE FROM flow_executions WHERE session_id = ?`);
        stmt.run([sessionId]);
        stmt.free();
    }

    /**
     * Close the database connection.
     */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
