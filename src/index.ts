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
    VerifyNetworkParallelismInputSchema,
    VerifyNetworkParallelismOutputSchema,
    VerifyNetworkOnScreenInputSchema,
    VerifyNetworkOnScreenOutputSchema,
    VerifyNetworkAbsentInputSchema,
    VerifyNetworkAbsentOutputSchema,
    VerifyNetworkSequenceInputSchema,
    VerifyNetworkSequenceOutputSchema,
    VerifyNetworkPerformanceInputSchema,
    VerifyNetworkPerformanceOutputSchema,
    VerifyNetworkPayloadInputSchema,
    VerifyNetworkPayloadOutputSchema,
    VerifyNetworkDeduplicationInputSchema,
    VerifyNetworkDeduplicationOutputSchema,
    VerifyNetworkErrorHandlingInputSchema,
    VerifyNetworkErrorHandlingOutputSchema,
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
    RunFeatureTestInputSchema,
    RunFeatureTestOutputSchema,
    SetMockResponseInputSchema,
    SetMockResponseOutputSchema,
    ClearMockResponsesInputSchema,
    ClearMockResponsesOutputSchema,
    ListActiveSessionsInputSchema,
    ListActiveSessionsOutputSchema,
    ListActiveMocksInputSchema,
    ListActiveMocksOutputSchema,
    ForceCleanupSessionInputSchema,
    ForceCleanupSessionOutputSchema,
    ForceCleanupMocksInputSchema,
    ForceCleanupMocksOutputSchema,
    AuditStateInputSchema,
    AuditStateOutputSchema,
    TOOL_NAMES,
} from './schemas.js';

import {
    handleStartRecording,
    handleStopAndCompile,
    handleGetUIHierarchy,
    handleExecuteUIAction,
    handleGetNetworkLogs,
    handleVerifySDUIPayload,
    handleVerifyNetworkParallelism,
    handleVerifyNetworkOnScreen,
    handleVerifyNetworkAbsent,
    handleVerifyNetworkSequence,
    handleVerifyNetworkPerformance,
    handleVerifyNetworkPayload,
    handleVerifyNetworkDeduplication,
    handleVerifyNetworkErrorHandling,
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
    handleRunFeatureTest,
    handleSetMockResponse,
    handleClearMockResponses,
    setMcpServer,
} from './handlers.js';

import {
    handleListActiveSessions,
    handleListActiveMocks,
    handleForceCleanupSession,
    handleForceCleanupMocks,
    handleAuditState,
} from './admin/index.js';

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

