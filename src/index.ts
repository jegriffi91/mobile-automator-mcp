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
    ListDevicesInputSchema,
    ListDevicesOutputSchema,
    GetSessionTimelineInputSchema,
    GetSessionTimelineOutputSchema,
    ListFlowsInputSchema,
    ListFlowsOutputSchema,
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
    ForceCleanupArtifactsInputSchema,
    ForceCleanupArtifactsOutputSchema,
    StartBuildInputSchema,
    StartBuildOutputSchema,
    StartTestInputSchema,
    StartTestOutputSchema,
    StartFlowInputSchema,
    StartFlowOutputSchema,
    PollTaskStatusInputSchema,
    PollTaskStatusOutputSchema,
    GetTaskResultInputSchema,
    GetTaskResultOutputSchema,
    CancelTaskInputSchema,
    CancelTaskOutputSchema,
    ListTasksInputSchema,
    ListTasksOutputSchema,
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
    handleListDevices,
    handleGetSessionTimeline,
    handleListFlows,
    handleInstallApp,
    handleUninstallApp,
    handleBootSimulator,
    handleTakeScreenshot,
    handleRunUnitTests,
    handleRunFeatureTest,
    handleSetMockResponse,
    handleClearMockResponses,
    handleStartBuild,
    handleStartTest,
    handleStartFlow,
    handlePollTaskStatus,
    handleGetTaskResult,
    handleCancelTask,
    handleListTasks,
    setMcpServer,
} from './handlers.js';
import { taskRegistry } from './tasks/registry.js';

