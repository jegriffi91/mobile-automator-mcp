/**
 * Phase 5 — end-to-end flow-weaving integration test.
 *
 * Verifies that handleStopAndCompile:
 *   1. Reads FlowExecutionRecord[] from SessionManager
 *   2. Parses commands-*.json from each record's debugOutputDir
 *   3. Reconciles boundaries with parsed steps via weaveFlowExecutions
 *   4. Emits a `runFlow:` directive in the compiled YAML at the right position
 *   5. Renders a `type: 'flow'` entry in the timeline.json
 *   6. Strips flow_boundary records from the compiled output
 *   7. Surfaces a per-flow summary in StopAndCompileOutput.flowExecutions
 *
 * The driver/Maestro layer is mocked — the test seeds the SessionManager's
 * Phase-4 state (boundary markers + FlowExecutionRecord) directly and lets
 * handleStopAndCompile run through its real compile pipeline.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mockProxymanWrapper = {
    snapshotBaseline: vi.fn().mockResolvedValue(0),
    exportHarScopedParsed: vi.fn().mockResolvedValue({ log: { entries: [] } }),
    getTransactions: vi.fn().mockResolvedValue([]),
    getPayload: vi.fn().mockResolvedValue(null),
    exportHar: vi.fn().mockResolvedValue('/tmp/mock.har'),
    exportHarScoped: vi.fn().mockResolvedValue('/tmp/mock-scoped.har'),
};

vi.mock('../../src/maestro/driver.js', () => ({
    DriverFactory: {
        create: vi.fn(),
        createCliOnly: vi.fn(),
    },
}));

vi.mock('../../src/proxyman/index.js', () => ({
    proxymanWrapper: mockProxymanWrapper,
    ProxymanWrapper: vi.fn().mockImplementation(() => mockProxymanWrapper),
    PayloadValidator: {
        validate: vi.fn().mockReturnValue({ matched: true, mismatches: [] }),
    },
    resolveCliPath: vi.fn().mockResolvedValue('/usr/bin/proxyman-cli'),
    _resetResolvedCliPath: vi.fn(),
}));

import { sessionManager } from '../../src/session/index.js';
const { DriverFactory } = await import('../../src/maestro/driver.js');
const { handleStartRecording, handleStopAndCompile } = await import('../../src/handlers.js');

const mockDriverFns = {
    dumpHierarchy: vi.fn().mockResolvedValue(''),
    dumpHierarchyLite: vi.fn().mockResolvedValue(''),
    dumpHierarchyUntilSettled: vi.fn().mockResolvedValue({ hierarchy: '', settleDurationMs: 1 }),
    executeAction: vi.fn().mockResolvedValue({ success: true }),
    runTest: vi.fn(),
    validateSetup: vi.fn().mockResolvedValue(undefined),
    validateSimulator: vi.fn().mockResolvedValue({ booted: true, deviceId: 'FAKE-UUID' }),
    uninstallDriver: vi.fn().mockResolvedValue(undefined),
    ensureCleanDriverState: vi.fn().mockResolvedValue(undefined),
    createTreeReader: vi
        .fn()
        .mockReturnValue(async () => ({ role: 'Application', children: [] })),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: true,
};

const FIXTURE_DIR = path.join(
    process.cwd(),
    'tests',
    'fixtures',
    'maestro-debug',
    'sample-flow',
);

describe('Phase 5 — flow weaving in handleStopAndCompile', () => {
    beforeAll(async () => {
        await sessionManager.initialize();
    });

    beforeEach(() => {
        vi.mocked(DriverFactory.create).mockResolvedValue(mockDriverFns as never);
        vi.mocked(DriverFactory.createCliOnly).mockResolvedValue(mockDriverFns as never);
        mockProxymanWrapper.exportHarScopedParsed.mockResolvedValue({ log: { entries: [] } });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('weaves a recorded flow into the compiled YAML, timeline, and summary', async () => {
        // Start a real recording session. Patches in mocked driver via DriverFactory.
        const start = await handleStartRecording({
            appBundleId: 'com.example.app',
            platform: 'ios',
        });
        const sessionId = start.sessionId;

        // Seed Phase-4 boundary markers by exercising the real pause/resume
        // path. We need an active poller for pauseSession to insert markers,
        // and startRecording already started one via the mocked driver.
        const flowName = 'login.yaml';
        const flowStartedAt = '2026-04-28T10:00:00.000Z';
        // pauseSession requires an active driver; startRecording installed one.
        await sessionManager.pauseSession(sessionId, flowName);

        // resumeSession recreates the driver via the mocked DriverFactory.
        // Pass extras to plumb debugOutputDir + flowPath onto the
        // FlowExecutionRecord. flowStartedAt is what handleStopAndCompile
        // will key parsedSteps by.
        await sessionManager.resumeSession(
            sessionId,
            'FAKE-UUID',
            'ios',
            'com.example.app',
            flowName,
            'maestro stdout',
            true,
            flowStartedAt,
            undefined,
            {
                debugOutputDir: FIXTURE_DIR,
                flowPath: '/abs/login.yaml',
            },
        );

        // Override the boundary-marker timestamps to deterministic values so
        // the weaver's tolerance window matches FlowExecutionRecord.startedAt.
        // We rebuild the inferrer's pollRecords by re-seeding through the
        // public API: the pause inserted flow_start at "now" and resume
        // inserted flow_end at "now", but we passed flowStartedAt as the
        // FlowExecutionRecord.startedAt. The weaver matches by flowName +
        // ±1000ms tolerance — the markers are within tolerance of each other
        // but not of flowStartedAt. To make the test deterministic we instead
        // reach in and set the FlowExecutionRecord.startedAt to the actual
        // flow_start marker timestamp.
        const records = sessionManager.getPollRecords(sessionId);
        const startMarker = records.find(
            (r) => r.result === 'flow_boundary' && r.boundaryKind === 'flow_start',
        );
        expect(startMarker).toBeDefined();
        // Re-assign the FlowExecutionRecord.startedAt to align with the
        // boundary timestamp (private field access is acceptable in tests).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const flowExecsMap = (sessionManager as any).flowExecutions as Map<
            string,
            { flowName: string; startedAt: string; debugOutputDir?: string }[]
        >;
        const list = flowExecsMap.get(sessionId);
        expect(list).toBeDefined();
        if (list && startMarker) {
            list[0].startedAt = startMarker.timestamp;
        }

        // Compile.
        const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-weaving-'));
        const outputPath = path.join(outputDir, 'compiled.yaml');
        const result = await handleStopAndCompile({ sessionId, outputPath });

        // ── Assertions ──

        // YAML contains a runFlow: directive.
        expect(result.yaml).toContain('- runFlow:');
        expect(result.yaml).toContain('# Flow: login.yaml');

        // flowExecutions summary surfaced.
        expect(result.flowExecutions).toBeDefined();
        expect(result.flowExecutions).toHaveLength(1);
        expect(result.flowExecutions?.[0].flowName).toBe('login.yaml');
        expect(result.flowExecutions?.[0].stepCount).toBe(3);
        expect(result.flowExecutions?.[0].failedStepIndex).toBe(2); // assertVisible failed in fixture

        // timeline.json has a 'flow' entry; flow_boundary records absent.
        expect(result.timelinePath).toBeDefined();
        const timelineRaw = await fs.readFile(result.timelinePath!, 'utf-8');
        const timeline = JSON.parse(timelineRaw);
        const flowEntries = timeline.entries.filter(
            (e: { type: string }) => e.type === 'flow',
        );
        expect(flowEntries).toHaveLength(1);
        expect(flowEntries[0].flowName).toBe('login.yaml');
        expect(flowEntries[0].steps).toHaveLength(3);
        const boundaryPolls = timeline.entries.filter(
            (e: { type: string; result?: string }) =>
                e.type === 'poll' && e.result === 'flow_boundary',
        );
        expect(boundaryPolls).toHaveLength(0);
    });
});