// ── 6a. verify_network_parallelism ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_PARALLELISM,
    {
        title: 'Verify Network Parallelism',
        description:
            'Assert that a set of matching network requests all start within a given time window (e.g., SDUI queries firing in parallel). Fails if fewer than minExpectedCount match or the total span exceeds maxWindowMs.',
        inputSchema: VerifyNetworkParallelismInputSchema,
        outputSchema: VerifyNetworkParallelismOutputSchema,
        annotations: {
            title: 'Verify Network Parallelism',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkParallelism(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6b. verify_network_on_screen ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_ON_SCREEN,
    {
        title: 'Verify Network On Screen',
        description:
            'Assert that a list of expected network calls all fire within `withinMs` of a referenced UI action. Use to verify that navigating to a screen triggers the right API calls.',
        inputSchema: VerifyNetworkOnScreenInputSchema,
        outputSchema: VerifyNetworkOnScreenOutputSchema,
        annotations: {
            title: 'Verify Network On Screen',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkOnScreen(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6c. verify_network_absent ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_ABSENT,
    {
        title: 'Verify Network Absent',
        description:
            'Assert that a list of forbidden network calls do NOT fire within `withinMs` of a referenced UI action. Use to verify cache hits or absence of unnecessary prefetching.',
        inputSchema: VerifyNetworkAbsentInputSchema,
        outputSchema: VerifyNetworkAbsentOutputSchema,
        annotations: {
            title: 'Verify Network Absent',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkAbsent(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6d. verify_network_sequence ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_SEQUENCE,
    {
        title: 'Verify Network Sequence',
        description:
            'Assert that a set of network calls happened in a specific chronological order. Strict mode fails if any unmatched event appears between ordered matches.',
        inputSchema: VerifyNetworkSequenceInputSchema,
        outputSchema: VerifyNetworkSequenceOutputSchema,
        annotations: {
            title: 'Verify Network Sequence',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkSequence(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6e. verify_network_performance ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_PERFORMANCE,
    {
        title: 'Verify Network Performance',
        description:
            'Assert latency budgets: max per-request durationMs and/or max total first-start→last-end across a matcher. Reports p50/p95 stats and excludes events with unknown durations from percentiles.',
        inputSchema: VerifyNetworkPerformanceInputSchema,
        outputSchema: VerifyNetworkPerformanceOutputSchema,
        annotations: {
            title: 'Verify Network Performance',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkPerformance(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6f. verify_network_payload ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_PAYLOAD,
    {
        title: 'Verify Network Payload',
        description:
            'Assert JSON response fields via dot/bracket paths: equals, contains, exists, type, minLength. More flexible than verify_sdui_payload, which only supports exact field matching.',
        inputSchema: VerifyNetworkPayloadInputSchema,
        outputSchema: VerifyNetworkPayloadOutputSchema,
        annotations: {
            title: 'Verify Network Payload',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkPayload(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6g. verify_network_deduplication ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_DEDUPLICATION,
    {
        title: 'Verify Network Deduplication',
        description:
            'Assert that requests are not duplicated beyond a threshold. Groups by URL or extracted GraphQL operationName; flags groups exceeding maxDuplicates.',
        inputSchema: VerifyNetworkDeduplicationInputSchema,
        outputSchema: VerifyNetworkDeduplicationOutputSchema,
        annotations: {
            title: 'Verify Network Deduplication',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkDeduplication(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 6h. verify_network_error_handling ──
server.registerTool(
    TOOL_NAMES.VERIFY_NETWORK_ERROR_HANDLING,
    {
        title: 'Verify Network Error Handling',
        description:
            'Assert that specific error responses appear in the session. Pair with WireMock stubs to verify the app behaves correctly under injected failures.',
        inputSchema: VerifyNetworkErrorHandlingInputSchema,
        outputSchema: VerifyNetworkErrorHandlingOutputSchema,
        annotations: {
            title: 'Verify Network Error Handling',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleVerifyNetworkErrorHandling(args);
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

// ── 19. run_feature_test ──
server.registerTool(
    TOOL_NAMES.RUN_FEATURE_TEST,
    {
        title: 'Run Feature Test',
        description:
            'Execute a declarative feature test in ONE tool call: setup flows → start recording → UI actions → network assertions → stop & compile → teardown. Replaces 8–15 AI-orchestrated tool calls per run with a single deterministic lifecycle. Accepts an inline FeatureTestSpec or a path to a .yaml/.json spec file.',
        inputSchema: RunFeatureTestInputSchema,
        outputSchema: RunFeatureTestOutputSchema,
        annotations: {
            title: 'Run Feature Test',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleRunFeatureTest(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 20. set_mock_response (Proxyman MCP gateway) ──
server.registerTool(
    TOOL_NAMES.SET_MOCK_RESPONSE,
    {
        title: 'Set Mock Response',
        description:
            'Install a live response-mocking rule for an active recording session. Internally translates the spec into a Proxyman scripting rule and asks Proxyman (via its MCP) to install it on the running proxy. Two modes: staticResponse (return a verbatim payload — good for feature flags / fixtures) and responseTransform.jsonPatch (proxy to the real backend, then mutate the response body in flight — good for the loginStatus override pattern). Rules are tagged with the session ID so stop_and_compile_test can clean them up. REQUIRES: Proxyman running with MCP enabled (Settings → MCP).',
        inputSchema: SetMockResponseInputSchema,
        outputSchema: SetMockResponseOutputSchema,
        annotations: {
            title: 'Set Mock Response',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleSetMockResponse(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 21. clear_mock_responses (Proxyman MCP gateway) ──
server.registerTool(
    TOOL_NAMES.CLEAR_MOCK_RESPONSES,
    {
        title: 'Clear Mock Responses',
        description:
            'Remove mocks installed by set_mock_response. Pass mockId to remove one specific mock; omit to clear all mocks for the session. The companion to set_mock_response — stop_and_compile_test runs this implicitly on session end so leaks should be rare.',
        inputSchema: ClearMockResponsesInputSchema,
        outputSchema: ClearMockResponsesOutputSchema,
        annotations: {
            title: 'Clear Mock Responses',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleClearMockResponses(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 22. list_active_sessions (admin) ──
server.registerTool(
    TOOL_NAMES.LIST_ACTIVE_SESSIONS,
    {
        title: 'List Active Sessions',
        description:
            'Inventory of recording sessions, with driver/poller liveness and mock count per session. Read-only — use this to find orphaned state before deciding whether to call force_cleanup_session.',
        inputSchema: ListActiveSessionsInputSchema,
        outputSchema: ListActiveSessionsOutputSchema,
        annotations: {
            title: 'List Active Sessions',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleListActiveSessions(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 23. list_active_mocks (admin) ──
server.registerTool(
    TOOL_NAMES.LIST_ACTIVE_MOCKS,
    {
        title: 'List Active Mocks',
        description:
            'Inspect Proxyman scripting rules tagged "mca:". Reports drift between the local ledger and Proxyman state (rules-not-in-ledger, ledger-not-in-Proxyman) so the caller can spot leaks. Returns proxymanReachable=false instead of throwing when Proxyman MCP is unavailable.',
        inputSchema: ListActiveMocksInputSchema,
        outputSchema: ListActiveMocksOutputSchema,
        annotations: {
            title: 'List Active Mocks',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleListActiveMocks(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 24. force_cleanup_session (admin, destructive) ──
server.registerTool(
    TOOL_NAMES.FORCE_CLEANUP_SESSION,
    {
        title: 'Force-Cleanup Session',
        description:
            'Tear down a stuck session: stop polling, stop the driver, delete its tagged Proxyman rules, mark the session aborted. Never throws — partial-failure detail comes back in the errors[] array. Does NOT kill the simulator (only state we created).',
        inputSchema: ForceCleanupSessionInputSchema,
        outputSchema: ForceCleanupSessionOutputSchema,
        annotations: {
            title: 'Force-Cleanup Session',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleForceCleanupSession(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 25. force_cleanup_mocks (admin, destructive) ──
server.registerTool(
    TOOL_NAMES.FORCE_CLEANUP_MOCKS,
    {
        title: 'Force-Cleanup Mocks',
        description:
            'Bulk delete Proxyman scripting rules by scope: "all" (everything tagged mca:), "session" (one session, requires sessionId), or "standalone". Local ledgers are reconciled. Never throws — failures surface in errors[].',
        inputSchema: ForceCleanupMocksInputSchema,
        outputSchema: ForceCleanupMocksOutputSchema,
        annotations: {
            title: 'Force-Cleanup Mocks',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleForceCleanupMocks(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 26. audit_state (admin, read-only) ──
server.registerTool(
    TOOL_NAMES.AUDIT_STATE,
    {
        title: 'Audit State',
        description:
            'Single-shot snapshot of session/driver/poller/Proxyman state, plus a small orphans report (Proxyman rules without a known session, sessions in recording without a driver, pollers without a session). Use as the entry point when something looks wrong.',
        inputSchema: AuditStateInputSchema,
        outputSchema: AuditStateOutputSchema,
        annotations: {
            title: 'Audit State',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleAuditState(args);
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

    if (process.env.MCP_TRANSPORT === 'http') {
        const { startHttpBridge } = await import('./httpBridge.js');
        await startHttpBridge();
        return;
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[mobile-automator-mcp] Server running on stdio transport');
}

main().catch((err) => {
    console.error('[mobile-automator-mcp] Fatal error:', err);
    process.exit(1);
});