import {
    handleListActiveSessions,
    handleListActiveMocks,
    handleForceCleanupSession,
    handleForceCleanupMocks,
    handleAuditState,
    handleForceCleanupArtifacts,
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
            'Begin recording a mobile interaction session. Initializes session memory, monitors the UI hierarchy, and starts capturing network events. Returns a session ID to use with subsequent tool calls. During the session, drive the app via execute_ui_action (single steps) or start_flow (stored Maestro yaml). Both update the recording timeline.',
        inputSchema: StartRecordingInputSchema,
        outputSchema: StartRecordingOutputSchema,
        annotations: {
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
            'Capture the current UI element tree from a booted simulator. Works standalone (auto-targets the sole booted device) or within a recording session via sessionId. Returns a normalized accessibility tree with pixel bounds for point-based taps when selectors don\'t match. Use interactiveOnly to filter to tappable elements.',
        inputSchema: GetUIHierarchyInputSchema,
        outputSchema: GetUIHierarchyOutputSchema,
        annotations: {
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
            'Dispatch a UI action (tap, type, scroll, etc.) on a target element. Logs the interaction to session memory for later test synthesis. Selector priority: id > accessibilityLabel > text. Scroll/swipe are not supported during a live recording session — use start_flow for complex sequences.',
        inputSchema: ExecuteUIActionInputSchema,
        outputSchema: ExecuteUIActionOutputSchema,
        annotations: {
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
            'Discover named Maestro flows in a flows directory (default: ./flows). Each flow is a .yaml file; an optional _manifest.json adds descriptions, tags, and parameter specs. Use start_flow to execute one by name.',
        inputSchema: ListFlowsInputSchema,
        outputSchema: ListFlowsOutputSchema,
        annotations: {
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

// ── 13a. start_build ──
server.registerTool(
    TOOL_NAMES.START_BUILD,
    {
        title: 'Start Build (Async)',
        description:
            'Compile an iOS or Android app from source (xcodebuild or gradlew). Returns a taskId immediately; poll via poll_task_status, get final .app/.apk path + bundleId via get_task_result. Default timeout 15 min.',
        inputSchema: StartBuildInputSchema,
        outputSchema: StartBuildOutputSchema,
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleStartBuild(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 13a-test. start_test ──
server.registerTool(
    TOOL_NAMES.START_TEST,
    {
        title: 'Start Test (Async)',
        description:
            'Run a Maestro YAML test file with optional WireMock stub replay. Replays a static script against a booted simulator — does NOT record new network traffic. Returns a taskId; poll_task_status streams live output, get_task_result returns final pass/fail. With MCA_FLOW_PAUSE_RESUME=on, pauses any active recording for the run and auto-resumes; otherwise errors if a session is active. cancel_task interrupts mid-flow.',
        inputSchema: StartTestInputSchema,
        outputSchema: StartTestOutputSchema,
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleStartTest(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 13a-flow. start_flow ──
server.registerTool(
    TOOL_NAMES.START_FLOW,
    {
        title: 'Start Flow (Async)',
        description:
            'Execute a named Maestro flow (resolves <flowsDir>/<name>.yaml and merges manifest param defaults with caller params). Use to navigate to the area of an incremental change before verifying it. Returns a taskId; poll_task_status streams output, get_task_result returns final pass/fail. With MCA_FLOW_PAUSE_RESUME=on, pauses any active recording for the run and auto-resumes; otherwise errors if a session is active. cancel_task interrupts mid-flow.',
        inputSchema: StartFlowInputSchema,
        outputSchema: StartFlowOutputSchema,
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleStartFlow(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 13b. poll_task_status ──
server.registerTool(
    TOOL_NAMES.POLL_TASK_STATUS,
    {
        title: 'Poll Task Status',
        description:
            'Returns current status, duration, and the recent tail of streamed output for a task. Cheap; safe to call frequently. Returns notFound:true for unknown or pruned task IDs (never throws).',
        inputSchema: PollTaskStatusInputSchema,
        outputSchema: PollTaskStatusOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handlePollTaskStatus(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 13c. get_task_result ──
server.registerTool(
    TOOL_NAMES.GET_TASK_RESULT,
    {
        title: 'Get Task Result',
        description:
            'Returns the final structured result for a completed task. Returns error/notFound for not-yet-done or unknown tasks. Idempotent — does not consume the task.',
        inputSchema: GetTaskResultInputSchema,
        outputSchema: GetTaskResultOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleGetTaskResult(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 13d. cancel_task ──
server.registerTool(
    TOOL_NAMES.CANCEL_TASK,
    {
        title: 'Cancel Task',
        description:
            'Aborts a running task: sends SIGTERM to children, runs registered cleanups in reverse order, marks the task cancelled. Idempotent and never throws.',
        inputSchema: CancelTaskInputSchema,
        outputSchema: CancelTaskOutputSchema,
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
    async (args) => {
        const result = await handleCancelTask(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

// ── 13e. list_tasks ──
server.registerTool(
    TOOL_NAMES.LIST_TASKS,
    {
        title: 'List Tasks',
        description:
            'Lists tasks in the registry, optionally filtered by kind/status. Useful for orphan recovery alongside list_active_sessions.',
        inputSchema: ListTasksInputSchema,
        outputSchema: ListTasksOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async (args) => {
        const result = await handleListTasks(args);
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
            'Boot an iOS simulator by UDID and wait for it to be fully ready. Idempotent — returns alreadyBooted=true if already running. Opens Simulator.app by default. Android emulator booting is not yet supported (start it manually).',
        inputSchema: BootSimulatorInputSchema,
        outputSchema: BootSimulatorOutputSchema,
        annotations: {
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
            'Capture a PNG of the current simulator/emulator screen; returns an absolute path the agent can read back. Auto-retries on transient failures; returns passed:false on terminal failure instead of throwing.',
        inputSchema: TakeScreenshotInputSchema,
        outputSchema: TakeScreenshotOutputSchema,
        annotations: {
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
            'Run the unit-test target for the project. Returns structured results: pass/fail counts, failing test names, first-line failure messages. Long-running — default timeout 30 minutes.',
        inputSchema: RunUnitTestsInputSchema,
        outputSchema: RunUnitTestsOutputSchema,
        annotations: {
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
            'Install a live response-mocking rule via Proxyman. Two modes: staticResponse (return a verbatim payload — feature flags, fixtures) and responseTransform.jsonPatch (proxy to the real backend then mutate the response body in flight — e.g. the loginStatus override pattern). Session-scoped mocks auto-clean on stop_and_compile_test; standalone mocks persist until explicitly cleared. Requires Proxyman running with MCP enabled.',
        inputSchema: SetMockResponseInputSchema,
        outputSchema: SetMockResponseOutputSchema,
        annotations: {
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
            'Remove mocks installed by set_mock_response. Pass mockId to remove one; omit to clear all mocks for the session. stop_and_compile_test runs this implicitly on session end.',
        inputSchema: ClearMockResponsesInputSchema,
        outputSchema: ClearMockResponsesOutputSchema,
        annotations: {
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

// ──────────────────────────────────────────────
// Admin / orphan-recovery tools (env-gated)
// ──────────────────────────────────────────────
//
// These six tools are operator escape hatches for stuck sessions, drifted
// mocks, and on-disk artifacts. They are not part of the AI agent's normal
// flow — set MCA_ADMIN_TOOLS=1 to expose them on the MCP surface (e.g. for
// human operators driving recovery via Claude). Default-off keeps the
// agent-facing tool catalog focused on the recording / control verbs.

if (process.env.MCA_ADMIN_TOOLS === '1') {
    // ── list_active_sessions ──
    server.registerTool(
        TOOL_NAMES.LIST_ACTIVE_SESSIONS,
        {
            title: 'List Active Sessions',
            description:
                'Inventory of recording sessions, with driver/poller liveness and mock count per session. Read-only — use this to find orphaned state before deciding whether to call force_cleanup_session.',
            inputSchema: ListActiveSessionsInputSchema,
            outputSchema: ListActiveSessionsOutputSchema,
            annotations: {
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

    // ── list_active_mocks ──
    server.registerTool(
        TOOL_NAMES.LIST_ACTIVE_MOCKS,
        {
            title: 'List Active Mocks',
            description:
                'Inspect Proxyman scripting rules tagged "mca:". Reports drift between the local ledger and Proxyman state (rules-not-in-ledger, ledger-not-in-Proxyman) so the caller can spot leaks. Returns proxymanReachable=false instead of throwing when Proxyman MCP is unavailable.',
            inputSchema: ListActiveMocksInputSchema,
            outputSchema: ListActiveMocksOutputSchema,
            annotations: {
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

    // ── force_cleanup_session (destructive) ──
    server.registerTool(
        TOOL_NAMES.FORCE_CLEANUP_SESSION,
        {
            title: 'Force-Cleanup Session',
            description:
                'Tear down a stuck session: stop polling, stop the driver, delete its tagged Proxyman rules, mark the session aborted. Never throws — partial-failure detail comes back in the errors[] array. Does NOT kill the simulator (only state we created).',
            inputSchema: ForceCleanupSessionInputSchema,
            outputSchema: ForceCleanupSessionOutputSchema,
            annotations: {
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

    // ── force_cleanup_mocks (destructive) ──
    server.registerTool(
        TOOL_NAMES.FORCE_CLEANUP_MOCKS,
        {
            title: 'Force-Cleanup Mocks',
            description:
                'Bulk delete Proxyman scripting rules by scope: "all" (everything tagged mca:), "session" (one session, requires sessionId), or "standalone". Local ledgers are reconciled. Never throws — failures surface in errors[].',
            inputSchema: ForceCleanupMocksInputSchema,
            outputSchema: ForceCleanupMocksOutputSchema,
            annotations: {
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

    // ── audit_state (read-only) ──
    server.registerTool(
        TOOL_NAMES.AUDIT_STATE,
        {
            title: 'Audit State',
            description:
                'Single-shot snapshot of session/driver/poller/Proxyman state, plus a small orphans report (Proxyman rules without a known session, sessions in recording without a driver, pollers without a session). Use as the entry point when something looks wrong.',
            inputSchema: AuditStateInputSchema,
            outputSchema: AuditStateOutputSchema,
            annotations: {
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

    // ── force_cleanup_artifacts (destructive) ──
    server.registerTool(
        TOOL_NAMES.FORCE_CLEANUP_ARTIFACTS,
        {
            title: 'Force-Cleanup Artifacts',
            description:
                'Remove accumulated debug-output directories, screenshots, and other on-disk artifacts older than olderThanHours (default 24). Scoped to one session if sessionId is given; otherwise scans all sessions. Use dryRun:true to preview without deleting. Never throws — partial failures surface in errors[].',
            inputSchema: ForceCleanupArtifactsInputSchema,
            outputSchema: ForceCleanupArtifactsOutputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (args) => {
            const result = await handleForceCleanupArtifacts(args);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                structuredContent: result,
            };
        }
    );

    console.error('[mobile-automator-mcp] Admin tools enabled (MCA_ADMIN_TOOLS=1)');
}

// ──────────────────────────────────────────────
// Transport & Start
// ──────────────────────────────────────────────

async function main() {
    await sessionManager.initialize();
    console.error('[mobile-automator-mcp] Session Database initialized');

    // Start the periodic prune of finished tasks (TTL via MCA_TASK_TTL_MS,
    // default 1h). Tests don't call this so they stay deterministic.
    taskRegistry.startPruneTimer();

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
