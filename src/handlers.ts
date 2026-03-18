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
import { DriverFactory, type AutomationDriver } from './maestro/driver.js';
import { HierarchyParser } from './maestro/index.js';
import { proxymanWrapper, PayloadValidator } from './proxyman/index.js';
import { Correlator, YamlGenerator, StubWriter } from './synthesis/index.js';
import { SegmentFingerprint, SegmentRegistry } from './segments/index.js';
import { StubServer } from './wiremock/index.js';
import { extractTrackEvents } from './session/track-event-extractor.js';
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
    RegisterSegmentInput,
    RegisterSegmentOutput,
    RunTestInput,
    RunTestOutput,
    ListDevicesInput,
    ListDevicesOutput,
} from './schemas.js';

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

// ── Per-session driver instances ──
const activeDrivers: Map<string, AutomationDriver> = new Map();

// ---- start_recording_session ----
export async function handleStartRecording(
    input: StartRecordingInput
): Promise<StartRecordingOutput> {
    const sessionId = randomUUID();
    console.error(
        `[MCP] start_recording_session: starting session ${sessionId} for ${input.appBundleId} on ${input.platform}`
    );

    // Create driver with optional timeout overrides
    const driver = await DriverFactory.create(input.timeouts);

    const validation = await driver.validateSimulator(input.platform);
    if (!validation.booted) {
        throw new Error(`No booted ${input.platform} simulator found. Please boot a device first.`);
    }

    // Fast-fail if Java or Maestro isn't available
    await driver.validateSetup();

    // Uninstall stale Maestro driver — next `maestro` command will reinstall a fresh copy
    await driver.uninstallDriver(input.platform, validation.deviceId);

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

    // Snapshot Proxyman baseline so we can scope the HAR export later
    try {
        const baseline = await proxymanWrapper.snapshotBaseline(input.filterDomains);
        await sessionManager.updateBaseline(sessionId, baseline);
    } catch (error) {
        console.error('[MCP] start_recording_session: Proxyman baseline snapshot failed (Proxyman may not be running)', error);
        // Non-fatal: we'll still capture all traffic at compile time
    }

    // Start the driver (initializes daemon if using MaestroDaemonDriver)
    await driver.start(validation.deviceId);
    activeDrivers.set(sessionId, driver);

    // Start polling — driver provides the hierarchy reader
    const notifier = createPollingNotifier();
    await sessionManager.startPolling(sessionId, input.platform, input.appBundleId, driver, notifier);

    return {
        sessionId,
        message: `Recording session ${sessionId} started for ${input.appBundleId}. Device ID: ${validation.deviceId ?? 'unknown'}. Use this session ID for subsequent tool calls.`,
    };
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
        const driver = activeDrivers.get(input.sessionId);
        if (driver) {
            try {
                await driver.uninstallDriver(session.platform, undefined);
                await driver.stop();
            } catch (err) {
                console.error('[MCP] stop_and_compile_test: driver cleanup failed (non-fatal)', err);
            }
            activeDrivers.delete(input.sessionId);
        }

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
        const sessionDriver = activeDrivers.get(input.sessionId);
        if (!sessionDriver) {
            throw new Error(
                `No active driver for session ${input.sessionId}. ` +
                    `Was start_recording_session called?`
            );
        }
        driver = sessionDriver;
        console.error(`[MCP] get_ui_hierarchy: using session driver for ${input.sessionId}`);
    } else {
        // No session — create a temporary CLI driver and auto-target
        driver = await DriverFactory.createCliOnly();
        const iosSim = await driver.validateSimulator('ios');
        if (!iosSim.booted) {
            const androidSim = await driver.validateSimulator('android');
            if (!androidSim.booted) {
                throw new Error(
                    'No booted iOS or Android simulator found. ' +
                        'Boot a device or pass a sessionId from an active recording.'
                );
            }
            console.error(
                `[MCP] get_ui_hierarchy: auto-targeted Android device ${androidSim.deviceId}`
            );
        } else {
            console.error(`[MCP] get_ui_hierarchy: auto-targeted iOS device ${iosSim.deviceId}`);
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
    return result;
}

// ---- execute_ui_action ----
export async function handleExecuteUIAction(
    input: ExecuteUIActionInput
): Promise<ExecuteUIActionOutput> {
    const targetDesc =
        input.element.id ?? input.element.accessibilityLabel ?? input.element.text ?? 'unknown element';
    console.error(`[MCP] execute_ui_action: ${input.action} on "${targetDesc}"`);

    // Get the driver for this session
    const driver = activeDrivers.get(input.sessionId);
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

    const result = await driver.executeAction(input.action, input.element, input.textInput);
    if (!result.success) {
        throw new Error(`Failed to execute action: ${result.error}`);
    }

    await sessionManager.logInteraction({
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
        actionType: input.action,
        element: input.element,
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

    // Fetch from Proxyman (live traffic) with domain pre-filtering
    // Fall back to session-level filterDomains if not provided in the request
    const session = await sessionManager.getSession(input.sessionId);
    const domains = input.filterDomains ?? session?.filterDomains;
    const proxymanEvents = await proxymanWrapper.getTransactions(
        input.sessionId,
        input.filterPath,
        input.limit ?? 50,
        domains
    );

    // Also get any events already logged in the session DB
    let dbEvents = await sessionManager.getNetworkEvents(input.sessionId);

    if (input.filterPath) {
        dbEvents = dbEvents.filter((e: NetworkEvent) => e.url.includes(input.filterPath!));
    }

    // Merge and deduplicate by url + timestamp
    const seen = new Set<string>();
    const merged: NetworkEvent[] = [];

    for (const event of [...dbEvents, ...proxymanEvents]) {
        const key = `${event.url}|${event.timestamp}`;
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(event);
        }
    }

    // Also persist Proxyman events to the session DB for future correlation
    await sessionManager.batchLogNetworkEvents(proxymanEvents);

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

// ---- run_test ----
export async function handleRunTest(
    input: RunTestInput
): Promise<RunTestOutput> {
    console.error(`[MCP] run_test: running ${input.yamlPath}`);

    // Create a CLI-only driver for test execution (no daemon needed)
    const driver = await DriverFactory.createCliOnly();

    // Validate simulator + clean stale driver
    const platform = input.platform ?? 'ios';
    const validation = await driver.validateSimulator(platform);
    if (!validation.booted) {
        throw new Error(`No booted ${platform} simulator found. Please boot a device first.`);
    }
    await driver.uninstallDriver(platform, validation.deviceId);

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

        // Step 3: Run Maestro test
        const result = await driver.runTest(input.yamlPath, input.env);

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
