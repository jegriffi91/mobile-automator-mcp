/**
 * Phase 6 — SessionDatabase persistence tests.
 *
 * Verifies round-trip behaviour for the new Phase 6 columns and tables:
 *   - device_id / setDeviceId
 *   - driver_timeouts_json / setDriverTimeouts / getDriverTimeouts
 *   - flow_executions / addFlowExecution / getFlowExecutions / deleteFlowExecutions
 *
 * sql.js is in-memory only — each test gets a fresh database so there are no
 * ordering dependencies between tests.
 */

import { describe, it, expect } from 'vitest';
import { SessionDatabase } from './database.js';
import type { FlowExecutionRecord } from '../types.js';

async function freshDb(): Promise<{ db: SessionDatabase; sessionId: string }> {
    const db = new SessionDatabase();
    await db.initialize();
    const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
    db.insertSession({
        id: sessionId,
        appBundleId: 'com.test.app',
        platform: 'ios',
        status: 'recording',
        startedAt: new Date().toISOString(),
    });
    return { db, sessionId };
}

describe('SessionDatabase.setDeviceId', () => {
    it('persists deviceId and rowToSession returns it via getSession', async () => {
        const { db, sessionId } = await freshDb();
        db.setDeviceId(sessionId, 'IPHONE-14-SIM');
        const session = db.getSession(sessionId);
        expect(session?.deviceId).toBe('IPHONE-14-SIM');
    });

    it('is nullable — sessions without a deviceId return undefined', async () => {
        const { db, sessionId } = await freshDb();
        const session = db.getSession(sessionId);
        expect(session?.deviceId).toBeUndefined();
    });
});

describe('SessionDatabase.setDriverTimeouts / getDriverTimeouts', () => {
    it('round-trips a partial TimeoutConfig', async () => {
        const { db, sessionId } = await freshDb();
        const timeouts = { actionMs: 20_000, testRunMs: 180_000 };
        db.setDriverTimeouts(sessionId, timeouts);

        const retrieved = db.getDriverTimeouts(sessionId);
        expect(retrieved).toEqual(timeouts);
    });

    it('returns undefined when no timeouts have been set', async () => {
        const { db, sessionId } = await freshDb();
        expect(db.getDriverTimeouts(sessionId)).toBeUndefined();
    });

    it('overrides previous value on a second call', async () => {
        const { db, sessionId } = await freshDb();
        db.setDriverTimeouts(sessionId, { actionMs: 5_000 });
        db.setDriverTimeouts(sessionId, { actionMs: 10_000, daemonRequestMs: 25_000 });
        const retrieved = db.getDriverTimeouts(sessionId);
        expect(retrieved).toEqual({ actionMs: 10_000, daemonRequestMs: 25_000 });
    });

    it('rowToSession populates driverTimeouts from getSession', async () => {
        const { db, sessionId } = await freshDb();
        db.setDriverTimeouts(sessionId, { hierarchyDumpMs: 60_000 });
        const session = db.getSession(sessionId);
        expect(session?.driverTimeouts).toEqual({ hierarchyDumpMs: 60_000 });
    });
});

describe('SessionDatabase.addFlowExecution / getFlowExecutions', () => {
    function makeRecord(overrides: Partial<FlowExecutionRecord> = {}): FlowExecutionRecord {
        return {
            flowName: 'login.flow',
            startedAt: '2025-01-01T00:00:00.000Z',
            endedAt: '2025-01-01T00:00:05.000Z',
            durationMs: 5_000,
            output: 'some output',
            succeeded: true,
            ...overrides,
        };
    }

    it('stores and retrieves a single record', async () => {
        const { db, sessionId } = await freshDb();
        db.addFlowExecution(sessionId, makeRecord());
        const execs = db.getFlowExecutions(sessionId);
        expect(execs).toHaveLength(1);
        expect(execs[0].flowName).toBe('login.flow');
        expect(execs[0].succeeded).toBe(true);
        expect(execs[0].durationMs).toBe(5_000);
    });

    it('preserves optional fields (cancelled, debugOutputDir, flowPath)', async () => {
        const { db, sessionId } = await freshDb();
        db.addFlowExecution(
            sessionId,
            makeRecord({
                cancelled: true,
                debugOutputDir: '/tmp/mca-flow-xyz',
                flowPath: '/abs/path/login.yaml',
            }),
        );
        const execs = db.getFlowExecutions(sessionId);
        expect(execs[0].cancelled).toBe(true);
        expect(execs[0].debugOutputDir).toBe('/tmp/mca-flow-xyz');
        expect(execs[0].flowPath).toBe('/abs/path/login.yaml');
    });

    it('omits optional fields when not supplied', async () => {
        const { db, sessionId } = await freshDb();
        db.addFlowExecution(sessionId, makeRecord());
        const execs = db.getFlowExecutions(sessionId);
        expect(execs[0].cancelled).toBeUndefined();
        expect(execs[0].debugOutputDir).toBeUndefined();
        expect(execs[0].flowPath).toBeUndefined();
    });

    it('returns multiple records in seq (insertion) order', async () => {
        const { db, sessionId } = await freshDb();
        db.addFlowExecution(sessionId, makeRecord({ flowName: 'first.flow' }));
        db.addFlowExecution(sessionId, makeRecord({ flowName: 'second.flow' }));
        db.addFlowExecution(sessionId, makeRecord({ flowName: 'third.flow' }));

        const execs = db.getFlowExecutions(sessionId);
        expect(execs).toHaveLength(3);
        expect(execs.map((e) => e.flowName)).toEqual(['first.flow', 'second.flow', 'third.flow']);
    });

    it('returns empty array when no executions recorded', async () => {
        const { db, sessionId } = await freshDb();
        expect(db.getFlowExecutions(sessionId)).toEqual([]);
    });

    it('handles succeeded=false correctly', async () => {
        const { db, sessionId } = await freshDb();
        db.addFlowExecution(sessionId, makeRecord({ succeeded: false }));
        const execs = db.getFlowExecutions(sessionId);
        expect(execs[0].succeeded).toBe(false);
    });
});

describe('SessionDatabase.deleteFlowExecutions', () => {
    it('removes all flow_executions for a session', async () => {
        const { db, sessionId } = await freshDb();
        db.addFlowExecution(sessionId, {
            flowName: 'a.flow',
            startedAt: '2025-01-01T00:00:00.000Z',
            endedAt: '2025-01-01T00:00:01.000Z',
            durationMs: 1_000,
            output: '',
            succeeded: true,
        });
        db.addFlowExecution(sessionId, {
            flowName: 'b.flow',
            startedAt: '2025-01-01T00:00:01.000Z',
            endedAt: '2025-01-01T00:00:02.000Z',
            durationMs: 1_000,
            output: '',
            succeeded: true,
        });
        db.deleteFlowExecutions(sessionId);
        expect(db.getFlowExecutions(sessionId)).toEqual([]);
    });

    it('is a no-op when no executions exist', async () => {
        const { db, sessionId } = await freshDb();
        expect(() => db.deleteFlowExecutions(sessionId)).not.toThrow();
        expect(db.getFlowExecutions(sessionId)).toEqual([]);
    });
});
