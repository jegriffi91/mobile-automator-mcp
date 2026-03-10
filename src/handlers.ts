/**
 * MCP tool handlers for all 8 tools.
 *
 * Input/output types are derived from Zod schemas (schemas.ts) —
 * the single source of truth for tool I/O shapes.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { sessionManager } from './session/index.js';
import { maestroWrapper, HierarchyParser } from './maestro/index.js';
import { MaestroDaemon } from './maestro/daemon.js';
import { proxymanWrapper, PayloadValidator } from './proxyman/index.js';
import { Correlator, YamlGenerator, StubWriter } from './synthesis/index.js';
import { SegmentFingerprint, SegmentRegistry } from './segments/index.js';
import { StubServer } from './wiremock/index.js';
import type { MockingConfig } from './synthesis/index.js';
import type { NetworkEvent, StateChange } from './types.js';
import type { PollingNotifier } from './session/touch-inferrer.js';
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
} from './schemas.js';

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

// ---- start_recording_session ----
export async function handleStartRecording(
    input: StartRecordingInput
): Promise<StartRecordingOutput> {
    const sessionId = randomUUID();
    console.error(
        `[MCP] start_recording_session: starting session ${sessionId} for ${input.appBundleId} on ${input.platform}`
    );

    const validation = await maestroWrapper.validateSimulator(input.platform);
    if (!validation.booted) {
        throw new Error(`No booted ${input.platform} simulator found. Please boot a device first.`);
    }

    // Fast-fail if Java or Maestro isn't available
    await maestroWrapper.validateSetup();

    // Uninstall stale Maestro driver — next `maestro` command will reinstall a fresh copy
    await maestroWrapper.uninstallDriver(input.platform, validation.deviceId);

    await sessionManager.create(
        sessionId,
        input.appBundleId,
        input.platform,
        input.filterDomains,
        input.captureMode,
        input.pollingIntervalMs,
        input.settleTimeoutMs,
    );

    // Snapshot Proxyman baseline so we can scope the HAR export later
    try {
        const baseline = await proxymanWrapper.snapshotBaseline(input.filterDomains);
        await sessionManager.updateBaseline(sessionId, baseline);
    } catch (error) {
        console.error('[MCP] start_recording_session: Proxyman baseline snapshot failed (Proxyman may not be running)', error);
        // Non-fatal: we'll still capture all traffic at compile time
    }

    // Start polling — prefer daemon (sub-second) with CLI fallback
    const daemon = new MaestroDaemon();
    const notifier = createPollingNotifier();
    await sessionManager.startPolling(sessionId, input.platform, input.appBundleId, maestroWrapper, daemon, notifier);

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

    // ── Step 1: Export scoped Proxyman HAR ──
    const scopedHarPath = path.join(os.tmpdir(), `proxyman-scoped-${input.sessionId}.har`);
    let proxymanEvents: NetworkEvent[] = [];
    try {
        const baseline = session.proxymanBaseline ?? 0;
        await proxymanWrapper.exportHarScoped(scopedHarPath, baseline, session.filterDomains);
        const raw = await fs.readFile(scopedHarPath, 'utf-8');
        const har = JSON.parse(raw);
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
    } finally {
        await fs.unlink(scopedHarPath).catch(() => { });
    }

    // ── Step 2: Fetch UI interactions from session DB ──
    const interactions = await sessionManager.getInteractions(input.sessionId);

    // Merge Proxyman events with any already-logged session DB events
    const dbEvents = await sessionManager.getNetworkEvents(input.sessionId);
    const seen = new Set<string>();
    const allNetworkEvents: NetworkEvent[] = [];
    for (const event of [...dbEvents, ...proxymanEvents]) {
        const key = `${event.url}|${event.timestamp}`;
        if (!seen.has(key)) {
            seen.add(key);
            allNetworkEvents.push(event);
        }
    }

    console.error(
        `[MCP] stop_and_compile_test: correlating ${interactions.length} interactions with ${allNetworkEvents.length} network events`
    );

    // ── Step 3: Correlate UI actions with network events ──
    const correlator = new Correlator();
    const steps = correlator.correlate(interactions, allNetworkEvents);

    // ── Step 4: Generate YAML ──
    const generator = new YamlGenerator(session.appBundleId);
    const yaml = generator.toYaml(steps, input.conditions);

    // Write YAML
    const outputPath = input.outputPath ?? path.join(os.tmpdir(), `maestro-test-${input.sessionId}.yaml`);
    await fs.writeFile(outputPath, yaml, 'utf-8');

    // ── Step 5: Generate WireMock stubs (if network events exist) ──
    let fixturesDir: string | undefined;
    let stubsDir: string | undefined;
    let manifestPath: string | undefined;

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
        stubsDir = path.join(sessionDir, 'wiremock', 'mappings');
        manifestPath = path.join(sessionDir, 'manifest.json');

        console.error(
            `[MCP] stop_and_compile_test: wrote ${manifest.routes.length} WireMock stubs to ${stubsDir}`
        );
    }

    // ── Step 6: Compute segment fingerprint and check registry ──
    let segmentFingerprint: string | undefined;
    let matchedSegments: Array<{ name: string; fingerprint: string; similarity: number; yamlPath: string }> | undefined;

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
    const pollingDiagnostics = pollingStatus ?? undefined;

    if (pollingDiagnostics) {
        console.error(
            `[MCP] stop_and_compile_test: polling diagnostics — polls: ${pollingDiagnostics.pollCount}, success: ${pollingDiagnostics.successCount}, errors: ${pollingDiagnostics.errorCount}, inferred: ${pollingDiagnostics.inferredCount}` +
            (pollingDiagnostics.lastError ? `, lastError: ${pollingDiagnostics.lastError}` : '')
        );
    }

    if (interactions.length === 0 && pollingDiagnostics) {
        if (pollingDiagnostics.errorCount > 0) {
            console.error(
                `[MCP] ⚠️  No interactions captured. Polling had ${pollingDiagnostics.errorCount} error(s). Last error: ${pollingDiagnostics.lastError}`
            );
        } else if (pollingDiagnostics.pollCount === 0) {
            console.error('[MCP] ⚠️  No interactions captured. Poller never ran — daemon may have failed to start.');
        }
    }

    // Finalize session
    await sessionManager.transition(input.sessionId, 'done');
    await sessionManager.stopPolling(input.sessionId);

    // Clean up Maestro driver so it doesn't go stale between sessions
    await maestroWrapper.uninstallDriver(session.platform, undefined);

    // Purge hierarchy snapshots to free memory
    await sessionManager.purgeSnapshots(input.sessionId);

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
    _input: GetUIHierarchyInput
): Promise<GetUIHierarchyOutput> {
    console.error(`[MCP] get_ui_hierarchy: capturing current screen`);

    const rawOutput = await maestroWrapper.dumpHierarchy();
    const hierarchy = HierarchyParser.parse(rawOutput);

    return {
        hierarchy,
        rawXml: rawOutput,
    };
}

// ---- execute_ui_action ----
export async function handleExecuteUIAction(
    input: ExecuteUIActionInput
): Promise<ExecuteUIActionOutput> {
    const targetDesc =
        input.element.id ?? input.element.accessibilityLabel ?? input.element.text ?? 'unknown element';
    console.error(`[MCP] execute_ui_action: ${input.action} on "${targetDesc}"`);

    // Retrieve session to check capture mode
    const session = await sessionManager.getSession(input.sessionId);
    const captureMode = session?.captureMode || 'event-triggered';
    const settleTimeoutMs = session?.settleTimeoutMs ?? 3000;

    // ── Pre-action snapshot (event-triggered mode) ──
    let preActionHierarchy: string | undefined;
    if (captureMode === 'event-triggered') {
        try {
            preActionHierarchy = await maestroWrapper.dumpHierarchy();
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

    const result = await maestroWrapper.executeAction(input.action, input.element, input.textInput);
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
                await maestroWrapper.dumpHierarchyUntilSettled(settleTimeoutMs);

            await sessionManager.insertSnapshot({
                sessionId: input.sessionId,
                timestamp: new Date().toISOString(),
                trigger: 'post-settle',
                hierarchyJson: postHierarchy,
            });

            // Compute the diff
            const { HierarchyParser } = await import('./maestro/index.js');
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
    for (const event of proxymanEvents) {
        try {
            await sessionManager.logNetworkEvent(event);
        } catch {
            // Ignore duplicates or session-not-found for non-active sessions
        }
    }

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

    // Validate simulator + clean stale driver (same as handleStartRecording)
    const platform = input.platform ?? 'ios';
    const validation = await maestroWrapper.validateSimulator(platform);
    if (!validation.booted) {
        throw new Error(`No booted ${platform} simulator found. Please boot a device first.`);
    }
    await maestroWrapper.uninstallDriver(platform, validation.deviceId);

    let stubServer: StubServer | undefined;
    let stubServerPort: number | undefined;

    try {
        // Step 1: Start stub server if stubs are provided
        if (input.stubsDir) {
            stubServer = new StubServer();
            await stubServer.loadStubs(input.stubsDir);
            stubServerPort = await stubServer.start(input.stubServerPort ?? 0);
            console.error(`[MCP] run_test: stub server started on port ${stubServerPort}`);
        }

        // Step 2: Run Maestro test
        const result = await maestroWrapper.runTest(input.yamlPath);

        return {
            passed: result.passed,
            output: result.output,
            stubServerPort,
            durationMs: result.durationMs,
        };
    } finally {
        // Step 3: Tear down stub server
        if (stubServer) {
            await stubServer.stop();
            console.error('[MCP] run_test: stub server stopped');
        }
    }
}
