/**
 * MCP tool handlers for all 9 tools.
 *
 * Input/output types are derived from Zod schemas (schemas.ts) —
 * the single source of truth for tool I/O shapes.
 *
 * Handlers use AutomationDriver (from driver.ts) to interact with Maestro,
 * decoupling tool logic from the specific backend (CLI vs MCP daemon).
 */

import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { sessionManager } from './session/index.js';
import { runHandler } from './cleanup.js';
import { DriverFactory, type AutomationDriver } from './maestro/driver.js';
import { HierarchyParser } from './maestro/index.js';
import { proxymanWrapper, PayloadValidator } from './proxyman/index.js';
import { Correlator, YamlGenerator, StubWriter } from './synthesis/index.js';
import { TimelineBuilder } from './synthesis/timeline-builder.js';
import { SegmentFingerprint, SegmentRegistry } from './segments/index.js';
import { FlowRegistry } from './flows/index.js';
import {
    buildIosApp,
    installIosApp,
    uninstallIosApp,
    bootIosSimulator,
    buildAndroidApp,
    installAndroidApp,
    uninstallAndroidApp,
    DEFAULT_BUILD_TIMEOUT_MS,
} from './build/index.js';
import { takeIosScreenshot, takeAndroidScreenshot } from './screenshot/index.js';
import { runIosUnitTests, runAndroidUnitTests } from './testing/index.js';
import { StubServer } from './wiremock/index.js';
import { extractTrackEvents } from './session/track-event-extractor.js';
import {
    getMergedEvents,
    matchEvent,
    filterEvents,
    findFirstMatch,
    extractOperationName,
    describeMatcher,
    resolveAfterAction,
    eventsInWindow,
    getByPath,
    existsAtPath,
    computeDurationStats,
} from './verification/index.js';
import type { AfterActionRef } from './verification/index.js';
import { assertNoActiveSessions } from './testing/driver-conflict.js';
import type { MockingConfig } from './synthesis/index.js';
import type { NetworkEvent, StateChange } from './types.js';
import type { PollingNotifier } from './session/touch-inferrer.js';
import type { ProfilingDriver, ProfilingMetrics } from './profiling/profiler.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
    StartRecordingInput,
    StartRecordingOutput,
    StopAndCompileInput,
    StopAndCompileOutput,
    GetUIHierarchyInput,
    GetUIHierarchyOutput,
    ExecuteUIActionInput,
    ExecuteUIActionOutput,
    GetNetworkLogsInput,
    GetNetworkLogsOutput,
    VerifySDUIPayloadInput,
    VerifySDUIPayloadOutput,
    VerifyNetworkParallelismInput,
    VerifyNetworkParallelismOutput,
    VerifyNetworkOnScreenInput,
    VerifyNetworkOnScreenOutput,
    VerifyNetworkAbsentInput,
    VerifyNetworkAbsentOutput,
    VerifyNetworkSequenceInput,
    VerifyNetworkSequenceOutput,
    VerifyNetworkPerformanceInput,
    VerifyNetworkPerformanceOutput,
    VerifyNetworkPayloadInput,
    VerifyNetworkPayloadOutput,
    VerifyNetworkDeduplicationInput,
    VerifyNetworkDeduplicationOutput,
    VerifyNetworkErrorHandlingInput,
    VerifyNetworkErrorHandlingOutput,
    RegisterSegmentInput,
    RegisterSegmentOutput,
    RunTestInput,
    RunTestOutput,
    ListDevicesInput,
    ListDevicesOutput,
    GetSessionTimelineInput,
    GetSessionTimelineOutput,
    ListFlowsInput,
    ListFlowsOutput,
    RunFlowInput,
    RunFlowOutput,
    BuildAppInput,
    BuildAppOutput,
    InstallAppInput,
    InstallAppOutput,
    UninstallAppInput,
    UninstallAppOutput,
    BootSimulatorInput,
    BootSimulatorOutput,
    TakeScreenshotInput,
    TakeScreenshotOutput,
    RunUnitTestsInput,
    RunUnitTestsOutput,
    RunFeatureTestInput,
    RunFeatureTestOutput,
    SetMockResponseInput,
    SetMockResponseOutput,
    ClearMockResponsesInput,
    ClearMockResponsesOutput,
    StartBuildInput,
    StartBuildOutput,
    PollTaskStatusInput,
    PollTaskStatusOutput,
    GetTaskResultInput,
    GetTaskResultOutput,
    CancelTaskInput,
    CancelTaskOutput,
    ListTasksInput,
    ListTasksOutput,
} from './schemas.js';
import { taskRegistry, type TaskKind, type TaskStatus } from './tasks/registry.js';
import { runFeatureTest, defaultSleep } from './featureTest/index.js';
import {
    getProxymanMcpClient,
    type ProxymanMcpClient,
    buildScriptContent,
    buildProxymanUrlPattern,
    buildRuleName,
    isOurRuleForSession,
    ProxymanMcpError,
} from './proxymanMcp/index.js';
import { randomBytes } from 'crypto';

const execFileAsync = promisify(execFile);

// ── MCP Server reference for sending logging notifications ──
let mcpServer: McpServer | undefined;

/** Set the MCP server instance for real-time polling notifications */
export function setMcpServer(server: McpServer): void {
    mcpServer = server;
}

/** Create a PollingNotifier that sends messages via MCP logging API */
function createPollingNotifier(): PollingNotifier | undefined {
    if (!mcpServer) return undefined;
    const server = mcpServer;
    return (level: string, data: Record<string, unknown>) => {
        server.sendLoggingMessage({
            level: level as 'info' | 'debug' | 'warning' | 'error',
            logger: 'TouchInferrer',
            data,
        }).catch(() => {
            // Best-effort — don't crash on notification failure
        });
    };
}

// Per-session driver registry, plus per-session and standalone mock ledgers,
// now live on SessionManager (sessionManager.{setActiveDriver, addSessionMock,
// addStandaloneMock, ...}). Centralising state on the manager makes cleanup
// from runHandler-driven rollback paths and the new admin tools (Phase 1 step 6)
// possible without re-exporting the maps.

const STANDALONE_TAG_PREFIX = 'mca:standalone';

/**
 * How long handleCancelTask busy-polls for the runner to settle into a
 * terminal state before giving up and returning the current (possibly
 * 'cancelling') status. Exported so tests can shrink it for speed.
 */
export let CANCEL_DEADLINE_MS = 10_000;
export function _setCancelDeadlineMsForTests(ms: number): number {
    const prev = CANCEL_DEADLINE_MS;
    CANCEL_DEADLINE_MS = ms;
    return prev;
}

/**
 * Grace period above the inner build timeout before the registry watchdog
 * fires. The inner xcodebuild/gradle timeout already kills hanging child
 * processes; this outer watchdog only catches the case where the inner kill
 * itself stalls (e.g. uninterruptible Swift compile, runaway log streaming).
 */
export const OUTER_BUILD_GRACE_MS = 30_000;

/**
 * Phase 4 feature flag — when enabled, run_test/run_flow pause an active
 * recording session for the duration of the flow and resume it afterward.
 * When disabled (default), the legacy assertNoActiveSessions guard fires
 * with a hard error.
 *
 * Read once at module load; tests flip via _setFlowPauseResumeEnabledForTests.
 */
let _flowPauseResumeEnabled = process.env.MCA_FLOW_PAUSE_RESUME === 'on';

/** Test-only — flip the Phase 4 feature flag at runtime. Returns the previous value. */
export function _setFlowPauseResumeEnabledForTests(value: boolean): boolean {
    const prev = _flowPauseResumeEnabled;
    _flowPauseResumeEnabled = value;
    return prev;
}

/**
 * Outer watchdog for the pause→flow→resume cycle. The flow itself has its
 * own testRunMs timeout in MaestroWrapper.runTest; this is purely the upper
 * bound on the orchestration (pause + flow + resume) before runHandler's
 * cleanup stack fires resume on the error path.
 */
const PAUSE_RESUME_WATCHDOG_MS = 5 * 60_000;

/**
 * Test-only — replace the Proxyman MCP client used by handlers. Returns the
 * previous instance so tests can restore it.
 */
let _proxymanClientFactory: () => ProxymanMcpClient = getProxymanMcpClient;
export function _setProxymanMcpClientFactory(factory: () => ProxymanMcpClient): () => ProxymanMcpClient {
    const prev = _proxymanClientFactory;
    _proxymanClientFactory = factory;
    return prev;
}

// ── Persistent standalone driver (reused across sessionless get_ui_hierarchy calls) ──
// Daemon-backed so the JVM stays warm after the first call.
let standaloneDriver: AutomationDriver | null = null;

// ---- start_recording_session ----
export async function handleStartRecording(
    input: StartRecordingInput
): Promise<StartRecordingOutput> {
    const sessionId = randomUUID();
    console.error(
        `[MCP] start_recording_session: starting session ${sessionId} for ${input.appBundleId} on ${input.platform}`
    );

    return runHandler({ name: `start_recording_session(${sessionId})` }, async (cleanup) => {
        // Create driver with optional timeout overrides
        const driver = await DriverFactory.create(input.timeouts);

        const validation = await driver.validateSimulator(input.platform);
        if (!validation.booted) {
            throw new Error(`No booted ${input.platform} simulator found. Please boot a device first.`);
        }

        // Fast-fail if Java or Maestro isn't available
        await driver.validateSetup();

        // Uninstall the stale Maestro driver AND wait for the simulator to release
        // port 7001 — otherwise the first `maestro` command in this session can hit
        // ConnectException because the previous run's XCTRunner is still draining.
        await driver.ensureCleanDriverState(input.platform, validation.deviceId);

        await sessionManager.create(
            sessionId,
            input.appBundleId,
            input.platform,
            input.filterDomains,
            input.captureMode,
            input.pollingIntervalMs,
            input.settleTimeoutMs,
            input.trackEventPaths,
        );
        // Phase 4: stash deviceId + driverTimeouts so resumeSession can
        // recreate the daemon driver after a paused flow run.
        sessionManager.setSessionRuntime(sessionId, {
            deviceId: validation.deviceId,
            driverTimeouts: input.timeouts,
        });
        cleanup.add('mark session aborted', () =>
            sessionManager.markAborted(sessionId, 'start_recording_session aborted'),
        );

        // Start driver and Proxyman baseline concurrently — baseline is non-critical
        // and should not block Maestro startup even if Proxyman resolution is slow
        let baselineCaptured = false;
        const baselinePromise = proxymanWrapper.snapshotBaseline(input.filterDomains)
            .then(async (baseline) => {
                await sessionManager.updateBaseline(sessionId, baseline);
                baselineCaptured = true;
                return baseline;
            })
            .catch((error) => {
                console.error('[MCP] start_recording_session: Proxyman baseline snapshot failed (Proxyman may not be running)', error);
                return null; // Non-fatal: we'll still capture all traffic at compile time
            });
        cleanup.add('await baseline promise', async () => {
            await baselinePromise.catch(() => {});
        });

        await driver.start(validation.deviceId);
        const driverReady = true;
        cleanup.add('stop driver', () => driver.stop().catch(() => {}));

        // Await baseline result (likely already settled while driver was starting)
        await baselinePromise;

        sessionManager.setActiveDriver(sessionId, driver);
        cleanup.add('remove from activeDrivers', () => {
            sessionManager.removeActiveDriver(sessionId);
        });

        // Start polling — driver provides the hierarchy reader
        const notifier = createPollingNotifier();
        await sessionManager.startPolling(sessionId, input.platform, input.appBundleId, driver, notifier);
        const pollerStarted = true;
        cleanup.add('stop poller', () => sessionManager.stopPolling(sessionId));

        // Best-effort: ask Proxyman to enable SSL Proxying for each filterDomain so
        // any later set_mock_response can transparently mock HTTPS traffic. This
        // only matters when the user's app talks to HTTPS backends, but the cost
        // when it doesn't is negligible. Skipped silently if Proxyman MCP isn't
        // available — the rest of the session works without it.
        if (input.filterDomains && input.filterDomains.length > 0) {
            const proxymanClient = _proxymanClientFactory();
            for (const domain of input.filterDomains) {
                // Strip any port suffix — enable_ssl_proxying takes hosts only.
                const hostOnly = domain.split(':')[0];
                try {
                    await proxymanClient.enableSslProxying(hostOnly);
                } catch (err) {
                    console.error(
                        `[MCP] start_recording_session: enable_ssl_proxying("${hostOnly}") failed (non-fatal)`,
                        err,
                    );
                    break; // Don't keep trying if Proxyman MCP isn't reachable
                }
            }
        }

        const readinessMsg = baselineCaptured
            ? 'All systems ready'
            : 'Ready (Proxyman baseline not available — network correlation may be less precise)';

        // Success: live session keeps its driver/poller/baseline/session row.
        cleanup.forget('stop poller');
        cleanup.forget('remove from activeDrivers');
        cleanup.forget('stop driver');
        cleanup.forget('await baseline promise');
        cleanup.forget('mark session aborted');

        return {
            sessionId,
            message: `Recording session ${sessionId} started for ${input.appBundleId}. Device ID: ${validation.deviceId ?? 'unknown'}. ${readinessMsg}. Use this session ID for subsequent tool calls.`,
            readiness: {
                driverReady,
                baselineCaptured,
                pollerStarted,
            },
        };
    });
}

