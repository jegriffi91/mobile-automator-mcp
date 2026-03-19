/**
 * Zod schemas for all MCP tool inputs AND outputs.
 *
 * This file is the SINGLE SOURCE OF TRUTH for tool I/O shapes.
 * TypeScript types are derived via z.infer — never duplicate them manually.
 */

import { z } from 'zod';

// ──────────────────────────────────────────────
// Shared sub-schemas
// ──────────────────────────────────────────────

const BoundsSchema = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
});

const UIElementSchema = z.object({
    id: z.string().optional().describe('Accessibility ID / testID (highest priority selector)'),
    accessibilityLabel: z.string().optional().describe('Accessibility label (mid-priority selector)'),
    text: z.string().optional().describe('Visible text (lowest priority selector)'),
    bounds: BoundsSchema.optional().describe('Bounding box coordinates as a fallback'),
});

const NetworkEventSchema = z.object({
    id: z.number().optional(),
    sessionId: z.string(),
    timestamp: z.string(),
    method: z.string(),
    url: z.string(),
    statusCode: z.number(),
    requestBody: z.string().optional(),
    responseBody: z.string().optional(),
    durationMs: z.number().optional(),
});

const UIHierarchyNodeSchema: z.ZodType<UIHierarchyNodeShape> = z.lazy(() =>
    z.object({
        id: z.string().optional(),
        testId: z.string().optional(),
        accessibilityLabel: z.string().optional(),
        text: z.string().optional(),
        role: z.string(),
        children: z.array(UIHierarchyNodeSchema),
        structuralHash: z.string().optional().describe('Pre-computed structural hash for O(1) tree equality comparison'),
    })
);

// Helper type for the recursive schema
interface UIHierarchyNodeShape {
    id?: string;
    testId?: string;
    accessibilityLabel?: string;
    text?: string;
    role: string;
    children: UIHierarchyNodeShape[];
    structuralHash?: string;
}

// ──────────────────────────────────────────────
// Tool Input Schemas
// ──────────────────────────────────────────────

export const StartRecordingInputSchema = z.object({
    appBundleId: z
        .string()
        .describe('The bundle identifier of the app to record (e.g., com.example.MyApp)'),
    platform: z
        .enum(['ios', 'android'])
        .describe('The target mobile platform'),
    sessionName: z.string().optional().describe('Optional human-readable name for this session'),
    filterDomains: z
        .array(z.string())
        .optional()
        .describe(
            'Optional domain list for Proxyman traffic isolation (e.g., ["localhost.proxyman.io:3031"]). Enables concurrent sessions on different ports.'
        ),
    captureMode: z
        .enum(['event-triggered', 'polling'])
        .optional()
        .describe(
            'Hierarchy capture fidelity. "event-triggered" (default) captures pre/post-action snapshots with settle detection. "polling" captures at a fixed interval for high-fidelity transient state recording.'
        ),
    pollingIntervalMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Polling interval in ms when captureMode is "polling" (default: 500)'),
    settleTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('How long to wait for the UI to stabilize after an action, in ms (default: 3000)'),
    trackEventPaths: z
        .array(z.string())
        .optional()
        .describe(
            'URL path patterns for network-based interaction tracking (e.g., ["/__track"]). When the app POSTs to matching paths, the events are extracted as user interactions during compilation.'
        ),
    timeouts: z
        .object({
            hierarchyDumpMs: z.number().int().positive().optional()
                .describe('Timeout for hierarchy dump calls (ms). Default: 15000'),
            hierarchyLiteMs: z.number().int().positive().optional()
                .describe('Timeout for lightweight/polling hierarchy calls (ms). Default: 10000'),
            actionMs: z.number().int().positive().optional()
                .describe('Timeout for single UI action execution (ms). Default: 15000'),
            testRunMs: z.number().int().positive().optional()
                .describe('Timeout for full test run (ms). Default: 120000'),
            setupValidationMs: z.number().int().positive().optional()
                .describe('Timeout for setup validation calls (ms). Default: 5000'),
            daemonRequestMs: z.number().int().positive().optional()
                .describe('Timeout for daemon JSON-RPC requests (ms). Default: 15000'),
            daemonShutdownMs: z.number().int().positive().optional()
                .describe('Timeout for daemon graceful shutdown (ms). Default: 3000'),
        })
        .optional()
        .describe('Optional timeout overrides. All values merge with defaults — only override what you need.'),
});

