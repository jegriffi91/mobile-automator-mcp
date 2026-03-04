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
    TOOL_NAMES,
} from './schemas.js';

import {
    handleStartRecording,
    handleStopAndCompile,
    handleGetUIHierarchy,
    handleExecuteUIAction,
    handleGetNetworkLogs,
    handleVerifySDUIPayload,
} from './handlers.js';

import { sessionManager } from './session/index.js';

// ──────────────────────────────────────────────
// Server Bootstrap
// ──────────────────────────────────────────────

const server = new McpServer({
    name: 'mobile-automator-mcp',
    version: '0.1.0',
});

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
            'Capture a snapshot of the current UI element tree from the connected simulator. Returns a normalized accessibility tree prioritizing id/testID, then accessibilityLabel, then visible text.',
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