// ---- stop_and_compile_test ----
export async function handleStopAndCompile(
    input: StopAndCompileInput
): Promise<StopAndCompileOutput> {
    console.error(`[MCP] stop_and_compile_test: compiling session ${input.sessionId}`);

    // State machine: recording → compiling
    await sessionManager.transition(input.sessionId, 'compiling');

    // Fetch session metadata
    const session = await sessionManager.getSession(input.sessionId);
    if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
    }

    // All compilation artifacts — populated inside the try block
    let proxymanEvents: NetworkEvent[] = [];
    let allInteractions: typeof interactions = [];
    let interactions: Awaited<ReturnType<typeof sessionManager.getInteractions>> = [];
    const allNetworkEvents: NetworkEvent[] = [];
    let steps: ReturnType<Correlator['correlate']> = [];
    let yaml = '';
    let outputPath = '';
    let fixturesDir: string | undefined;
    let stubsDir: string | undefined;
    let manifestPath: string | undefined;
    let segmentFingerprint: string | undefined;
    let matchedSegments: Array<{ name: string; fingerprint: string; similarity: number; yamlPath: string }> | undefined;
    let pollingDiagnostics: ReturnType<typeof sessionManager.getPollingStatus> | undefined;
    let timelinePath: string | undefined;

    try {
        // ── Step 1: Export scoped Proxyman HAR ──
        try {
            const baseline = session.proxymanBaseline ?? 0;
            const har = await proxymanWrapper.exportHarScopedParsed(baseline, session.filterDomains, session.startedAt);
            proxymanEvents = (har.log?.entries || []).map((entry: any) => ({
                sessionId: input.sessionId,
                timestamp: entry.startedDateTime,
                method: entry.request.method,
                url: entry.request.url,
                statusCode: entry.response.status,
                requestBody: entry.request.postData?.text,
                responseBody: entry.response.content?.text,
                durationMs: entry.time ? Math.round(entry.time) : undefined,
            }));
            console.error(`[MCP] stop_and_compile_test: ${proxymanEvents.length} scoped network events from Proxyman`);
        } catch (error) {
            console.error('[MCP] stop_and_compile_test: Proxyman scoped export failed, using session DB events only', error);
        }

        // ── Step 2: Fetch UI interactions from session DB ──
        interactions = await sessionManager.getInteractions(input.sessionId);

        // Merge Proxyman events with any already-logged session DB events
        const dbEvents = await sessionManager.getNetworkEvents(input.sessionId);
        const seen = new Set<string>();
        for (const event of [...dbEvents, ...proxymanEvents]) {
            const key = `${event.url}|${event.timestamp}`;
            if (!seen.has(key)) {
                seen.add(key);
                allNetworkEvents.push(event);
            }
        }

        // ── Step 2b: Extract tracked interactions from network events ──
        const trackPaths = session.trackEventPaths;
        console.error(
            `[MCP] stop_and_compile_test: track extraction — ` +
            `totalEvents: ${allNetworkEvents.length}, ` +
            `trackEventPaths: ${JSON.stringify(trackPaths)}, ` +
            `POST events: ${allNetworkEvents.filter(e => e.method === 'POST').length}`
        );
        // Log events that match the track path pattern
        const matchingEvents = allNetworkEvents.filter(e =>
            e.method === 'POST' && (trackPaths ?? ['/__track']).some(p => e.url.includes(p))
        );
        console.error(
            `[MCP] stop_and_compile_test: matching track events: ${matchingEvents.length}`
        );
        for (const me of matchingEvents) {
            console.error(
                `[MCP]   → ${me.url} | requestBody present: ${!!me.requestBody} | body: ${me.requestBody?.substring(0, 200)}`
            );
        }
        const trackedInteractions = extractTrackEvents(
            allNetworkEvents,
            input.sessionId,
            { paths: session.trackEventPaths },
        );
        if (trackedInteractions.length > 0) {
            console.error(
                `[MCP] stop_and_compile_test: extracted ${trackedInteractions.length} tracked interaction(s) from network events`
            );
        }

        // Merge all interaction sources: dispatched (AI-led) + inferred (touch) + tracked (app-side)
        allInteractions = [...interactions, ...trackedInteractions].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        console.error(
            `[MCP] stop_and_compile_test: correlating ${allInteractions.length} interactions (${interactions.length} dispatched/inferred + ${trackedInteractions.length} tracked) with ${allNetworkEvents.length} network events`
        );

        // ── Step 3: Correlate UI actions with network events ──
        const correlator = new Correlator();
        steps = correlator.correlate(allInteractions, allNetworkEvents);

        // ── Step 4: Generate YAML ──
        const generator = new YamlGenerator(session.appBundleId);
        yaml = generator.toYaml(steps, input.conditions);

        // Write YAML
        outputPath = input.outputPath ?? path.join(os.tmpdir(), `maestro-test-${input.sessionId}.yaml`);
        await fs.writeFile(outputPath, yaml, 'utf-8');

        // ── Step 5: Generate WireMock stubs (if network events exist) ──
        if (allNetworkEvents.length > 0) {
            const outputDir = path.dirname(outputPath);
            const sessionDir = path.join(outputDir, `session-${input.sessionId}`);

            const mockingConfig: MockingConfig = input.mockingConfig ?? { mode: 'full' };
            const stubWriter = new StubWriter();
            const manifest = await stubWriter.writeStubs(
                input.sessionId,
                steps,
                sessionDir,
                mockingConfig
            );

            fixturesDir = path.join(sessionDir, 'wiremock', '__files');
            stubsDir = path.join(sessionDir, 'wiremock');
            manifestPath = path.join(sessionDir, 'manifest.json');

            console.error(
                `[MCP] stop_and_compile_test: wrote ${manifest.routes.length} WireMock stubs to ${stubsDir}`
            );
        }

        // ── Step 6: Compute segment fingerprint and check registry ──
        if (steps.length > 0) {
            segmentFingerprint = SegmentFingerprint.compute(steps);
            console.error(`[MCP] stop_and_compile_test: fingerprint = ${segmentFingerprint}`);

            try {
                const registryPath = path.join(process.cwd(), 'segments', 'registry.json');
                const entries = await SegmentRegistry.load(registryPath);
                const matches = SegmentRegistry.findMatches(entries, segmentFingerprint);
                if (matches.length > 0) {
                    matchedSegments = matches.map((m) => ({
                        name: m.entry.name,
                        fingerprint: m.entry.fingerprint,
                        similarity: m.similarity,
                        yamlPath: m.entry.yamlPath,
                    }));
                    console.error(
                        `[MCP] stop_and_compile_test: matched ${matches.length} existing segment(s): ${matches.map((m) => m.entry.name).join(', ')}`
                    );
                }
            } catch {
                // Registry not found or invalid — not an error
            }
        }

        console.error(`[MCP] stop_and_compile_test: wrote ${steps.length} steps to ${outputPath}`);

        // ── Step 7: Capture polling diagnostics BEFORE stopping the poller ──
        const pollingStatus = sessionManager.getPollingStatus(input.sessionId);
        pollingDiagnostics = pollingStatus ?? undefined;

        if (pollingDiagnostics) {
            console.error(
                `[MCP] stop_and_compile_test: polling diagnostics — polls: ${pollingDiagnostics.pollCount}, success: ${pollingDiagnostics.successCount}, errors: ${pollingDiagnostics.errorCount}, inferred: ${pollingDiagnostics.inferredCount}` +
                (pollingDiagnostics.lastError ? `, lastError: ${pollingDiagnostics.lastError}` : '')
            );
        }

        // ── Step 7b: Build and write session timeline ──
        try {
            const pollRecords = sessionManager.getPollRecords(input.sessionId);
            const timelineBuilder = new TimelineBuilder();
            const timeline = timelineBuilder.build({
                session,
                readiness: {
                    driverReady: true, // If we reached compile, the driver started
                    baselineCaptured: session.proxymanBaseline != null,
                    pollerStarted: (pollingDiagnostics?.pollCount ?? 0) > 0,
                },
                interactions: allInteractions,
                networkEvents: allNetworkEvents,
                correlatedSteps: steps,
                pollRecords,
                pollingDiagnostics: pollingDiagnostics ?? undefined,
                correlationWindowMs: 3000,
            });

            const sessionDir = path.dirname(outputPath);
            const timelineDir = path.join(sessionDir, `session-${input.sessionId}`);
            await fs.mkdir(timelineDir, { recursive: true });
            timelinePath = path.join(timelineDir, 'timeline.json');
            await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');

            console.error(
                `[MCP] stop_and_compile_test: wrote timeline (${timeline.entries.length} entries, ${timeline.coverage.gaps.length} gaps) to ${timelinePath}`
            );
        } catch (error) {
            console.error('[MCP] stop_and_compile_test: timeline generation failed (non-fatal)', error);
        }

        if (allInteractions.length === 0 && pollingDiagnostics) {
            if (pollingDiagnostics.errorCount > 0) {
                console.error(
                    `[MCP] ⚠️  No interactions captured. Polling had ${pollingDiagnostics.errorCount} error(s). Last error: ${pollingDiagnostics.lastError}`
                );
            } else if (pollingDiagnostics.pollCount === 0) {
                console.error('[MCP] ⚠️  No interactions captured. Poller never ran — daemon may have failed to start.');
            } else {
                // Detailed breakdown of why no interactions were inferred
                const diag = [
                    `polls: ${pollingDiagnostics.pollCount}`,
                    `equalTrees: ${pollingDiagnostics.equalTreeCount ?? 0}`,
                    `thresholdExceeded: ${pollingDiagnostics.thresholdExceededCount ?? 0}`,
                    `diffButNull: ${pollingDiagnostics.diffButNullInferenceCount ?? 0}`,
                    `baselineElements: ${pollingDiagnostics.baselineElementCount ?? 0}`,
                ].join(', ');
                console.error(`[MCP] ⚠️  No interactions captured. Diagnostic breakdown: ${diag}`);

                if ((pollingDiagnostics.equalTreeCount ?? 0) > pollingDiagnostics.pollCount * 0.9) {
                    console.error('[MCP] 💡 Hint: >90% of polls returned identical trees. The daemon may be returning stale/cached hierarchy data.');
                }
                if ((pollingDiagnostics.thresholdExceededCount ?? 0) > 0) {
                    console.error(`[MCP] 💡 Hint: ${pollingDiagnostics.thresholdExceededCount} diff(s) exceeded the maxChangesThreshold. Consider raising the threshold for apps with many UI elements.`);
                }
                if ((pollingDiagnostics.diffButNullInferenceCount ?? 0) > 0) {
                    console.error(`[MCP] 💡 Hint: ${pollingDiagnostics.diffButNullInferenceCount} diff(s) had changes but no identifiable elements. The app may lack accessibility IDs.`);
                }
            }
        }
    } finally {
        // ── Guaranteed cleanup — runs even if compilation fails ──
        // Finalize session state
        try {
            await sessionManager.transition(input.sessionId, 'done');
        } catch (err) {
            console.error(`[MCP] stop_and_compile_test: failed to transition session to done (may already be done)`, err);
        }

        // Stop passive hierarchy polling
        await sessionManager.stopPolling(input.sessionId);

        // Stop and clean up the automation driver
        const driver = sessionManager.getActiveDriver(input.sessionId);
        if (driver) {
            try {
                await driver.uninstallDriver(session.platform, undefined);
                await driver.stop();
            } catch (err) {
                console.error('[MCP] stop_and_compile_test: driver cleanup failed (non-fatal)', err);
            }
            sessionManager.removeActiveDriver(input.sessionId);
        }

        // Bulk-delete any Proxyman scripting rules this session installed.
        // Uses the rule name prefix as the source of truth (resilient to the
        // ledger drifting from Proxyman's actual state — e.g. if the user
        // deleted some rules through the UI mid-session).
        await cleanupProxymanRulesForSession(input.sessionId);

        // Purge hierarchy snapshots to free memory
        await sessionManager.purgeSnapshots(input.sessionId);
    }

    return {
        sessionId: input.sessionId,
        yaml,
        yamlPath: outputPath,
        fixturesDir,
        stubsDir,
        manifestPath,
        segmentFingerprint,
        matchedSegments,
        pollingDiagnostics,
        timelinePath,
    };
}

