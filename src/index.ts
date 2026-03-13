#!/usr/bin/env node
/**
 * Mobile Automator MCP Server
 *
 * An MCP server that orchestrates Maestro (UI automation) and Proxyman
 * (network interception) to generate SDUI-aware Maestro YAML test scripts.
 *
 * Uses `registerTool` with full input/output schemas for structured responses.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
    StartRecordingInputSchema,
    StartRecordingOutputSchema,
    StopAndCompileInputSchema,
    StopAndCompileOutputSchema,
    GetUIHierarchyInputSchema,
    GetUIHierarchyOutputSchema,
    ExecuteUIActionInputSchema,
    ExecuteUIActionOutputSchema,
    GetNetworkLogsInputSchema,
    GetNetworkLogsOutputSchema,
    VerifySDUIPayloadInputSchema,
    VerifySDUIPayloadOutputSchema,
    RegisterSegmentInputSchema,
    RegisterSegmentOutputSchema,
    RunTestInputSchema,
    RunTestOutputSchema,
    ListDevicesInputSchema,
    ListDevicesOutputSchema,
    TOOL_NAMES,
} from './schemas.js';

import {
    handleStartRecording,
    handleStopAndCompile,
    handleGetUIHierarchy,
    handleExecuteUIAction,
    handleGetNetworkLogs,
    handleVerifySDUIPayload,
    handleRegisterSegment,
    handleRunTest,
    handleListDevices,
    setMcpServer,
} from './handlers.js';

import { sessionManager } from './session/index.js';

// ──────────────────────────────────────────────
// Server Bootstrap
// ──────────────────────────────────────────────

const server = new McpServer({
    name: 'mobile-automator-mcp',
    version: '0.1.0',
});

// Wire the server into handlers for real-time polling notifications
setMcpServer(server);

// ── 1. start_recording_session ──
server.registerTool(
    TOOL_NAMES.START_RECORDING,
    {
        title: 'Start Recording Session',
        description:
            'Begin recording a mobile interaction session. Initializes session memory, monitors the UI hierarchy, and starts capturing network events. Returns a session ID to use with subsequent tool calls.',
        inputSchema: StartRecordingInputSchema,
        outputSchema: StartRecordingOutputSchema,
        annotations: {
            title: 'Start Recording Session',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleStartRecording(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 2. stop_and_compile_test ──
server.registerTool(
    TOOL_NAMES.STOP_AND_COMPILE,
    {
        title: 'Stop and Compile Test',
        description:
            'Stop the active recording session and synthesize a Maestro YAML test script. Correlates captured UI interactions with network payloads and embeds JavaScript assertions for analytics events.',
        inputSchema: StopAndCompileInputSchema,
        outputSchema: StopAndCompileOutputSchema,
        annotations: {
            title: 'Stop and Compile Test',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleStopAndCompile(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 3. get_ui_hierarchy ──
server.registerTool(
    TOOL_NAMES.GET_UI_HIERARCHY,
    {
        title: 'Get UI Hierarchy',
        description:
            'Capture the current UI element tree from a booted simulator. Works standalone (auto-targets the sole booted device) or within a recording session via sessionId. Returns a normalized accessibility tree. Use interactiveOnly to filter to tappable elements. Raw output is opt-in via includeRawOutput.',
        inputSchema: GetUIHierarchyInputSchema,
        outputSchema: GetUIHierarchyOutputSchema,
        annotations: {
            title: 'Get UI Hierarchy',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleGetUIHierarchy(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 4. execute_ui_action ──
server.registerTool(
    TOOL_NAMES.EXECUTE_UI_ACTION,
    {
        title: 'Execute UI Action',
        description:
            'Dispatch a UI action (tap, type, scroll, etc.) on a target element. Logs the interaction to session memory for later test synthesis. Selector priority: id > accessibilityLabel > text.',
        inputSchema: ExecuteUIActionInputSchema,
        outputSchema: ExecuteUIActionOutputSchema,
        annotations: {
            title: 'Execute UI Action',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleExecuteUIAction(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 5. get_network_logs ──
server.registerTool(
    TOOL_NAMES.GET_NETWORK_LOGS,
    {
        title: 'Get Network Logs',
        description:
            'Retrieve intercepted HTTP/HTTPS network transactions for the session from Proxyman. Filter by URL path to isolate SDUI or analytics endpoints. Used to correlate network state with UI state.',
        inputSchema: GetNetworkLogsInputSchema,
        outputSchema: GetNetworkLogsOutputSchema,
        annotations: {
            title: 'Get Network Logs',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleGetNetworkLogs(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6. verify_sdui_payload ──
server.registerTool(
    TOOL_NAMES.VERIFY_SDUI_PAYLOAD,
    {
        title: 'Verify SDUI Payload',
        description:
            'Validate that a specific SDUI network response matches expected fields. Returns matched status and a list of any mismatches. Used to assert correct server-driven content is rendered by the UI.',
        inputSchema: VerifySDUIPayloadInputSchema,
        outputSchema: VerifySDUIPayloadOutputSchema,
        annotations: {
            title: 'Verify SDUI Payload',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifySDUIPayload(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 7. register_segment ──
server.registerTool(
    TOOL_NAMES.REGISTER_SEGMENT,
    {
        title: 'Register Segment',
        description:
            'Register a recorded session as a named, reusable flow segment. Computes a fingerprint from the correlated steps and saves it to the segment registry for future deduplication.',
        inputSchema: RegisterSegmentInputSchema,
        outputSchema: RegisterSegmentOutputSchema,
        annotations: {
            title: 'Register Segment',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleRegisterSegment(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 8. run_test ──
server.registerTool(
    TOOL_NAMES.RUN_TEST,
    {
        title: 'Run Test',
        description:
            'Run a Maestro YAML test file with optional WireMock stub replay. Automatically starts an in-process stub server, runs the test, and tears down. Returns pass/fail status, output, and duration. Note: this tool replays a static YAML script against a booted simulator — it does NOT connect to live Proxyman or record new network traffic during execution.',
        inputSchema: RunTestInputSchema,
        outputSchema: RunTestOutputSchema,
        annotations: {
            title: 'Run Test',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleRunTest(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 9. list_devices ──
server.registerTool(
    TOOL_NAMES.LIST_DEVICES,
    {
        title: 'List Devices',
        description:
            'List available iOS simulators and Android emulators. Filter by platform, state (Booted/Shutdown), or OS version. Use this to discover device UDIDs before calling get_ui_hierarchy.',
        inputSchema: ListDevicesInputSchema,
        outputSchema: ListDevicesOutputSchema,
        annotations: {
            title: 'List Devices',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleListDevices(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ──────────────────────────────────────────────
// Transport & Start
// ──────────────────────────────────────────────

async function main() {
    await sessionManager.initialize();
    console.error('[mobile-automator-mcp] Session Database initialized');

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[mobile-automator-mcp] Server running on stdio transport');
}

main().catch((err) => {
    console.error('[mobile-automator-mcp] Fatal error:', err);
    process.exit(1);
});
