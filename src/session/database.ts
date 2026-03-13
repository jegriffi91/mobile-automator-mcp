import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { Session, SessionStatus, UIInteraction, NetworkEvent, MobilePlatform, HierarchySnapshot, CaptureMode } from '../types.js';

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
                proxymanBaseline INTEGER,
                filterDomains TEXT,
                captureMode TEXT,
                pollingIntervalMs INTEGER,
                settleTimeoutMs INTEGER,
                trackEventPaths TEXT
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
        const stmt = db.prepare(`INSERT INTO sessions (id, appBundleId, platform, status, startedAt, stoppedAt, proxymanBaseline, filterDomains, captureMode, pollingIntervalMs, settleTimeoutMs, trackEventPaths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run([
            session.id,
            session.appBundleId,
            session.platform,
            session.status,
            session.startedAt,
            session.stoppedAt || null,
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
            return {
                id: row.id as string,
                appBundleId: row.appBundleId as string,
                platform: row.platform as MobilePlatform,
                status: row.status as SessionStatus,
                startedAt: row.startedAt as string,
                stoppedAt: (row.stoppedAt as string) || undefined,
                proxymanBaseline: row.proxymanBaseline != null ? (row.proxymanBaseline as number) : undefined,
                filterDomains: row.filterDomains ? JSON.parse(row.filterDomains as string) : undefined,
                captureMode: (row.captureMode as CaptureMode) || undefined,
                pollingIntervalMs: row.pollingIntervalMs != null ? (row.pollingIntervalMs as number) : undefined,
                settleTimeoutMs: row.settleTimeoutMs != null ? (row.settleTimeoutMs as number) : undefined,
                trackEventPaths: row.trackEventPaths ? JSON.parse(row.trackEventPaths as string) : undefined,
            };
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