// ---- get_ui_hierarchy ----
export async function handleGetUIHierarchy(
    input: GetUIHierarchyInput
): Promise<GetUIHierarchyOutput> {
    console.error(`[MCP] get_ui_hierarchy: capturing current screen`);

    // 1. Resolve driver: session-specific → auto-target booted device
    let driver: AutomationDriver;

    if (input.sessionId) {
        const sessionDriver = sessionManager.getActiveDriver(input.sessionId);
        if (!sessionDriver) {
            throw new Error(
                `No active driver for session ${input.sessionId}. ` +
                    `Was start_recording_session called?`
            );
        }
        driver = sessionDriver;
        console.error(`[MCP] get_ui_hierarchy: using session driver for ${input.sessionId}`);
    } else {
        // No session — use (or lazily create) a persistent daemon driver.
        // Keeps the JVM warm so repeated standalone calls skip the ~5s cold-start.
        if (!standaloneDriver) {
            standaloneDriver = await DriverFactory.create();
        }
        driver = standaloneDriver;

        // Only probe for a device when the daemon isn't running yet.
        // Once started, the daemon remembers its target and we skip the probe.
        if (!driver.isRunning) {
            const iosSim = await driver.validateSimulator('ios');
            if (iosSim.booted) {
                await driver.start(iosSim.deviceId);
                console.error(`[MCP] get_ui_hierarchy: auto-targeted iOS device ${iosSim.deviceId}`);
            } else {
                const androidSim = await driver.validateSimulator('android');
                if (androidSim.booted) {
                    await driver.start(androidSim.deviceId);
                    console.error(
                        `[MCP] get_ui_hierarchy: auto-targeted Android device ${androidSim.deviceId}`
                    );
                } else {
                    throw new Error(
                        'No booted iOS or Android simulator found. ' +
                            'Boot a device or pass a sessionId from an active recording.'
                    );
                }
            }
        } else {
            console.error('[MCP] get_ui_hierarchy: reusing warm standalone driver');
        }
    }

    // 2. Dump hierarchy + parse (MCP owns sanitization)
    const rawOutput = await driver.dumpHierarchy();
    let hierarchy = HierarchyParser.parse(rawOutput);

    // 3. Apply interactiveOnly filter
    if (input.interactiveOnly) {
        hierarchy = HierarchyParser.filterInteractive(hierarchy);
        console.error(`[MCP] get_ui_hierarchy: filtered to interactive-only elements`);
    }

    // 4. Apply compact mode
    if (input.compact) {
        hierarchy = HierarchyParser.compact(hierarchy);
        console.error(`[MCP] get_ui_hierarchy: compacted tree`);
    }

    const nodeCount = HierarchyParser.countNodes(hierarchy);

    // 5. Artifact path: write full tree to file, return summary
    if (input.artifactPath) {
        await fs.writeFile(input.artifactPath, JSON.stringify(hierarchy, null, 2), 'utf-8');
        console.error(
            `[MCP] get_ui_hierarchy: wrote ${nodeCount} nodes to ${input.artifactPath}`
        );
        return {
            hierarchy: { role: hierarchy.role, children: [] },
            nodeCount,
            artifactPath: input.artifactPath,
        };
    }

    // 6. Build response — raw output opt-in only
    const result: GetUIHierarchyOutput = { hierarchy, nodeCount };
    if (input.includeRawOutput) {
        result.rawOutput = rawOutput;
    }

    // 7. Diagnostic warning: parsed tree is empty but raw output has data
    if (nodeCount <= 1 && rawOutput.length > 500 && !input.artifactPath) {
        result.diagnostics = [
            'Parsed tree is nearly empty but raw output contains data. ' +
            'The app may be backgrounded, or the hierarchy parser collapsed non-identifiable nodes. ' +
            'Try: includeRawOutput: true, or foreground the app manually.',
        ];
        console.error(
            `[MCP] get_ui_hierarchy: ⚠️ empty parsed tree (${nodeCount} node(s)) but raw output has ${rawOutput.length} chars`,
        );
    }

    return result;
}

// ---- execute_ui_action ----
export async function handleExecuteUIAction(
    input: ExecuteUIActionInput
): Promise<ExecuteUIActionOutput> {
    // inputText is the only action that doesn't take a selector — by design,
    // since the whole point is to type into the already-focused field. Every
    // other action needs SOMETHING to act on.
    if (input.action !== 'inputText' && !input.element) {
        throw new Error(`execute_ui_action: "${input.action}" requires an element. Only "inputText" can omit it.`);
    }

    const element = input.element ?? {};
    const targetDesc =
        element.id
        ?? element.accessibilityLabel
        ?? element.text
        ?? (element.point ? `point(${element.point.x},${element.point.y})` : undefined)
        ?? (input.action === 'inputText' ? '<focused field>' : 'unknown element');
    console.error(`[MCP] execute_ui_action: ${input.action} on "${targetDesc}"`);

    // Get the driver for this session
    const driver = sessionManager.getActiveDriver(input.sessionId);
    if (!driver) {
        throw new Error(`No active driver for session ${input.sessionId}. Was start_recording_session called?`);
    }

    // Retrieve session to check capture mode
    const session = await sessionManager.getSession(input.sessionId);
    const captureMode = session?.captureMode || 'event-triggered';
    const settleTimeoutMs = session?.settleTimeoutMs ?? 3000;

    // ── Pre-action snapshot (event-triggered mode) ──
    let preActionHierarchy: string | undefined;
    if (captureMode === 'event-triggered') {
        try {
            preActionHierarchy = await driver.dumpHierarchy();
            await sessionManager.insertSnapshot({
                sessionId: input.sessionId,
                timestamp: new Date().toISOString(),
                trigger: 'pre-action',
                hierarchyJson: preActionHierarchy,
            });
        } catch (err) {
            console.error('[MCP] execute_ui_action: pre-action snapshot failed (non-fatal)', err);
        }
    }

    // ── Execute the action ──
    // Suppress the poller to prevent double-logging
    sessionManager.suppressNextInference(input.sessionId);

    const dispatchedAt = new Date().toISOString();
    const result = await driver.executeAction(input.action, element, input.textInput);
    const completedAt = new Date().toISOString();

    if (!result.success) {
        throw new Error(`Failed to execute action: ${result.error}`);
    }

    await sessionManager.logInteraction({
        sessionId: input.sessionId,
        timestamp: dispatchedAt,
        dispatchedAt,
        completedAt,
        actionType: input.action,
        element,
        textInput: input.textInput,
        source: 'dispatched',
    });

    // ── Post-settle snapshot + diff (event-triggered mode) ──
    let stateChange: StateChange | undefined;
    if (captureMode === 'event-triggered' && preActionHierarchy) {
        try {
            const { hierarchy: postHierarchy, settleDurationMs } =
                await driver.dumpHierarchyUntilSettled(settleTimeoutMs);

            await sessionManager.insertSnapshot({
                sessionId: input.sessionId,
                timestamp: new Date().toISOString(),
                trigger: 'post-settle',
                hierarchyJson: postHierarchy,
            });

            // Compute the diff
            const { HierarchyDiffer } = await import('./maestro/hierarchy-differ.js');
            const beforeTree = HierarchyParser.parse(preActionHierarchy);
            const afterTree = HierarchyParser.parse(postHierarchy);
            stateChange = HierarchyDiffer.diff(beforeTree, afterTree, undefined, settleDurationMs);

            if (stateChange.elementsAdded.length > 0 || stateChange.elementsRemoved.length > 0) {
                console.error(
                    `[MCP] execute_ui_action: state change detected: +${stateChange.elementsAdded.length} / -${stateChange.elementsRemoved.length} elements (settled in ${settleDurationMs}ms)`
                );
            }
        } catch (err) {
            console.error('[MCP] execute_ui_action: post-settle snapshot failed (non-fatal)', err);
        }
    }

    return {
        success: true,
        message: `Action "${input.action}" successfully dispatched on "${targetDesc}".`,
    };
}

// ---- get_network_logs ----
export async function handleGetNetworkLogs(
    input: GetNetworkLogsInput
): Promise<GetNetworkLogsOutput> {
    console.error(`[MCP] get_network_logs: fetching logs for session ${input.sessionId}`);

    const { merged, scopedProxymanEvents } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
        filterPath: input.filterPath,
    });

    // Also persist Proxyman events to the session DB for future correlation
    await sessionManager.batchLogNetworkEvents(scopedProxymanEvents);

    const limit = input.limit ?? 50;
    const limited = merged.slice(0, limit);

    return {
        events: limited,
        total: limited.length,
    };
}

// ---- verify_sdui_payload ----
export async function handleVerifySDUIPayload(
    input: VerifySDUIPayloadInput
): Promise<VerifySDUIPayloadOutput> {
    console.error(
        `[MCP] verify_sdui_payload: verifying ${input.url} for session ${input.sessionId}`
    );

    // Fall back to session-level filterDomains if not provided in the request
    const session = await sessionManager.getSession(input.sessionId);
    const domains = input.filterDomains ?? session?.filterDomains;
    const actual = await proxymanWrapper.getPayload(input.url, domains);

    if (!actual) {
        return {
            matched: false,
            mismatches: [`No response found in Proxyman traffic for URL: ${input.url}`],
        };
    }

    if (!input.expectedFields || Object.keys(input.expectedFields).length === 0) {
        // No expectations — just return the payload for inspection
        return {
            matched: true,
            actual,
            mismatches: [],
        };
    }

    const result = PayloadValidator.validate(
        actual,
        input.expectedFields as Record<string, unknown>
    );

    return {
        matched: result.matched,
        actual,
        mismatches: result.mismatches,
    };
}

// ──────────────────────────────────────────────
// verify_network_* handlers
// ──────────────────────────────────────────────

interface EventSummary {
    timestamp: string;
    method: string;
    url: string;
    statusCode: number;
    durationMs?: number;
    operationName?: string;
}

function summarize(event: NetworkEvent): EventSummary {
    return {
        timestamp: event.timestamp,
        method: event.method,
        url: event.url,
        statusCode: event.statusCode,
        durationMs: event.durationMs,
        operationName: extractOperationName(event.requestBody),
    };
}

function sortByTimestamp(events: NetworkEvent[]): NetworkEvent[] {
    return [...events].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
}

async function resolveWindow(
    sessionId: string,
    events: NetworkEvent[],
    afterAction: AfterActionRef | undefined,
    withinMs: number | undefined,
): Promise<{ windowed: NetworkEvent[]; anchorTimestamp?: string; anchorError?: string }> {
    if (!afterAction) return { windowed: events };
    const anchor = await resolveAfterAction(sessionId, afterAction);
    if (!anchor) {
        return {
            windowed: [],
            anchorError: `afterAction (${afterAction.kind}=${JSON.stringify(afterAction.value)}) did not match any session interaction`,
        };
    }
    const anchorMs = new Date(anchor.timestamp).getTime();
    const window = withinMs ?? 3000;
    return {
        windowed: eventsInWindow(events, anchorMs, window),
        anchorTimestamp: anchor.timestamp,
    };
}

