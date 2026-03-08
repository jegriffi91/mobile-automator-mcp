/**
 * Stub implementations for all 6 MCP tool handlers.
 * Each handler will be replaced with real logic in subsequent phases.
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
import { proxymanWrapper, PayloadValidator } from './proxyman/index.js';
import { Correlator, YamlGenerator, StubWriter } from './synthesis/index.js';
import type { MockingConfig } from './synthesis/index.js';
import type { NetworkEvent } from './types.js';
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
} from './schemas.js';

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

    await sessionManager.create(sessionId, input.appBundleId, input.platform, input.filterDomains);

    // Snapshot Proxyman baseline so we can scope the HAR export later
    try {
        const baseline = await proxymanWrapper.snapshotBaseline(input.filterDomains);
        await sessionManager.updateBaseline(sessionId, baseline);
    } catch (error) {
        console.error('[MCP] start_recording_session: Proxyman baseline snapshot failed (Proxyman may not be running)', error);
        // Non-fatal: we'll still capture all traffic at compile time
    }

    sessionManager.startPolling(sessionId, input.platform, input.appBundleId);

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

    console.error(`[MCP] stop_and_compile_test: wrote ${steps.length} steps to ${outputPath}`);

    // Finalize session
    await sessionManager.transition(input.sessionId, 'done');
    sessionManager.stopPolling(input.sessionId);

    return {
        sessionId: input.sessionId,
        yaml,
        yamlPath: outputPath,
        fixturesDir,
        stubsDir,
        manifestPath,
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

    const result = await maestroWrapper.executeAction(input.action, input.element, input.textInput);
    if (!result.success) {
        throw new Error(`Failed to execute action: ${result.error}`);
    }

    await sessionManager.logInteraction({
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
        actionType: input.action,
        element: input.element,
        textInput: input.textInput
    });

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