export const StopAndCompileInputSchema = z.object({
    sessionId: z.string().describe('The session ID returned by start_recording_session'),
    outputPath: z
        .string()
        .optional()
        .describe('Absolute path where the generated .yaml file should be written'),
    conditions: z
        .array(z.string())
        .optional()
        .describe(
            'Optional natural-language assertions to include, e.g. "verify analytics event: page_view"'
        ),
    mockingConfig: z
        .object({
            mode: z.enum(['full', 'include', 'exclude']).describe(
                'full = mock all captured APIs; include = mock only listed routes; exclude = mock all except listed'
            ),
            routes: z
                .array(z.string())
                .optional()
                .describe('Route path patterns to include or exclude (e.g., ["/api/login"])'),
            proxyBaseUrl: z
                .string()
                .optional()
                .describe('Real server URL for proxy passthrough on non-mocked routes'),
        })
        .optional()
        .describe('Network mocking configuration for WireMock stub generation'),
});

export const GetUIHierarchyInputSchema = z.object({
    sessionId: z
        .string()
        .optional()
        .describe('Active session ID. If omitted, auto-targets the sole booted simulator.'),
    interactiveOnly: z
        .boolean()
        .optional()
        .describe(
            'If true, return only elements with id, label, or text — stripping non-interactive nodes.'
        ),
    compact: z
        .boolean()
        .optional()
        .describe(
            'If true, collapse single-child chains and strip anonymous containers to reduce tree depth.'
        ),
    includeRawOutput: z
        .boolean()
        .optional()
        .describe(
            'If true, include the raw CLI/daemon output string in the response (default: omitted to save context).'
        ),
    artifactPath: z
        .string()
        .optional()
        .describe(
            'If set, write the full hierarchy JSON to this file path and return only a summary with node count.'
        ),
});

export const ListDevicesInputSchema = z.object({
    platform: z
        .enum(['ios', 'android'])
        .optional()
        .describe(
            'Filter by platform. If omitted, returns both iOS simulators and Android emulators.'
        ),
    state: z
        .enum(['Booted', 'Shutdown'])
        .optional()
        .describe('Filter by device state. If omitted, returns all states.'),
    osVersionContains: z
        .string()
        .optional()
        .describe(
            'Filter iOS runtimes containing this string (e.g., "18" for iOS 18.x).'
        ),
});

export const ExecuteUIActionInputSchema = z.object({
    sessionId: z.string().describe('Active session ID'),
    action: z
        .enum(['tap', 'type', 'scroll', 'swipe', 'back', 'assertVisible'])
        .describe('The UI action to perform'),
    element: UIElementSchema.describe('Target UI element to act on'),
    textInput: z
        .string()
        .optional()
        .describe('Text to type (required when action is "type")'),
});

export const GetNetworkLogsInputSchema = z.object({
    sessionId: z.string().describe('Active or completed session ID'),
    filterPath: z
        .string()
        .optional()
        .describe('Optional URL substring to filter logs (e.g., "/api/sdui")'),
    filterDomains: z
        .array(z.string())
        .optional()
        .describe('Optional list of domains to capture (e.g., ["api.myapp.com"]). Reduces Proxyman noise.'),
    limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of log entries to return (default: 50)'),
});

export const VerifySDUIPayloadInputSchema = z.object({
    sessionId: z.string().describe('Active or completed session ID'),
    url: z.string().describe('The full URL of the SDUI endpoint to verify'),
    filterDomains: z
        .array(z.string())
        .optional()
        .describe('Optional list of domains to pre-filter the Proxyman HAR export (e.g., ["api.myapp.com"])'),
    expectedFields: z
        .record(z.unknown())
        .optional()
        .describe('Key-value pairs that must be present in the response payload'),
});

export const RegisterSegmentInputSchema = z.object({
    name: z.string().describe('Human-readable segment name (e.g., "login", "navigate-to-settings")'),
    sessionId: z.string().describe('Session ID whose correlated steps define this segment'),
    registryPath: z
        .string()
        .optional()
        .describe('Path to registry.json (defaults to ./segments/registry.json)'),
});