// ---- verify_network_parallelism ----
export async function handleVerifyNetworkParallelism(
    input: VerifyNetworkParallelismInput,
): Promise<VerifyNetworkParallelismOutput> {
    console.error(`[MCP] verify_network_parallelism: session ${input.sessionId}`);

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });
    const matched = sortByTimestamp(filterEvents(merged, input.matcher));
    const count = matched.length;

    if (count === 0) {
        return {
            passed: false,
            verdict: `No events matched ${describeMatcher(input.matcher)}`,
            count: 0,
            actualSpanMs: 0,
            avgGapMs: 0,
            events: [],
        };
    }

    const firstMs = new Date(matched[0].timestamp).getTime();
    const lastMs = new Date(matched[matched.length - 1].timestamp).getTime();
    const actualSpanMs = lastMs - firstMs;

    let gapSum = 0;
    for (let i = 1; i < matched.length; i++) {
        gapSum += new Date(matched[i].timestamp).getTime() - new Date(matched[i - 1].timestamp).getTime();
    }
    const avgGapMs = matched.length > 1 ? Math.round(gapSum / (matched.length - 1)) : 0;

    const passed = count >= input.minExpectedCount && actualSpanMs <= input.maxWindowMs;
    let verdict: string;
    if (count < input.minExpectedCount) {
        verdict = `Expected ≥${input.minExpectedCount} matching events, got ${count}`;
    } else if (actualSpanMs > input.maxWindowMs) {
        verdict = `${count} events span ${actualSpanMs}ms, exceeds maxWindowMs=${input.maxWindowMs}`;
    } else {
        verdict = `${count} events fired within ${actualSpanMs}ms (≤${input.maxWindowMs})`;
    }

    return {
        passed,
        verdict,
        count,
        actualSpanMs,
        avgGapMs,
        events: matched.map(summarize),
    };
}

// ---- verify_network_on_screen ----
export async function handleVerifyNetworkOnScreen(
    input: VerifyNetworkOnScreenInput,
): Promise<VerifyNetworkOnScreenOutput> {
    console.error(`[MCP] verify_network_on_screen: session ${input.sessionId}`);

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });
    const { windowed, anchorTimestamp, anchorError } = await resolveWindow(
        input.sessionId,
        merged,
        input.afterAction,
        input.withinMs,
    );
    if (anchorError) {
        return {
            passed: false,
            verdict: anchorError,
            matched: [],
            missing: input.expectedCalls.map((m, idx) => ({
                matcher: m as Record<string, unknown>,
                description: `expectedCalls[${idx}]: ${describeMatcher(m)}`,
                matched: false,
            })),
            extras: [],
        };
    }

    const usedIds = new Set<NetworkEvent>();
    const matched: VerifyNetworkOnScreenOutput['matched'] = [];
    const missing: VerifyNetworkOnScreenOutput['missing'] = [];

    input.expectedCalls.forEach((m, idx) => {
        const hit = windowed.find((e) => !usedIds.has(e) && matchEvent(e, m));
        const entry = {
            matcher: m as Record<string, unknown>,
            description: `expectedCalls[${idx}]: ${describeMatcher(m)}`,
            matched: !!hit,
            event: hit ? summarize(hit) : undefined,
        };
        if (hit) {
            usedIds.add(hit);
            matched.push(entry);
        } else {
            missing.push(entry);
        }
    });

    const extras = windowed.filter((e) => !usedIds.has(e)).map(summarize);
    const passed = missing.length === 0;
    const verdict = passed
        ? `All ${input.expectedCalls.length} expected calls observed within ${input.withinMs ?? 3000}ms of anchor`
        : `${missing.length} of ${input.expectedCalls.length} expected calls missing`;

    return { passed, verdict, anchorTimestamp, matched, missing, extras };
}

// ---- verify_network_absent ----
export async function handleVerifyNetworkAbsent(
    input: VerifyNetworkAbsentInput,
): Promise<VerifyNetworkAbsentOutput> {
    console.error(`[MCP] verify_network_absent: session ${input.sessionId}`);

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });
    const { windowed, anchorTimestamp, anchorError } = await resolveWindow(
        input.sessionId,
        merged,
        input.afterAction,
        input.withinMs,
    );
    if (anchorError) {
        return { passed: false, verdict: anchorError, violations: [] };
    }

    const violations: VerifyNetworkAbsentOutput['violations'] = [];
    input.forbiddenCalls.forEach((m, idx) => {
        const hits = windowed.filter((e) => matchEvent(e, m));
        if (hits.length > 0) {
            violations.push({
                matcher: m as Record<string, unknown>,
                description: `forbiddenCalls[${idx}]: ${describeMatcher(m)}`,
                events: hits.map(summarize),
            });
        }
    });

    const passed = violations.length === 0;
    const verdict = passed
        ? `No forbidden calls observed within ${input.withinMs ?? 3000}ms of anchor`
        : `${violations.length} forbidden matcher(s) produced hits`;

    return { passed, verdict, anchorTimestamp, violations };
}

// ---- verify_network_sequence ----
export async function handleVerifyNetworkSequence(
    input: VerifyNetworkSequenceInput,
): Promise<VerifyNetworkSequenceOutput> {
    console.error(`[MCP] verify_network_sequence: session ${input.sessionId}`);

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });
    const { windowed, anchorError } = await resolveWindow(
        input.sessionId,
        merged,
        input.afterAction,
        input.withinMs,
    );
    if (anchorError) {
        return {
            passed: false,
            verdict: anchorError,
            actualOrder: [],
            missing: input.expectedOrder.map((m, idx) => ({
                expectedIndex: idx,
                description: `expectedOrder[${idx}]: ${describeMatcher(m)}`,
            })),
        };
    }

    const scoped = input.matcher ? filterEvents(windowed, input.matcher) : windowed;
    const ordered = sortByTimestamp(scoped);

    const actualOrder: VerifyNetworkSequenceOutput['actualOrder'] = [];
    let cursor = 0;
    let firstDeviationIndex: number | undefined;

    for (const event of ordered) {
        if (cursor >= input.expectedOrder.length) break;

        const current = input.expectedOrder[cursor];
        if (matchEvent(event, current)) {
            actualOrder.push({
                expectedIndex: cursor,
                description: `expectedOrder[${cursor}]: ${describeMatcher(current)}`,
                event: summarize(event),
            });
            cursor++;
            continue;
        }

        // strict: any unmatched event between advances is a deviation
        if (input.strict && firstDeviationIndex === undefined) {
            firstDeviationIndex = cursor;
        }

        // strict: also fail if a later matcher fires out of order
        if (input.strict) {
            for (let j = cursor + 1; j < input.expectedOrder.length; j++) {
                if (matchEvent(event, input.expectedOrder[j])) {
                    if (firstDeviationIndex === undefined) firstDeviationIndex = cursor;
                    break;
                }
            }
        }
    }

    const missing: VerifyNetworkSequenceOutput['missing'] = [];
    for (let i = cursor; i < input.expectedOrder.length; i++) {
        missing.push({
            expectedIndex: i,
            description: `expectedOrder[${i}]: ${describeMatcher(input.expectedOrder[i])}`,
        });
    }

    const allHit = cursor === input.expectedOrder.length;
    const passed = allHit && (!input.strict || firstDeviationIndex === undefined);

    let verdict: string;
    if (!allHit) {
        verdict = `Expected ${input.expectedOrder.length} matchers, only ${cursor} hit in order`;
    } else if (input.strict && firstDeviationIndex !== undefined) {
        verdict = `All matchers hit in order, but strict mode detected out-of-order or intervening events starting at index ${firstDeviationIndex}`;
    } else {
        verdict = `All ${input.expectedOrder.length} matchers hit in order`;
    }

    return {
        passed,
        verdict,
        actualOrder,
        firstDeviationIndex,
        missing: missing.length > 0 ? missing : undefined,
    };
}

// ---- verify_network_performance ----
export async function handleVerifyNetworkPerformance(
    input: VerifyNetworkPerformanceInput,
): Promise<VerifyNetworkPerformanceOutput> {
    console.error(`[MCP] verify_network_performance: session ${input.sessionId}`);

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });
    const { windowed, anchorError } = await resolveWindow(
        input.sessionId,
        merged,
        input.afterAction,
        input.withinMs,
    );
    if (anchorError) {
        return {
            passed: false,
            verdict: anchorError,
            count: 0,
            unknownDurationCount: 0,
            totalMs: 0,
            violators: [],
        };
    }

    const matched = sortByTimestamp(filterEvents(windowed, input.matcher));
    const stats = computeDurationStats(matched.map((e) => e.durationMs));

    let totalMs = 0;
    if (matched.length > 0) {
        const firstStart = new Date(matched[0].timestamp).getTime();
        const lastEvent = matched[matched.length - 1];
        const lastStart = new Date(lastEvent.timestamp).getTime();
        const lastDuration = lastEvent.durationMs ?? 0;
        totalMs = lastStart + lastDuration - firstStart;
    }

    const violators: VerifyNetworkPerformanceOutput['violators'] = [];
    if (input.maxIndividualMs !== undefined) {
        for (const e of matched) {
            if (e.durationMs !== undefined && e.durationMs > input.maxIndividualMs) {
                violators.push({
                    event: summarize(e),
                    reason: `durationMs=${e.durationMs} exceeds maxIndividualMs=${input.maxIndividualMs}`,
                });
            }
        }
    }

    let totalExceeded = false;
    if (input.maxTotalMs !== undefined && totalMs > input.maxTotalMs) {
        totalExceeded = true;
    }

    const passed = matched.length > 0 && violators.length === 0 && !totalExceeded;
    let verdict: string;
    if (matched.length === 0) {
        verdict = `No events matched ${describeMatcher(input.matcher)}`;
    } else if (totalExceeded) {
        verdict = `totalMs=${totalMs} exceeds maxTotalMs=${input.maxTotalMs}`;
    } else if (violators.length > 0) {
        verdict = `${violators.length} of ${matched.length} events exceeded maxIndividualMs`;
    } else {
        verdict = `${matched.length} events; totalMs=${totalMs}, p50=${stats.p50 ?? '—'}, p95=${stats.p95 ?? '—'}`;
    }

    return {
        passed,
        verdict,
        count: stats.count + stats.unknownDurationCount,
        unknownDurationCount: stats.unknownDurationCount,
        totalMs,
        slowestMs: stats.max,
        fastestMs: stats.min,
        p50: stats.p50,
        p95: stats.p95,
        violators,
    };
}

// ---- verify_network_payload ----
export async function handleVerifyNetworkPayload(
    input: VerifyNetworkPayloadInput,
): Promise<VerifyNetworkPayloadOutput> {
    console.error(`[MCP] verify_network_payload: session ${input.sessionId}`);

    if (!input.url && !input.matcher) {
        return {
            passed: false,
            verdict: 'Must supply either `url` or `matcher`',
            mismatches: ['Missing event selector'],
        };
    }

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });

    let target: NetworkEvent | undefined;
    if (input.url) {
        target = merged.find((e) => e.url === input.url) ?? merged.find((e) => e.url.includes(input.url!));
    } else if (input.matcher) {
        target = findFirstMatch(merged, input.matcher);
    }

    if (!target || !target.responseBody) {
        return {
            passed: false,
            verdict: target
                ? 'Matching event has no response body'
                : `No event found for ${input.url ?? describeMatcher(input.matcher!)}`,
            event: target ? summarize(target) : undefined,
            mismatches: [],
        };
    }

    let body: unknown;
    try {
        body = JSON.parse(target.responseBody);
    } catch {
        return {
            passed: false,
            verdict: 'Response body is not valid JSON',
            event: summarize(target),
            mismatches: ['Non-JSON response body'],
        };
    }

    const mismatches: string[] = [];
    for (const assertion of input.responseAssertions) {
        const value = getByPath(body, assertion.path);
        const exists = existsAtPath(body, assertion.path);

        if (assertion.exists !== undefined) {
            if (assertion.exists && !exists) {
                mismatches.push(`${assertion.path}: expected to exist but was missing`);
                continue;
            }
            if (!assertion.exists && exists) {
                mismatches.push(`${assertion.path}: expected to be absent but was present`);
                continue;
            }
        }

        // If we're only asserting existence=false and that was satisfied, skip the rest.
        if (assertion.exists === false) continue;

        if (!exists && (assertion.equals !== undefined || assertion.contains || assertion.type || assertion.minLength !== undefined)) {
            mismatches.push(`${assertion.path}: path did not resolve`);
            continue;
        }

        if (assertion.type) {
            const actualType = value === null
                ? 'null'
                : Array.isArray(value)
                    ? 'array'
                    : typeof value;
            if (actualType !== assertion.type) {
                mismatches.push(`${assertion.path}: expected type ${assertion.type}, got ${actualType}`);
                continue;
            }
        }

        if (assertion.equals !== undefined) {
            if (JSON.stringify(value) !== JSON.stringify(assertion.equals)) {
                mismatches.push(
                    `${assertion.path}: expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(value)}`,
                );
            }
        }

        if (assertion.contains !== undefined) {
            const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
            if (!s.includes(assertion.contains)) {
                mismatches.push(`${assertion.path}: does not contain "${assertion.contains}"`);
            }
        }

        if (assertion.minLength !== undefined) {
            const len = Array.isArray(value) || typeof value === 'string' ? value.length : -1;
            if (len < assertion.minLength) {
                mismatches.push(
                    `${assertion.path}: length ${len} < minLength ${assertion.minLength}`,
                );
            }
        }
    }

    const passed = mismatches.length === 0;
    return {
        passed,
        verdict: passed
            ? `All ${input.responseAssertions.length} assertion(s) passed`
            : `${mismatches.length} of ${input.responseAssertions.length} assertion(s) failed`,
        event: summarize(target),
        mismatches,
    };
}

