import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { Session, SessionStatus, UIInteraction, NetworkEvent, MobilePlatform } from '../types.js';

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
                proxymanBaseline INTEGER
            );

            CREATE TABLE IF NOT EXISTS ui_interactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sessionId TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                actionType TEXT NOT NULL,
                element TEXT NOT NULL,
                textInput TEXT,
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
        const stmt = db.prepare(`INSERT INTO sessions (id, appBundleId, platform, status, startedAt, stoppedAt, proxymanBaseline) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        stmt.run([session.id, session.appBundleId, session.platform, session.status, session.startedAt, session.stoppedAt || null, session.proxymanBaseline ?? null]);
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
        const stmt = db.prepare(`INSERT INTO ui_interactions (sessionId, timestamp, actionType, element, textInput) VALUES (?, ?, ?, ?, ?)`);
        stmt.run([
            interaction.sessionId,
            interaction.timestamp,
            interaction.actionType,
            JSON.stringify(interaction.element),
            interaction.textInput || null,
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