export const RunTestInputSchema = z.object({
    yamlPath: z.string().describe('Path to the Maestro YAML test file'),
    stubsDir: z
        .string()
        .optional()
        .describe('Path to WireMock stubs root directory (session-xxx/wiremock/) containing mappings/ and __files/ subdirectories. If provided, a stub server is started automatically.'),
    platform: z
        .enum(['ios', 'android'])
        .optional()
        .describe('Target platform (default: ios)'),
    stubServerPort: z
        .number()
        .optional()
        .describe('Port for the stub server (default: auto-select available port)'),
    env: z
        .record(z.string())
        .optional()
        .describe(
            'Environment variables passed to Maestro via -e KEY=VALUE flags (e.g., { "APP_ID": "io.appcision.project-doombot" })'
        ),
    profiling: z
        .object({
            template: z
                .enum(['time-profiler', 'allocations', 'app-launch', 'memory-snapshot'])
                .describe('Profiling template to use during the test run'),
            timeLimitSeconds: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Max profiling duration in seconds. Defaults to test duration.'),
            outputDir: z
                .string()
                .optional()
                .describe('Directory for raw trace files. Defaults to os.tmpdir().'),
            cleanupTrace: z
                .boolean()
                .optional()
                .describe('Delete raw trace after extracting metrics (default: true)'),
        })
        .optional()
        .describe(
            'Optional performance profiling configuration. When provided, an xctrace (iOS) or dumpsys (Android) ' +
            'profiling session runs in parallel with the test. Results are returned as structured metrics.'
        ),
});

// ──────────────────────────────────────────────
// Tool Output Schemas
// ──────────────────────────────────────────────

export const StartRecordingOutputSchema = z.object({
    sessionId: z.string().describe('Unique ID for the recording session'),
    message: z.string().describe('Human-readable status message'),
    readiness: z.object({
        driverReady: z.boolean().describe('Whether the Maestro automation driver started successfully'),
        baselineCaptured: z.boolean().describe('Whether the Proxyman network baseline was captured (false if Proxyman unavailable)'),
        pollerStarted: z.boolean().describe('Whether the passive hierarchy poller started (captures UI changes)'),
    }).optional().describe('Readiness checkpoint — indicates whether the session is fully armed for recording. Wait for all fields to be true before interacting with the app for best results.'),
});

export const StopAndCompileOutputSchema = z.object({
    sessionId: z.string().describe('The session that was compiled'),
    yaml: z.string().describe('The generated Maestro YAML test script content'),
    yamlPath: z.string().describe('File path where the YAML was written'),
    fixturesDir: z.string().optional().describe('Directory containing WireMock response fixtures'),
    stubsDir: z.string().optional().describe('WireMock stubs root directory containing mappings/ and __files/ subdirectories'),
    manifestPath: z.string().optional().describe('Path to the session manifest JSON'),
    segmentFingerprint: z
        .string()
        .optional()
        .describe('SHA-256 fingerprint of the action+endpoint sequence for deduplication'),
    matchedSegments: z
        .array(
            z.object({
                name: z.string(),
                fingerprint: z.string(),
                similarity: z.number(),
                yamlPath: z.string(),
            })
        )
        .optional()
        .describe('Existing registered segments that match this recording'),
    pollingDiagnostics: z
        .object({
            pollCount: z.number().describe('Total number of polling attempts'),
            successCount: z.number().describe('Number of successful hierarchy reads'),
            errorCount: z.number().describe('Number of failed hierarchy reads'),
            inferredCount: z.number().describe('Number of interactions inferred from diffs'),
            lastError: z.string().optional().describe('Most recent polling error message'),
            elapsedMs: z.number().optional().describe('Milliseconds since polling started'),
            expectedPolls: z.number().optional().describe('Expected poll count based on elapsed time'),
            actualPollingRateMs: z.number().optional().describe('Average actual polling interval (ms)'),
            configuredPollingRateMs: z.number().optional().describe('Configured polling interval (ms)'),
            equalTreeCount: z
                .number()
                .optional()
                .describe('Polls where hierarchy was identical to previous (no diff needed)'),
            thresholdExceededCount: z
                .number()
                .optional()
                .describe('Diffs exceeding maxChangesThreshold (discarded as full-screen transitions)'),
            diffButNullInferenceCount: z
                .number()
                .optional()
                .describe('Diffs with changes but no identifiable elements for inference'),
            baselineElementCount: z
                .number()
                .optional()
                .describe('Number of identifiable elements in the baseline hierarchy snapshot'),
        })
        .optional()
        .describe('Health diagnostics from the passive capture polling loop'),
    timelinePath: z
        .string()
        .optional()
        .describe('Path to the session timeline JSON file for post-hoc debugging'),
});