// ---- verify_network_deduplication ----
export async function handleVerifyNetworkDeduplication(
    input: VerifyNetworkDeduplicationInput,
): Promise<VerifyNetworkDeduplicationOutput> {
    console.error(`[MCP] verify_network_deduplication: session ${input.sessionId}`);

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });
    const { windowed, anchorError } = await resolveWindow(
        input.sessionId,
        merged,
        input.afterAction,
        input.withinMs,
    );
    if (anchorError) {
        return { passed: false, verdict: anchorError, duplicates: [] };
    }

    const scoped = input.matcher ? filterEvents(windowed, input.matcher) : windowed;

    const groups = new Map<string, string[]>();
    for (const event of scoped) {
        let key: string | undefined;
        if (input.groupBy === 'operationName') {
            key = extractOperationName(event.requestBody) ?? event.url;
        } else {
            key = event.url;
        }
        if (!key) continue;
        const list = groups.get(key) ?? [];
        list.push(event.timestamp);
        groups.set(key, list);
    }

    const duplicates: VerifyNetworkDeduplicationOutput['duplicates'] = [];
    for (const [key, timestamps] of groups) {
        if (timestamps.length > input.maxDuplicates) {
            duplicates.push({ key, count: timestamps.length, timestamps });
        }
    }

    const passed = duplicates.length === 0;
    const verdict = passed
        ? `No duplicates beyond maxDuplicates=${input.maxDuplicates}`
        : `${duplicates.length} key(s) exceeded maxDuplicates=${input.maxDuplicates}`;

    return { passed, verdict, duplicates };
}

// ---- verify_network_error_handling ----
export async function handleVerifyNetworkErrorHandling(
    input: VerifyNetworkErrorHandlingInput,
): Promise<VerifyNetworkErrorHandlingOutput> {
    console.error(`[MCP] verify_network_error_handling: session ${input.sessionId}`);

    const { merged } = await getMergedEvents(input.sessionId, {
        filterDomains: input.filterDomains,
    });
    const { windowed, anchorError } = await resolveWindow(
        input.sessionId,
        merged,
        input.afterAction,
        input.withinMs,
    );
    if (anchorError) {
        return {
            passed: false,
            verdict: anchorError,
            errorsFound: [],
            missingErrors: input.expectedErrors.map((m, idx) => ({
                expectedIndex: idx,
                description: `expectedErrors[${idx}]: ${describeMatcher(m)}`,
            })),
        };
    }

    const errorsFound: VerifyNetworkErrorHandlingOutput['errorsFound'] = [];
    const missingErrors: VerifyNetworkErrorHandlingOutput['missingErrors'] = [];

    input.expectedErrors.forEach((m, idx) => {
        const hit = findFirstMatch(windowed, m);
        if (hit) {
            errorsFound.push({
                expectedIndex: idx,
                description: `expectedErrors[${idx}]: ${describeMatcher(m)}`,
                event: summarize(hit),
            });
        } else {
            missingErrors.push({
                expectedIndex: idx,
                description: `expectedErrors[${idx}]: ${describeMatcher(m)}`,
            });
        }
    });

    const passed = missingErrors.length === 0;
    const verdict = passed
        ? `All ${input.expectedErrors.length} expected error(s) observed`
        : `${missingErrors.length} of ${input.expectedErrors.length} expected error(s) missing`;

    return { passed, verdict, errorsFound, missingErrors };
}

// ---- register_segment ----
export async function handleRegisterSegment(
    input: RegisterSegmentInput
): Promise<RegisterSegmentOutput> {
    console.error(`[MCP] register_segment: registering segment "${input.name}" from session ${input.sessionId}`);

    // Get session data
    const session = await sessionManager.getSession(input.sessionId);
    if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
    }

    // Fetch interactions and network events to compute fingerprint
    const interactions = await sessionManager.getInteractions(input.sessionId);
    const networkEvents = await sessionManager.getNetworkEvents(input.sessionId);

    const correlator = new Correlator();
    const steps = correlator.correlate(interactions, networkEvents);

    if (steps.length === 0) {
        throw new Error(`Session ${input.sessionId} has no correlated steps to register as a segment.`);
    }

    const fingerprint = SegmentFingerprint.compute(steps);
    const registryPath = input.registryPath ?? path.join(process.cwd(), 'segments', 'registry.json');

    // Load, add, and save
    let entries = await SegmentRegistry.load(registryPath);
    entries = SegmentRegistry.addEntry(entries, {
        name: input.name,
        fingerprint,
        yamlPath: `segments/${input.name}.segment.yaml`,
        createdAt: new Date().toISOString(),
        createdBy: input.sessionId,
        sequencePreview: SegmentFingerprint.sequenceString(steps),
    });
    await SegmentRegistry.save(registryPath, entries);

    console.error(`[MCP] register_segment: registered "${input.name}" with fingerprint ${fingerprint}`);

    return {
        name: input.name,
        fingerprint,
        registryPath,
        message: `Segment "${input.name}" registered with fingerprint ${fingerprint}. ${entries.length} segment(s) in registry.`,
    };
}

/**
 * Phase 4: bracket a flow run with pause/resume of an active recording
 * session, behind MCA_FLOW_PAUSE_RESUME.
 *
 * When the flag is OFF (default): falls through to the legacy
 * assertNoActiveSessions hard-error guard — preserves Phase 1 behavior.
 *
 * When the flag is ON and exactly one session is active: pauses the
 * session, runs the flow with a propagated AbortSignal so cancel_task can
 * SIGTERM the maestro test subprocess, then resumes. Resume runs on both
 * success and error paths via a single doResume() helper so failure
 * handling is identical. runHandler's cleanup stack guarantees resume
 * even on uncaught throws or watchdog timeout.
 */
