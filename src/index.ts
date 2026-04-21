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
    GetSessionTimelineInputSchema,
    GetSessionTimelineOutputSchema,
    ListFlowsInputSchema,
    ListFlowsOutputSchema,
    RunFlowInputSchema,
    RunFlowOutputSchema,
    BuildAppInputSchema,
    BuildAppOutputSchema,
    InstallAppInputSchema,
    InstallAppOutputSchema,
    UninstallAppInputSchema,
    UninstallAppOutputSchema,
    BootSimulatorInputSchema,
    BootSimulatorOutputSchema,
    TakeScreenshotInputSchema,
    TakeScreenshotOutputSchema,
    RunUnitTestsInputSchema,
    RunUnitTestsOutputSchema,
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
    handleGetSessionTimeline,
    handleListFlows,
    handleRunFlow,
    handleBuildApp,
    handleInstallApp,
    handleUninstallApp,
    handleBootSimulator,
    handleTakeScreenshot,
    handleRunUnitTests,
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

// ── 10. get_session_timeline ──
server.registerTool(
    TOOL_NAMES.GET_SESSION_TIMELINE,
    {
        title: 'Get Session Timeline',
        description:
            'Get a lightweight mid-session health check showing polling stats, interaction counts, and gap analysis. Use during an active recording to verify the poller is keeping up and interactions are being captured. Only available while session status is "recording".',
        inputSchema: GetSessionTimelineInputSchema,
        outputSchema: GetSessionTimelineOutputSchema,
        annotations: {
            title: 'Get Session Timeline',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleGetSessionTimeline(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 11. list_flows ──
server.registerTool(
    TOOL_NAMES.LIST_FLOWS,
    {
        title: 'List Flows',
        description:
            'Discover named Maestro flows in a flows directory (default: ./flows). Each flow is a .yaml file; an optional _manifest.json adds descriptions, tags, and parameter specs. Use run_flow to execute one by name.',
        inputSchema: ListFlowsInputSchema,
        outputSchema: ListFlowsOutputSchema,
        annotations: {
            title: 'List Flows',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleListFlows(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 12. run_flow ──
server.registerTool(
    TOOL_NAMES.RUN_FLOW,
    {
        title: 'Run Flow',
        description:
            'Execute a named Maestro flow by name. Resolves <flowsDir>/<name>.yaml, merges manifest param defaults with caller-supplied params, and runs the flow against a booted simulator. Use this to navigate to the area of an incremental change before verifying it.',
        inputSchema: RunFlowInputSchema,
        outputSchema: RunFlowOutputSchema,
        annotations: {
            title: 'Run Flow',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleRunFlow(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 13. build_app ──
server.registerTool(
    TOOL_NAMES.BUILD_APP,
    {
        title: 'Build App',
        description:
            'Compile an iOS or Android app from source. iOS: shells xcodebuild and returns the built .app path + bundle id. Android: shells ./gradlew assemble<Variant> and returns the APK path. Long-running — default timeout is 15 minutes.',
        inputSchema: BuildAppInputSchema,
        outputSchema: BuildAppOutputSchema,
        annotations: {
            title: 'Build App',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleBuildApp(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 14. install_app ──
server.registerTool(
    TOOL_NAMES.INSTALL_APP,
    {
        title: 'Install App',
        description:
            'Install a built app onto a booted simulator/emulator. iOS uses xcrun simctl install; Android uses adb install -r. Returns the resolved bundle id (iOS) when available.',
        inputSchema: InstallAppInputSchema,
        outputSchema: InstallAppOutputSchema,
        annotations: {
            title: 'Install App',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleInstallApp(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 15. uninstall_app ──
server.registerTool(
    TOOL_NAMES.UNINSTALL_APP,
    {
        title: 'Uninstall App',
        description:
            'Remove an installed app from a booted simulator/emulator, wiping its storage. Use before install_app to guarantee a clean-state launch. iOS: xcrun simctl uninstall; Android: adb uninstall.',
        inputSchema: UninstallAppInputSchema,
        outputSchema: UninstallAppOutputSchema,
        annotations: {
            title: 'Uninstall App',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleUninstallApp(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 16. boot_simulator ──
server.registerTool(
    TOOL_NAMES.BOOT_SIMULATOR,
    {
        title: 'Boot Simulator',
        description:
            'Boot an iOS simulator by UDID and wait for it to be fully ready. Idempotent — returns alreadyBooted=true if the device was already running. Also opens Simulator.app by default. Android emulator booting is not yet supported (start it manually).',
        inputSchema: BootSimulatorInputSchema,
        outputSchema: BootSimulatorOutputSchema,
        annotations: {
            title: 'Boot Simulator',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleBootSimulator(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 17. take_screenshot ──
server.registerTool(
    TOOL_NAMES.TAKE_SCREENSHOT,
    {
        title: 'Take Screenshot',
        description:
            'Capture a PNG of the current simulator/emulator screen. iOS uses `xcrun simctl io <udid> screenshot`; Android uses `adb exec-out screencap -p`. Returns the absolute path of the written PNG, which Claude can read back directly.',
        inputSchema: TakeScreenshotInputSchema,
        outputSchema: TakeScreenshotOutputSchema,
        annotations: {
            title: 'Take Screenshot',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleTakeScreenshot(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 18. run_unit_tests ──
server.registerTool(
    TOOL_NAMES.RUN_UNIT_TESTS,
    {
        title: 'Run Unit Tests',
        description:
            'Run the unit-test target for the project and return structured results (pass/fail counts, failing test names, first-line failure messages). iOS: `xcodebuild test` with a resultBundlePath; Android: `./gradlew :<module>:test<Variant>UnitTest` with JUnit XML parsing. Long-running — default timeout is 30 minutes.',
        inputSchema: RunUnitTestsInputSchema,
        outputSchema: RunUnitTestsOutputSchema,
        annotations: {
            title: 'Run Unit Tests',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleRunUnitTests(args);
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