export const RegisterSegmentOutputSchema = z.object({
    name: z.string().describe('Registered segment name'),
    fingerprint: z.string().describe('Segment fingerprint'),
    registryPath: z.string().describe('Path to the registry file'),
    message: z.string().describe('Human-readable confirmation message'),
});

const ProfilingMetricsSchema = z.object({
    platform: z.enum(['ios', 'android']),
    cpuUsagePercent: z
        .number()
        .optional()
        .describe('Average CPU usage percentage during profiling (0-100)'),
    peakMemoryMb: z
        .number()
        .optional()
        .describe('Peak memory usage in MB'),
    memoryFootprintMb: z
        .number()
        .optional()
        .describe('Total memory footprint in MB'),
    launchTimeMs: z
        .number()
        .optional()
        .describe('App launch time in ms (app-launch template only)'),
    peakCpuPercent: z
        .number()
        .optional()
        .describe('Peak CPU usage percentage during profiling (0-100)'),
    sampleCount: z
        .number()
        .int()
        .optional()
        .describe('Number of profiling samples collected (lightweight sampling mode)'),
    profilingDurationMs: z.number().describe('Total profiling duration in ms'),
    rawTracePath: z
        .string()
        .optional()
        .describe('Path to raw trace file for manual inspection in Instruments/Perfetto UI'),
    warnings: z
        .array(z.string())
        .describe('Informational warnings (e.g., simulator accuracy caveats)'),
});

export const RunTestOutputSchema = z.object({
    passed: z.boolean().describe('Whether the Maestro test passed'),
    output: z.string().describe('Maestro CLI stdout/stderr output'),
    stubServerPort: z.number().optional().describe('Port the stub server ran on (if stubs were used)'),
    durationMs: z.number().describe('Total test execution time in milliseconds'),
    profiling: ProfilingMetricsSchema.optional().describe(
        'Performance metrics from the profiling session (only present when profiling was requested)'
    ),
});

export const GetUIHierarchyOutputSchema = z.object({
    hierarchy: UIHierarchyNodeSchema.describe('Normalized UI element tree'),
    rawOutput: z
        .string()
        .optional()
        .describe(
            'Raw output from the automation backend (CSV from daemon, JSON from CLI). Only included when includeRawOutput is true.'
        ),
    nodeCount: z.number().optional().describe('Total number of nodes in the hierarchy tree.'),
    artifactPath: z
        .string()
        .optional()
        .describe('Path where the full hierarchy was written, if artifactPath was specified.'),
});

const DeviceInfoSchema = z.object({
    platform: z.enum(['ios', 'android']),
    udid: z.string(),
    name: z.string(),
    state: z.string(),
    osVersion: z.string().optional().describe('iOS runtime version (e.g., "iOS 18.1")'),
    isAvailable: z.boolean().optional(),
});

export const ListDevicesOutputSchema = z.object({
    devices: z.array(DeviceInfoSchema).describe('List of discovered simulators/emulators'),
    total: z.number().describe('Number of devices returned'),
});

export const ExecuteUIActionOutputSchema = z.object({
    success: z.boolean().describe('Whether the action was dispatched successfully'),
    message: z.string().describe('Human-readable result message'),
});

export const GetNetworkLogsOutputSchema = z.object({
    events: z.array(NetworkEventSchema).describe('Matching network transactions'),
    total: z.number().describe('Total number of matching events'),
});

export const VerifySDUIPayloadOutputSchema = z.object({
    matched: z.boolean().describe('Whether all expected fields matched the actual response'),
    actual: z.record(z.unknown()).optional().describe('The actual response payload'),
    mismatches: z
        .array(z.string())
        .optional()
        .describe('List of field paths that did not match expectations'),
});

// ── get_session_timeline input/output schemas ──

export const GetSessionTimelineInputSchema = z.object({
    sessionId: z.string().describe('Active session ID to get timeline for'),
});