async function executeFlowWithPause<T>(
    flowName: string,
    runFlow: (signal: AbortSignal) => Promise<{ result: T; output: string; succeeded: boolean }>,
): Promise<T> {
    if (!_flowPauseResumeEnabled) {
        assertNoActiveSessions(sessionManager.listActiveDrivers(), flowName);
        const { result } = await runFlow(new AbortController().signal);
        return result;
    }

    const active = sessionManager.listActiveDrivers();
    if (active.length === 0) {
        const { result } = await runFlow(new AbortController().signal);
        return result;
    }
    if (active.length > 1) {
        throw new Error(
            `Cannot run flow "${flowName}" with ${active.length} active sessions; ` +
                `multi-session flow execution is not supported. Use force_cleanup_session ` +
                `to stop the unwanted session(s) first.`,
        );
    }
    const sessionId = active[0];

    return runHandler(
        { name: `flow_with_pause(${flowName})`, timeoutMs: PAUSE_RESUME_WATCHDOG_MS },
        async (cleanup) => {
            const session = await sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session disappeared: ${sessionId}`);
            }
            if (!session.deviceId) {
                throw new Error(
                    `Session ${sessionId} has no recorded deviceId — cannot resume after flow.`,
                );
            }

            const { pausedAt } = await sessionManager.pauseSession(sessionId, flowName);

            // Single resume helper used by both success and error paths so
            // failure handling is identical (markAborted is called inside
            // resumeSession on its own error path).
            let resumed = false;
            const flowResult = { output: '', succeeded: false };
            const doResume = async (): Promise<void> => {
                if (resumed) return;
                resumed = true;
                await sessionManager.resumeSession(
                    sessionId,
                    session.deviceId!,
                    session.platform,
                    session.appBundleId,
                    flowName,
                    flowResult.output,
                    flowResult.succeeded,
                    pausedAt,
                );
            };
            cleanup.add('resume session', doResume);

            const { result, output, succeeded } = await runFlow(cleanup.signal);
            flowResult.output = output;
            flowResult.succeeded = succeeded;
            // Success path: invoke resume manually and clear the cleanup
            // entry so we don't double-resume. (cleanup.runAll only runs on
            // throw/abort/timeout — see cleanup.ts.)
            cleanup.forget('resume session');
            await doResume();
            return result;
        },
    );
}

// ---- run_test ----
export async function handleRunTest(
    input: RunTestInput
): Promise<RunTestOutput> {
    console.error(`[MCP] run_test: running ${input.yamlPath}`);

    return executeFlowWithPause(
        input.yamlPath,
        async (signal) => {
            const out = await runTestCore(input, signal);
            return {
                result: out,
                output: out.output,
                succeeded: out.passed,
            };
        },
    );
}

/**
 * Inner body of run_test, factored out so executeFlowWithPause can wrap it.
 * Receives the AbortSignal that propagates from cleanup.signal — passed all
 * the way down to MaestroWrapper.runTest so cancel_task (or watchdog
 * timeout) can SIGTERM the flow subprocess.
 */
async function runTestCore(input: RunTestInput, signal: AbortSignal): Promise<RunTestOutput> {
    // Create a CLI-only driver for test execution (no daemon needed). Forward
    // driverCooldownMs so callers can tune the port-7001 TIME_WAIT drain when
    // the health probe misses and we fall back to uninstall.
    const driverTimeouts = input.driverCooldownMs !== undefined
        ? { driverCooldownMs: input.driverCooldownMs }
        : undefined;
    const driver = await DriverFactory.createCliOnly(driverTimeouts);

    // Validate simulator + clean stale driver
    const platform = input.platform ?? 'ios';
    const validation = await driver.validateSimulator(platform);
    if (!validation.booted) {
        throw new Error(`No booted ${platform} simulator found. Please boot a device first.`);
    }
    await driver.ensureCleanDriverState(platform, validation.deviceId);

    let stubServer: StubServer | undefined;
    let stubServerPort: number | undefined;
    let profiler: ProfilingDriver | undefined;
    let profilingMetrics: ProfilingMetrics | undefined;

    try {
        // Step 1: Start stub server if stubs are provided
        if (input.stubsDir) {
            stubServer = new StubServer();
            await stubServer.loadStubs(input.stubsDir);
            stubServerPort = await stubServer.start(input.stubServerPort ?? 0);
            console.error(`[MCP] run_test: stub server started on port ${stubServerPort}`);
        }

        // Step 2: Start profiling if requested (non-fatal on failure)
        if (input.profiling && validation.deviceId) {
            try {
                const { createProfiler } = await import('./profiling/index.js');
                profiler = createProfiler(platform, input.profiling.template);
                // Resolve app bundle ID: prefer env var, then parse from YAML front-matter
                let appId = input.env?.APP_ID ?? '';
                if (!appId) {
                    try {
                        const yamlContent = await fs.readFile(input.yamlPath, 'utf-8');
                        const appIdMatch = yamlContent.match(/^appId:\s*(.+)$/m);
                        if (appIdMatch) {
                            appId = appIdMatch[1].trim();
                        }
                    } catch {
                        // Best-effort — YAML read failure is non-fatal
                    }
                }
                if (!appId) {
                    throw new Error(
                        'Cannot start profiling: app bundle ID is required. ' +
                        'Set env.APP_ID or include appId in the YAML front-matter.',
                    );
                }
                await profiler.start(validation.deviceId, appId, input.profiling);
                console.error(`[MCP] run_test: profiling started (template: ${input.profiling.template})`);
            } catch (err) {
                console.error('[MCP] run_test: profiling failed to start (non-fatal):', err);
                profiler = undefined;
            }
        }

        // Step 3: Run Maestro test (signal propagates from
        // executeFlowWithPause's cleanup.signal so cancel_task can interrupt
        // the maestro test subprocess via SIGTERM)
        const result = await driver.runTest(input.yamlPath, input.env, input.debugOutput, signal);

        // Step 4: Stop profiling and collect metrics (non-fatal on failure)
        if (profiler?.isActive) {
            try {
                profilingMetrics = await profiler.stop();
                const cpuStr = profilingMetrics.cpuUsagePercent ?? profilingMetrics.launchTimeMs
                    ? `CPU: ${profilingMetrics.cpuUsagePercent ?? 'N/A'}%`
                    : `Launch: ${profilingMetrics.launchTimeMs ?? 'N/A'}ms`;
                console.error(
                    `[MCP] run_test: profiling complete — ${cpuStr}, ` +
                    `Memory: ${profilingMetrics.memoryFootprintMb ?? profilingMetrics.peakMemoryMb ?? 'N/A'} MB, ` +
                    `Duration: ${profilingMetrics.profilingDurationMs}ms` +
                    (profilingMetrics.sampleCount !== undefined ? `, Samples: ${profilingMetrics.sampleCount}` : '')
                );
            } catch (err) {
                console.error('[MCP] run_test: profiling failed to stop (non-fatal):', err);
            }
        } else if (profiler && !profiler.isActive && input.profiling?.template === 'app-launch') {
            // App-launch profiler completes during start() — stop() returns cached metrics
            try {
                profilingMetrics = await profiler.stop();
                console.error(
                    `[MCP] run_test: app-launch profiling complete — ` +
                    `Launch: ${profilingMetrics.launchTimeMs ?? 'N/A'}ms`
                );
            } catch (err) {
                console.error('[MCP] run_test: app-launch profiling failed to stop (non-fatal):', err);
            }
        }

        return {
            passed: result.passed,
            output: result.output,
            stubServerPort,
            durationMs: result.durationMs,
            profiling: profilingMetrics,
        };
    } finally {
        // Step 5: Tear down stub server
        if (stubServer) {
            await stubServer.stop();
            console.error('[MCP] run_test: stub server stopped');
        }
        // Step 6: Ensure profiler is stopped on error paths
        if (profiler?.isActive) {
            try {
                await profiler.stop();
            } catch {
                // Best-effort cleanup
            }
        }
    }
}

// ---- list_devices ----

/** Shape of each device in the xcrun simctl JSON output */
interface SimctlDevice {
    udid: string;
    name: string;
    state: string;
    isAvailable: boolean;
}

/** Extract a human-readable OS version from a CoreSimulator runtime identifier */
function runtimeToOsVersion(runtime: string): string {
    // "com.apple.CoreSimulator.SimRuntime.iOS-18-1" → "iOS 18.1"
    return runtime
        .replace('com.apple.CoreSimulator.SimRuntime.', '')
        .replace(/-/g, ' ')
        .replace(/(\w+)\s(\d+)\s(\d+)/, '$1 $2.$3');
}

export async function handleListDevices(
    input: ListDevicesInput
): Promise<ListDevicesOutput> {
    console.error(`[MCP] list_devices: platform=${input.platform ?? 'all'}, state=${input.state ?? 'all'}`);

    const devices: ListDevicesOutput['devices'] = [];

    // ── iOS: xcrun simctl list devices -j ──
    if (!input.platform || input.platform === 'ios') {
        try {
            const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j']);
            const data = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };

            for (const runtime in data.devices) {
                const osVersion = runtimeToOsVersion(runtime);

                // Apply OS version filter
                if (input.osVersionContains && !osVersion.includes(input.osVersionContains)) {
                    continue;
                }

                for (const device of data.devices[runtime]) {
                    // Skip unavailable runtimes (old Xcode installs, etc.)
                    if (!device.isAvailable) continue;

                    // Apply state filter
                    if (input.state && device.state !== input.state) continue;

                    devices.push({
                        platform: 'ios',
                        udid: device.udid,
                        name: device.name,
                        state: device.state,
                        osVersion,
                        isAvailable: device.isAvailable,
                    });
                }
            }
        } catch (error) {
            console.error('[MCP] list_devices: xcrun simctl failed:', error);
            // Non-fatal — still try Android if requested
        }
    }

    // ── Android: adb devices ──
    if (!input.platform || input.platform === 'android') {
        try {
            const { stdout } = await execFileAsync('adb', ['devices']);
            const lines = stdout.split('\n');
            for (const line of lines.slice(1)) {
                if (line.includes('\tdevice')) {
                    const deviceId = line.split('\t')[0];
                    // adb only shows connected (booted) devices
                    if (input.state && input.state !== 'Booted') continue;

                    devices.push({
                        platform: 'android',
                        udid: deviceId,
                        name: deviceId, // adb doesn't provide device name inline
                        state: 'Booted',
                    });
                }
            }
        } catch (error) {
            console.error('[MCP] list_devices: adb failed (Android SDK may not be installed):', error);
            // Non-fatal
        }
    }

    console.error(`[MCP] list_devices: found ${devices.length} device(s)`);
    return { devices, total: devices.length };
}

// ---- get_session_timeline ----
export async function handleGetSessionTimeline(
    input: GetSessionTimelineInput
): Promise<GetSessionTimelineOutput> {
    console.error(`[MCP] get_session_timeline: checking timeline for session ${input.sessionId}`);

    const session = await sessionManager.getSession(input.sessionId);
    if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
    }

    // Get poll records from the active inferrer
    const pollRecords = sessionManager.getPollRecords(input.sessionId);

    // Get interactions from the DB
    const interactions = await sessionManager.getInteractions(input.sessionId);

    // Compute poll summary
    const byResult: Record<string, number> = {};
    for (const r of pollRecords) {
        byResult[r.result] = (byResult[r.result] ?? 0) + 1;
    }

    // Compute interaction summary
    const bySource: Record<string, number> = {};
    for (const i of interactions) {
        const src = i.source ?? 'dispatched';
        bySource[src] = (bySource[src] ?? 0) + 1;
    }

    // Detect gaps (same logic as TimelineBuilder)
    const configuredIntervalMs = session.pollingIntervalMs ?? 500;
    const threshold = configuredIntervalMs * 2;
    const gaps: GetSessionTimelineOutput['gaps'] = [];
    let starvationPeriods = 0;

    for (let i = 1; i < pollRecords.length; i++) {
        const prevTime = new Date(pollRecords[i - 1].timestamp).getTime();
        const currTime = new Date(pollRecords[i].timestamp).getTime();
        const delta = currTime - prevTime;

        if (delta > threshold) {
            starvationPeriods++;
            const prevRecord = pollRecords[i - 1];
            let reason = 'poll_starvation';
            if (prevRecord.result === 'error') reason = 'poll_errors';
            else if (prevRecord.durationMs <= configuredIntervalMs) reason = 'no_polls';

            gaps.push({
                from: pollRecords[i - 1].timestamp,
                to: pollRecords[i].timestamp,
                durationMs: delta,
                reason,
            });
        }
    }

    // Compute actual average
    let actualAverageMs: number | undefined;
    if (pollRecords.length >= 2) {
        const first = new Date(pollRecords[0].timestamp).getTime();
        const last = new Date(pollRecords[pollRecords.length - 1].timestamp).getTime();
        actualAverageMs = Math.round((last - first) / (pollRecords.length - 1));
    }

    // Elapsed time
    const elapsedMs = Date.now() - new Date(session.startedAt).getTime();

    // Recent polls (last 10)
    const recentPolls = pollRecords.slice(-10).map((r) => ({
        timestamp: r.timestamp,
        durationMs: r.durationMs,
        result: r.result,
        inferredTarget: r.inferredTarget,
    }));

    return {
        sessionId: input.sessionId,
        status: session.status,
        elapsedMs,
        pollSummary: {
            totalPolls: pollRecords.length,
            byResult,
            starvationPeriods,
            configuredIntervalMs,
            actualAverageMs,
        },
        interactionSummary: {
            total: interactions.length,
            bySource,
        },
        gaps,
        recentPolls,
    };
}

// ---- list_flows & run_flow ----

function resolveFlowsDir(flowsDir: string | undefined): string {
    return flowsDir ?? path.join(process.cwd(), 'flows');
}

export async function handleListFlows(input: ListFlowsInput): Promise<ListFlowsOutput> {
    const flowsDir = resolveFlowsDir(input.flowsDir);
    console.error(`[MCP] list_flows: scanning ${flowsDir}`);

    try {
        const flows = await FlowRegistry.list(flowsDir);
        console.error(`[MCP] list_flows: found ${flows.length} flow(s)`);
        return { flows, flowsDir, total: flows.length };
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            throw new Error(
                `Flows directory not found: ${flowsDir}. ` +
                `Create it and add <name>.yaml files, or pass a different flowsDir.`,
            );
        }
        throw err;
    }
}

export async function handleRunFlow(input: RunFlowInput): Promise<RunFlowOutput> {
    const flowsDir = resolveFlowsDir(input.flowsDir);
    console.error(`[MCP] run_flow: resolving "${input.name}" in ${flowsDir}`);

    const flow = await FlowRegistry.resolve(flowsDir, input.name);
    const appliedParams = FlowRegistry.applyParams(flow, input.params);

    console.error(
        `[MCP] run_flow: executing ${flow.path} with ${Object.keys(appliedParams).length} param(s)`,
    );

    // Route through executeFlowWithPause directly (rather than handleRunTest)
    // so the flow name is meaningful in the pause/resume marker and the
    // active-session guard, and so we don't double-bracket the cycle.
    const result = await executeFlowWithPause(
        flow.name,
        async (signal) => {
            const out = await runTestCore(
                {
                    yamlPath: flow.path,
                    env: appliedParams,
                    debugOutput: input.debugOutput,
                    stubsDir: input.stubsDir,
                    stubServerPort: input.stubServerPort,
                    platform: input.platform,
                    driverCooldownMs: input.driverCooldownMs,
                },
                signal,
            );
            return {
                result: out,
                output: out.output,
                succeeded: out.passed,
            };
        },
    );

    return {
        passed: result.passed,
        flowName: flow.name,
        flowPath: flow.path,
        appliedParams,
        output: result.output,
        stubServerPort: result.stubServerPort,
        durationMs: result.durationMs,
    };
}

// ---- build_app ----
/**
 * Synchronous build entry point — kept for backwards compatibility but now
 * delegates to TaskRegistry so sync and async (start_build) builds share one
 * code path. On registry.run we await the terminal state and re-throw for
 * failure/cancellation; success returns the structured BuildAppOutput.
 */
export async function handleBuildApp(input: BuildAppInput): Promise<BuildAppOutput> {
    console.error(`[MCP] build_app: platform=${input.platform}`);
    const innerTimeout = input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const watchdogMs = innerTimeout + OUTER_BUILD_GRACE_MS;
    const task = await taskRegistry.run<BuildAppOutput>(
        { kind: 'build', timeoutMs: watchdogMs },
        (ctx) => runBuildTask(input, ctx.signal, (line, stream) => ctx.appendLine(line, stream)),
    );
    if (task.status === 'done' && task.result) return task.result;
    if (task.status === 'cancelled') throw new Error(`build cancelled: ${task.error ?? 'aborted'}`);
    throw new Error(task.error || 'build failed');
}

/** Shared between handleBuildApp and handleStartBuild. */
async function runBuildTask(
    input: BuildAppInput,
    signal: AbortSignal,
    onLine: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<BuildAppOutput> {
    if (input.platform === 'ios') {
        if (!input.scheme) {
            throw new Error('iOS build requires "scheme"');
        }
        if (!input.workspacePath && !input.projectPath) {
            throw new Error('iOS build requires "workspacePath" or "projectPath"');
        }
        const result = await buildIosApp({
            workspacePath: input.workspacePath,
            projectPath: input.projectPath,
            scheme: input.scheme,
            configuration: input.configuration,
            destination: input.destination,
            derivedDataPath: input.derivedDataPath,
            timeoutMs: input.timeoutMs,
            signal,
            onLine,
        });
        return {
            passed: result.passed,
            platform: 'ios' as const,
            appPath: result.appPath,
            bundleId: result.bundleId,
            derivedDataPath: result.derivedDataPath,
            durationMs: result.durationMs,
            output: result.output,
        };
    }
    if (!input.projectPath) {
        throw new Error('Android build requires "projectPath" (Gradle project root)');
    }
    const result = await buildAndroidApp({
        projectPath: input.projectPath,
        module: input.module,
        variant: input.variant,
        timeoutMs: input.timeoutMs,
        signal,
        onLine,
    });
    return {
        passed: result.passed,
        platform: 'android' as const,
        appPath: result.apkPath,
        module: result.module,
        variant: result.variant,
        durationMs: result.durationMs,
        output: result.output,
    };
}

// ---- start_build / poll_task_status / get_task_result / cancel_task / list_tasks ----

/**
 * Schedule a build asynchronously. Returns a taskId immediately so the agent
 * can poll for status via poll_task_status without hitting the MCP transport
 * timeout (~5min). Tasks live in-process; server restart cancels in-flight
 * builds and forgets completed ones.
 */
export async function handleStartBuild(input: StartBuildInput): Promise<StartBuildOutput> {
    console.error(`[MCP] start_build: platform=${input.platform}`);
    const innerTimeout = input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const watchdogMs = innerTimeout + OUTER_BUILD_GRACE_MS;
    const task = taskRegistry.start<BuildAppOutput>(
        { kind: 'build', timeoutMs: watchdogMs },
        (ctx) => runBuildTask(input, ctx.signal, (line, stream) => ctx.appendLine(line, stream)),
    );
    return {
        taskId: task.taskId,
        kind: 'build',
        status: task.status,
        startedAt: task.startedAt,
    };
}

/**
 * Returns current status, duration, recent output for a task. Cheap; callable
 * frequently. Never throws — unknown/pruned task IDs return notFound:true so
 * agents can distinguish "task expired" from a network error.
 */
export async function handlePollTaskStatus(
    input: PollTaskStatusInput,
): Promise<PollTaskStatusOutput> {
    const task = taskRegistry.get(input.taskId);
    if (!task) {
        return {
            taskId: input.taskId,
            status: 'failed',
            durationMs: 0,
            recentOutputLines: [],
            lineCount: 0,
            notFound: true,
        };
    }
    return {
        taskId: task.taskId,
        kind: task.kind,
        status: task.status,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        durationMs: task.durationMs(),
        recentOutputLines: task.recentOutputLines(input.tailLines),
        lineCount: task.lineCount(),
        error: task.error,
        cancelReason: task.cancelReason,
    };
}

/**
 * Returns the structured result of a completed task. Idempotent — multiple
 * calls return the same payload until the task is pruned. Returns notFound /
 * not-yet-done errors instead of throwing.
 */
export async function handleGetTaskResult(
    input: GetTaskResultInput,
): Promise<GetTaskResultOutput> {
    const task = taskRegistry.get<BuildAppOutput>(input.taskId);
    if (!task) {
        return {
            taskId: input.taskId,
            status: 'failed',
            notFound: true,
            error: 'Task not found or pruned',
        };
    }
    if (task.status === 'running' || task.status === 'pending') {
        return {
            taskId: task.taskId,
            status: task.status,
            error: 'Task not yet complete',
        };
    }
    if (task.status !== 'done' || !task.result) {
        return {
            taskId: task.taskId,
            status: task.status,
            error: task.error,
            cancelReason: task.cancelReason,
        };
    }
    if (task.kind === 'build') {
        return {
            taskId: task.taskId,
            status: task.status,
            result: { kind: 'build', build: task.result },
        };
    }
    // Other kinds (unit_tests etc) aren't wired into the discriminated union yet.
    return {
        taskId: task.taskId,
        status: task.status,
        error: `result projection not implemented for kind=${task.kind}`,
    };
}

/**
 * Aborts a running task (SIGTERM children, run cleanups, mark cancelled).
 * Idempotent and never throws — terminal/unknown returns cancelled:false with
 * a structured reason.
 */
export async function handleCancelTask(input: CancelTaskInput): Promise<CancelTaskOutput> {
    const task = taskRegistry.get(input.taskId);
    if (!task) {
        return { taskId: input.taskId, cancelled: false, notFound: true };
    }
    const previousStatus = task.status;
    if (previousStatus !== 'running' && previousStatus !== 'pending') {
        return {
            taskId: task.taskId,
            cancelled: false,
            previousStatus,
            finalStatus: previousStatus,
        };
    }
    taskRegistry.cancel(task.taskId, input.reason);
    // Wait briefly for the runner to settle into a terminal state. If the
    // runner ignores SIGTERM and we exhaust the deadline, the task remains
    // in the transient 'cancelling' status — which we return honestly rather
    // than lying with finalStatus='running'.
    const deadline = Date.now() + CANCEL_DEADLINE_MS;
    while (
        task.status !== 'done' &&
        task.status !== 'failed' &&
        task.status !== 'cancelled' &&
        Date.now() < deadline
    ) {
        await new Promise((r) => setTimeout(r, 25));
    }
    return {
        taskId: task.taskId,
        cancelled: true,
        previousStatus,
        finalStatus: task.status,
        cancelReason: task.cancelReason,
    };
}

/**
 * Lists tasks, optionally filtered by kind/status/since. Useful for orphan
 * recovery alongside list_active_sessions.
 */
export async function handleListTasks(input: ListTasksInput): Promise<ListTasksOutput> {
    const tasks = taskRegistry.list({
        kind: input.kind as TaskKind | undefined,
        status: input.status as TaskStatus | TaskStatus[] | undefined,
        since: input.since,
    });
    return {
        tasks: tasks.map((t) => ({
            taskId: t.taskId,
            kind: t.kind,
            status: t.status,
            startedAt: t.startedAt,
            finishedAt: t.finishedAt,
            durationMs: t.durationMs(),
            lineCount: t.lineCount(),
        })),
        totalTasks: tasks.length,
    };
}

// ---- install_app ----
export async function handleInstallApp(input: InstallAppInput): Promise<InstallAppOutput> {
    console.error(
        `[MCP] install_app: platform=${input.platform}, device=${input.deviceUdid}, app=${input.appPath}`,
    );

    if (input.platform === 'ios') {
        const result = await installIosApp({
            deviceUdid: input.deviceUdid,
            appPath: input.appPath,
        });
        return {
            passed: result.passed,
            platform: 'ios',
            deviceUdid: input.deviceUdid,
            bundleId: result.bundleId,
            durationMs: result.durationMs,
            output: result.output,
        };
    }

    const result = await installAndroidApp({
        deviceUdid: input.deviceUdid,
        apkPath: input.appPath,
    });
    return {
        passed: result.passed,
        platform: 'android',
        deviceUdid: input.deviceUdid,
        durationMs: result.durationMs,
        output: result.output,
    };
}

// ---- uninstall_app ----
export async function handleUninstallApp(
    input: UninstallAppInput,
): Promise<UninstallAppOutput> {
    console.error(
        `[MCP] uninstall_app: platform=${input.platform}, device=${input.deviceUdid}, bundleId=${input.bundleId}`,
    );

    if (input.platform === 'ios') {
        const result = await uninstallIosApp({
            deviceUdid: input.deviceUdid,
            bundleId: input.bundleId,
        });
        return {
            passed: result.passed,
            platform: 'ios',
            deviceUdid: input.deviceUdid,
            bundleId: input.bundleId,
            durationMs: result.durationMs,
            output: result.output,
        };
    }

    const result = await uninstallAndroidApp({
        deviceUdid: input.deviceUdid,
        packageName: input.bundleId,
    });
    return {
        passed: result.passed,
        platform: 'android',
        deviceUdid: input.deviceUdid,
        bundleId: input.bundleId,
        durationMs: result.durationMs,
        output: result.output,
    };
}

// ---- boot_simulator ----
export async function handleBootSimulator(
    input: BootSimulatorInput,
): Promise<BootSimulatorOutput> {
    console.error(
        `[MCP] boot_simulator: platform=${input.platform}, device=${input.deviceUdid}`,
    );

    if (input.platform === 'android') {
        throw new Error(
            'Android emulator booting is not yet supported. ' +
            'Start your emulator manually (e.g., `emulator -avd <name>`), then continue.',
        );
    }

    const result = await bootIosSimulator({
        deviceUdid: input.deviceUdid,
        openSimulatorApp: input.openSimulatorApp,
        timeoutMs: input.timeoutMs,
    });
    return {
        passed: result.passed,
        platform: 'ios',
        deviceUdid: result.deviceUdid,
        state: result.state,
        alreadyBooted: result.alreadyBooted,
        durationMs: result.durationMs,
        output: result.output,
    };
}

// ---- take_screenshot ----
export async function handleTakeScreenshot(
    input: TakeScreenshotInput,
): Promise<TakeScreenshotOutput> {
    console.error(
        `[MCP] take_screenshot: platform=${input.platform}, device=${input.deviceUdid}`,
    );

    const capture = input.platform === 'ios' ? takeIosScreenshot : takeAndroidScreenshot;
    const result = await capture({
        deviceUdid: input.deviceUdid,
        outputPath: input.outputPath,
        timeoutMs: input.timeoutMs,
    });

    return {
        passed: result.passed,
        platform: input.platform,
        deviceUdid: input.deviceUdid,
        imagePath: result.imagePath,
        sizeBytes: result.sizeBytes,
        durationMs: result.durationMs,
        output: result.output,
    };
}

// ---- run_unit_tests ----
export async function handleRunUnitTests(
    input: RunUnitTestsInput,
): Promise<RunUnitTestsOutput> {
    console.error(`[MCP] run_unit_tests: platform=${input.platform}`);

    if (input.platform === 'ios') {
        if (!input.scheme) {
            throw new Error('iOS unit tests require "scheme"');
        }
        if (!input.workspacePath && !input.projectPath) {
            throw new Error('iOS unit tests require "workspacePath" or "projectPath"');
        }
        const result = await runIosUnitTests({
            workspacePath: input.workspacePath,
            projectPath: input.projectPath,
            scheme: input.scheme,
            destination: input.destination,
            configuration: input.configuration,
            testPlan: input.testPlan,
            onlyTesting: input.onlyTesting,
            timeoutMs: input.timeoutMs,
        });
        return {
            passed: result.passed,
            platform: 'ios',
            totalTests: result.totalTests,
            passedTests: result.passedTests,
            failedTests: result.failedTests,
            skippedTests: result.skippedTests,
            failures: result.failures,
            durationMs: result.durationMs,
            resultBundlePath: result.resultBundlePath,
            output: result.output,
        };
    }

    if (!input.projectPath) {
        throw new Error('Android unit tests require "projectPath" (Gradle project root)');
    }
    const result = await runAndroidUnitTests({
        projectPath: input.projectPath,
        module: input.module,
        variant: input.variant,
        gradleTask: input.gradleTask,
        testFilter: input.testFilter,
        timeoutMs: input.timeoutMs,
    });
    return {
        passed: result.passed,
        platform: 'android',
        totalTests: result.totalTests,
        passedTests: result.passedTests,
        failedTests: result.failedTests,
        skippedTests: result.skippedTests,
        failures: result.failures,
        durationMs: result.durationMs,
        reportDir: result.reportDir,
        output: result.output,
    };
}

// ── Internal: runner-driven mock install (no session required) ─────────────
//
// Used by run_feature_test to install spec.mocks BEFORE setup flows fire any
// network traffic. The session-scoped public tool (set_mock_response) requires
// an active recording session, but the runner needs to install rules earlier:
// the motivating bug was login flows whose GraphQL call fired during setup,
// before the post-recording mock-install phase ran.
//
// Rules installed via this path are tagged with a runner-controlled prefix
// (e.g., `mca:run-<runId>`) and are NOT cleaned up by stop_and_compile_test's
// session-tag cleanup — the runner manages their lifecycle directly via a
// try/finally around the test body. Not registered as an MCP tool; exposed
// only through RunnerDeps for the composite runner.
export interface InstallRunnerMockInput {
    /** Rule-name prefix (typically `mca:run-<runId>`). The mock ID is appended. */
    ruleNamePrefix: string;
    mock: SetMockResponseInput['mock'];
}

export interface InstallRunnerMockOutput {
    mockId: string;
    proxymanRuleId: string;
    ruleName: string;
}

export async function handleInstallRunnerMock(
    input: InstallRunnerMockInput,
): Promise<InstallRunnerMockOutput> {
    const mockId = input.mock.id ?? `mock-${randomBytes(4).toString('hex')}`;
    const ruleName = `${input.ruleNamePrefix}:${mockId}`;
    const url = buildProxymanUrlPattern(input.mock.matcher);
    const scriptContent = buildScriptContent({
        matcher: input.mock.matcher,
        staticResponse: input.mock.staticResponse,
        responseTransform: input.mock.responseTransform,
    });

    const client = _proxymanClientFactory();

    // Defensive: ensure the Scripting tool master toggle is on. Mirrors the
    // same guard handleSetMockResponse does — without it, rules install
    // successfully but no-op silently on traffic.
    try {
        await client.toggleTool('scripting', true);
    } catch (err) {
        console.error('[MCP] handleInstallRunnerMock: toggle_tool(scripting,on) failed (non-fatal):', err);
    }

    let proxymanRuleId: string;
    try {
        proxymanRuleId = await client.createScriptingRule({
            name: ruleName,
            url,
            scriptContent,
            method: input.mock.matcher.method,
            enableRequest: false,
            enableResponse: true,
            graphqlQueryName: input.mock.matcher.graphqlQueryName,
        });
    } catch (err) {
        if (err instanceof ProxymanMcpError) {
            throw new Error(
                `Proxyman MCP rejected the runner mock: ${err.message}. ` +
                `Is Proxyman running with MCP enabled (Settings → MCP)?`,
            );
        }
        throw err;
    }

    console.error(
        `[MCP] install_runner_mock: ruleName="${ruleName}" ruleId=${proxymanRuleId} url="${url}" ` +
        `mode=${input.mock.staticResponse ? 'static' : 'jsonPatch'}`,
    );

    return { mockId, proxymanRuleId, ruleName };
}

export async function handleDeleteRunnerMock(
    proxymanRuleId: string,
): Promise<void> {
    const client = _proxymanClientFactory();
    await client.deleteRule(proxymanRuleId, 'scripting');
}

// ---- set_mock_response (Proxyman MCP gateway) ----
//
// Registers a live response-mocking rule by translating our structured spec
// into a Proxyman scripting rule. The MCP gateway pattern means agents see one
// cohesive interface — they don't need to know about Proxyman's MCP, our
// session lifecycle, or the include_paths gotcha.
//
// Two modes selected by whether sessionId is provided:
//   - sessionId given: SESSION-scoped. Tagged `mca:<sessionId>:<mockId>`,
//     auto-cleaned on stop_and_compile_test for that session.
//   - sessionId omitted: STANDALONE. Tagged `mca:standalone:<mockId>`,
//     persists until explicitly cleared. Use case: agents that want to mock
//     outside any active recording session.
export async function handleSetMockResponse(
    input: SetMockResponseInput,
): Promise<SetMockResponseOutput> {
    const isSessionScoped = !!input.sessionId;

    if (isSessionScoped) {
        const session = await sessionManager.getSession(input.sessionId!);
        if (!session) {
            throw new Error(`Session not found: ${input.sessionId}. Was start_recording_session called?`);
        }
    }

    const mockId = input.mock.id ?? `mock-${randomBytes(4).toString('hex')}`;
    const ruleName = isSessionScoped
        ? buildRuleName(input.sessionId!, mockId)
        : `${STANDALONE_TAG_PREFIX}:${mockId}`;
    const url = buildProxymanUrlPattern(input.mock.matcher);
    const scriptContent = buildScriptContent({
        matcher: input.mock.matcher,
        staticResponse: input.mock.staticResponse,
        responseTransform: input.mock.responseTransform,
    });

    const client = _proxymanClientFactory();

    return runHandler({ name: `set_mock_response(${mockId})` }, async (cleanup) => {
        // Defensive: ensure the Scripting tool master toggle is on. Otherwise the
        // rule installs successfully but no-ops on traffic — exact behavior we
        // chased down in the spike.
        try {
            await client.toggleTool('scripting', true);
        } catch (err) {
            // Non-fatal: surface the full Proxyman error if the next step fails too.
            console.error('[MCP] set_mock_response: toggle_tool(scripting,on) failed (non-fatal):', err);
        }

        let proxymanRuleId: string;
        try {
            proxymanRuleId = await client.createScriptingRule({
                name: ruleName,
                url,
                scriptContent,
                method: input.mock.matcher.method,
                enableRequest: false,
                enableResponse: true,
                graphqlQueryName: input.mock.matcher.graphqlQueryName,
            });
        } catch (err) {
            if (err instanceof ProxymanMcpError) {
                throw new Error(
                    `Proxyman MCP rejected the rule: ${err.message}. ` +
                    `Is Proxyman running with MCP enabled (Settings → MCP)?`,
                );
            }
            throw err;
        }

        // Roll back the freshly-created Proxyman rule if any subsequent step
        // (ledger update, response shaping) throws. forget()'d on success.
        cleanup.add('delete proxyman rule on rollback', async () => {
            try {
                await client.deleteRule(proxymanRuleId, 'scripting');
            } catch (err) {
                console.error(`[MCP] set_mock_response rollback: deleteRule(${proxymanRuleId}) failed`, err);
            }
        });

        let result: SetMockResponseOutput;
        if (isSessionScoped) {
            sessionManager.addSessionMock(input.sessionId!, mockId, proxymanRuleId);
            const totalSessionMocks = sessionManager.listSessionMocks(input.sessionId!).length;
            console.error(
                `[MCP] set_mock_response: session=${input.sessionId} mockId=${mockId} ruleId=${proxymanRuleId} url="${url}" ` +
                `mode=${input.mock.staticResponse ? 'static' : 'jsonPatch'}`,
            );
            result = {
                mockId,
                proxymanRuleId,
                ruleName,
                scope: 'session',
                totalSessionMocks,
            };
        } else {
            sessionManager.addStandaloneMock(mockId, proxymanRuleId);
            console.error(
                `[MCP] set_mock_response: standalone mockId=${mockId} ruleId=${proxymanRuleId} url="${url}" ` +
                `mode=${input.mock.staticResponse ? 'static' : 'jsonPatch'}`,
            );
            result = {
                mockId,
                proxymanRuleId,
                ruleName,
                scope: 'standalone',
                totalStandaloneMocks: sessionManager.standaloneMockCount(),
            };
        }

        cleanup.forget('delete proxyman rule on rollback');
        return result;
    });
}

// ---- clear_mock_responses (Proxyman MCP gateway) ----
//
// Three modes selected by which fields are populated:
//   - sessionId (with optional mockId): clear all session mocks, or one specific
//   - mockId without sessionId: clear one standalone mock by ID
//   - allStandalone: clear all standalone mocks
//
// Note: transient delete failures are retried at the client layer
// (ProxymanMcpClient.deleteRule wraps callTool in retry<T>). The catch blocks
// below only fire on terminal failure — no double-retry needed here.
export async function handleClearMockResponses(
    input: ClearMockResponsesInput,
): Promise<ClearMockResponsesOutput> {
    return runHandler({ name: 'clear_mock_responses' }, async () => {
        const client = _proxymanClientFactory();

        // ── Session scope ──
        if (input.sessionId) {
            const entries = sessionManager.listSessionMocks(input.sessionId);
            if (entries.length === 0) {
                return { removed: 0, remaining: 0, scope: 'session' as const };
            }

            let removed = 0;
            if (input.mockId) {
                const ruleId = sessionManager.getSessionMockRule(input.sessionId, input.mockId);
                if (ruleId) {
                    try {
                        await client.deleteRule(ruleId, 'scripting');
                        // Only drop the ledger entry on a confirmed delete — keeps
                        // local truth aligned with Proxyman so retries are useful.
                        sessionManager.removeSessionMock(input.sessionId, input.mockId);
                        removed = 1;
                    } catch (err) {
                        console.error(`[MCP] clear_mock_responses: delete failed for rule ${ruleId} (ledger preserved for retry)`, err);
                    }
                }
            } else {
                for (const { mockId, ruleId } of entries) {
                    try {
                        await client.deleteRule(ruleId, 'scripting');
                        sessionManager.removeSessionMock(input.sessionId, mockId);
                        removed++;
                    } catch (err) {
                        console.error(`[MCP] clear_mock_responses: delete failed for rule ${ruleId} (ledger preserved for retry)`, err);
                    }
                }
            }

            const remaining = sessionManager.listSessionMocks(input.sessionId).length;
            console.error(
                `[MCP] clear_mock_responses: session=${input.sessionId} removed=${removed} remaining=${remaining}`,
            );
            return { removed, remaining, scope: 'session' as const };
        }

        // ── Standalone all ──
        if (input.allStandalone) {
            let removed = 0;
            for (const { mockId, ruleId } of sessionManager.listStandaloneMocks()) {
                try {
                    await client.deleteRule(ruleId, 'scripting');
                    sessionManager.removeStandaloneMock(mockId);
                    removed++;
                } catch (err) {
                    console.error(`[MCP] clear_mock_responses: delete failed for rule ${ruleId} (ledger preserved for retry)`, err);
                }
            }
            console.error(`[MCP] clear_mock_responses: cleared ${removed} standalone mocks`);
            return { removed, remaining: sessionManager.standaloneMockCount(), scope: 'standalone-all' as const };
        }

        // ── Standalone one (mockId only) ──
        const ruleId = sessionManager.getStandaloneMockRule(input.mockId!);
        if (!ruleId) {
            return { removed: 0, remaining: sessionManager.standaloneMockCount(), scope: 'standalone-one' as const };
        }
        let removed = 0;
        try {
            await client.deleteRule(ruleId, 'scripting');
            sessionManager.removeStandaloneMock(input.mockId!);
            removed = 1;
        } catch (err) {
            console.error(`[MCP] clear_mock_responses: delete failed for rule ${ruleId} (ledger preserved for retry)`, err);
        }
        console.error(`[MCP] clear_mock_responses: standalone mockId=${input.mockId} removed=${removed}`);
        return { removed, remaining: sessionManager.standaloneMockCount(), scope: 'standalone-one' as const };
    });
}

/**
 * Bulk-delete every scripting rule tagged with this session ID. Called from
 * stop_and_compile_test. Uses Proxyman's list_rules as the source of truth so
 * we don't leak when the local ledger is stale (e.g. user deleted via the UI
 * mid-session).
 *
 * Note: transient delete failures are retried at the client layer
 * (ProxymanMcpClient.deleteRule wraps callTool in retry<T>). The aggregator
 * `deleteRulesByTagPrefix` and the ledger-fallback loop both call deleteRule
 * directly, so retry happens automatically — no extra wrapping here.
 */
async function cleanupProxymanRulesForSession(sessionId: string): Promise<void> {
    const ledgerEntries = sessionManager.listSessionMocks(sessionId);
    if (ledgerEntries.length === 0) return;

    const client = _proxymanClientFactory();
    if (!client.isConnected()) {
        // Connection was never established this session — nothing to clean up
        // remotely. Still drop the local ledger.
        sessionManager.clearSessionMocks(sessionId);
        return;
    }

    // Tag-prefix delete is the source of truth — picks up any rules created
    // outside this ledger (e.g. via direct Proxyman API, or after a previous
    // crash). Falls back to the ledger if list_rules fails.
    const prefix = `mca:${sessionId}:`;
    const result = await client.deleteRulesByTagPrefix(prefix, 'scripting');
    if (result.failed.some((f) => f.id === '*list*')) {
        console.error(
            `[MCP] cleanupProxymanRulesForSession: list_rules failed, falling back to ledger`,
            result.failed,
        );
        for (const { ruleId } of ledgerEntries) {
            try {
                await client.deleteRule(ruleId, 'scripting');
            } catch (err) {
                console.error(
                    `[MCP] cleanupProxymanRulesForSession: ledger-fallback delete ${ruleId} failed (continuing)`,
                    err,
                );
            }
        }
    } else {
        if (result.failed.length > 0) {
            console.error(
                `[MCP] cleanupProxymanRulesForSession: ${result.failed.length} rule delete(s) failed (continuing)`,
                result.failed,
            );
        }
    }
    sessionManager.clearSessionMocks(sessionId);

    if (result.deleted.length > 0) {
        console.error(
            `[MCP] cleanupProxymanRulesForSession: cleaned ${result.deleted.length} rule(s) for session ${sessionId}`,
        );
    }
    // Reference isOurRuleForSession to keep the helper alive for any future
    // ledger-only diagnostic paths; the prefix delete already filters by name.
    void isOurRuleForSession;
}

// ---- run_feature_test ----
//
// Thin wrapper: the actual orchestration lives in featureTest/runner.ts. We pass
// the existing handlers in as a deps bag so the runner stays free of module
// cycles and is trivially mockable in tests.
export async function handleRunFeatureTest(
    input: RunFeatureTestInput,
): Promise<RunFeatureTestOutput> {
    console.error(`[MCP] run_feature_test: spec=${typeof input.spec === 'string' ? input.spec : input.spec.name}`);
    return runFeatureTest(input, {
        runFlow: handleRunFlow,
        startRecording: handleStartRecording,
        installRunnerMock: handleInstallRunnerMock,
        deleteRunnerMock: handleDeleteRunnerMock,
        executeUIAction: handleExecuteUIAction,
        stopAndCompile: handleStopAndCompile,
        verifyParallelism: handleVerifyNetworkParallelism,
        verifyOnScreen: handleVerifyNetworkOnScreen,
        verifyAbsent: handleVerifyNetworkAbsent,
        verifySequence: handleVerifyNetworkSequence,
        verifyPerformance: handleVerifyNetworkPerformance,
        verifyPayload: handleVerifyNetworkPayload,
        verifyDeduplication: handleVerifyNetworkDeduplication,
        verifyErrorHandling: handleVerifyNetworkErrorHandling,
        sleep: defaultSleep,
    });
}