export const GetSessionTimelineOutputSchema = z.object({
    sessionId: z.string().describe('The session this timeline belongs to'),
    status: z.string().describe('Current session status'),
    elapsedMs: z.number().optional().describe('Milliseconds since recording started'),
    pollSummary: z.object({
        totalPolls: z.number().describe('Total polling attempts'),
        byResult: z.record(z.string(), z.number()).describe('Poll count by result type'),
        starvationPeriods: z.number().describe('Gaps exceeding 2× configured interval'),
        configuredIntervalMs: z.number().describe('Configured polling interval'),
        actualAverageMs: z.number().optional().describe('Average actual interval'),
    }).describe('Aggregate polling statistics'),
    interactionSummary: z.object({
        total: z.number().describe('Total interactions logged'),
        bySource: z.record(z.string(), z.number()).describe('Count by source type'),
    }).describe('Interaction capture statistics'),
    gaps: z.array(z.object({
        from: z.string().describe('Start of the gap'),
        to: z.string().describe('End of the gap'),
        durationMs: z.number().describe('Gap duration in milliseconds'),
        reason: z.string().describe('Cause of the gap'),
    })).describe('Polling gaps where interactions may have been missed'),
    recentPolls: z.array(z.object({
        timestamp: z.string(),
        durationMs: z.number(),
        result: z.string(),
        inferredTarget: z.string().optional(),
    })).describe('Most recent 10 poll records for quick inspection'),
});

// ──────────────────────────────────────────────
// Derived TypeScript types (single source of truth)
// ──────────────────────────────────────────────

export type StartRecordingInput = z.infer<typeof StartRecordingInputSchema>;
export type StartRecordingOutput = z.infer<typeof StartRecordingOutputSchema>;

export type StopAndCompileInput = z.infer<typeof StopAndCompileInputSchema>;
export type StopAndCompileOutput = z.infer<typeof StopAndCompileOutputSchema>;

export type GetUIHierarchyInput = z.infer<typeof GetUIHierarchyInputSchema>;
export type GetUIHierarchyOutput = z.infer<typeof GetUIHierarchyOutputSchema>;

export type ExecuteUIActionInput = z.infer<typeof ExecuteUIActionInputSchema>;
export type ExecuteUIActionOutput = z.infer<typeof ExecuteUIActionOutputSchema>;

export type GetNetworkLogsInput = z.infer<typeof GetNetworkLogsInputSchema>;
export type GetNetworkLogsOutput = z.infer<typeof GetNetworkLogsOutputSchema>;

export type VerifySDUIPayloadInput = z.infer<typeof VerifySDUIPayloadInputSchema>;
export type VerifySDUIPayloadOutput = z.infer<typeof VerifySDUIPayloadOutputSchema>;

export type RegisterSegmentInput = z.infer<typeof RegisterSegmentInputSchema>;
export type RegisterSegmentOutput = z.infer<typeof RegisterSegmentOutputSchema>;

export type RunTestInput = z.infer<typeof RunTestInputSchema>;
export type RunTestOutput = z.infer<typeof RunTestOutputSchema>;

export type ListDevicesInput = z.infer<typeof ListDevicesInputSchema>;
export type ListDevicesOutput = z.infer<typeof ListDevicesOutputSchema>;

export type GetSessionTimelineInput = z.infer<typeof GetSessionTimelineInputSchema>;
export type GetSessionTimelineOutput = z.infer<typeof GetSessionTimelineOutputSchema>;

// ──────────────────────────────────────────────
// Tool name constants
// ──────────────────────────────────────────────

export const TOOL_NAMES = {
    START_RECORDING: 'start_recording_session',
    STOP_AND_COMPILE: 'stop_and_compile_test',
    GET_UI_HIERARCHY: 'get_ui_hierarchy',
    EXECUTE_UI_ACTION: 'execute_ui_action',
    GET_NETWORK_LOGS: 'get_network_logs',
    VERIFY_SDUI_PAYLOAD: 'verify_sdui_payload',
    REGISTER_SEGMENT: 'register_segment',
    RUN_TEST: 'run_test',
    LIST_DEVICES: 'list_devices',
    GET_SESSION_TIMELINE: 'get_session_timeline',
} as const;
