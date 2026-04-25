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

const PointSchema = z.object({
    x: z.number(),
    y: z.number(),
});

const UIElementSchema = z.object({
    id: z.string().optional().describe('Accessibility ID / testID (highest priority selector)'),
    accessibilityLabel: z.string().optional().describe('Accessibility label (mid-priority selector)'),
    text: z.string().optional().describe('Visible text (lowest priority selector)'),
    bounds: BoundsSchema.optional().describe('Bounding box coordinates as a fallback'),
    point: PointSchema
        .optional()
        .describe(
            'Absolute {x,y} point selector — required for custom controls (e.g. Bureau tabs) that ignore accessibility-based taps. Takes precedence over all other selectors.',
        ),
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

// ── Shared sub-schemas for verify_network_* tools ──

const NetworkMatcherSchema = z.object({
    pathContains: z.string().optional().describe('Substring match on the URL'),
    operationMatches: z
        .string()
        .optional()
        .describe('Regex matched against the GraphQL operationName (falls back to raw requestBody)'),
    statusCode: z.number().int().optional().describe('Exact HTTP status code'),
    bodyContains: z.string().optional().describe('Substring match on the response body'),
    requestBodyContains: z.string().optional().describe('Substring match on the request body'),
    method: z.string().optional().describe('HTTP method (case-insensitive, e.g., "POST")'),
});

const AfterActionRefSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('timestamp'),
        value: z.string().describe('ISO-8601 timestamp to anchor the window to'),
    }),
    z.object({
        kind: z.literal('index'),
        value: z.number().int().nonnegative().describe('0-based index into the session\'s interactions'),
    }),
    z.object({
        kind: z.literal('elementText'),
        value: z.string().describe('Case-insensitive substring match against UIInteraction.element (id/testId/accessibilityLabel/text)'),
    }),
]).describe('Reference a prior UI action to anchor the time window');

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
            driverCooldownMs: z.number().int().nonnegative().optional()
                .describe(
                    'iOS-only: pause after uninstalling the XCTest driver to let port 7001 drain (ms). ' +
                    'Default: 3000. Only applies on the uninstall path — a healthy driver is reused without cooldown.',
                ),
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
        .enum([
            'tap', 'type', 'inputText', 'scroll', 'swipe',
            'scrollUntilVisible', 'swipeUntilVisible', 'back', 'assertVisible',
        ])
        .describe(
            'The UI action to perform. ' +
            '"type" taps the element first then types — fails on iOS secure text fields where the tap can drop focus. ' +
            'Use "inputText" instead to type into the already-focused field with no preceding tap (matches Maestro\'s native `inputText` YAML command, the only reliable path for secure password fields). ' +
            'For inputText, the element field is optional and ignored.',
        ),
    element: UIElementSchema.optional().describe(
        'Target UI element to act on. Required for tap/type/scroll/swipe/etc. Ignored when action is "inputText" ' +
        '(typing happens against whatever field currently holds focus).',
    ),
    textInput: z
        .string()
        .optional()
        .describe('Text to type (required when action is "type" or "inputText")'),
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

// ──────────────────────────────────────────────
// verify_network_* input schemas
// ──────────────────────────────────────────────

const VerifyCommonFields = {
    sessionId: z.string().describe('Active or completed session ID'),
    filterDomains: z.array(z.string()).optional().describe('Optional Proxyman domain filter'),
};

export const VerifyNetworkParallelismInputSchema = z.object({
    ...VerifyCommonFields,
    matcher: NetworkMatcherSchema.describe('Predicate selecting requests to test for parallelism'),
    maxWindowMs: z
        .number()
        .int()
        .positive()
        .describe('All matching requests must START within this window, in milliseconds'),
    minExpectedCount: z
        .number()
        .int()
        .positive()
        .describe('Fail if fewer than this many requests fall inside the window'),
});

export const VerifyNetworkOnScreenInputSchema = z.object({
    ...VerifyCommonFields,
    afterAction: AfterActionRefSchema,
    withinMs: z
        .number()
        .int()
        .positive()
        .default(3000)
        .describe('Look at network traffic within this many milliseconds of the anchor (default 3000, matches the Correlator window)'),
    expectedCalls: z
        .array(NetworkMatcherSchema)
        .describe('Every matcher in this list must find at least one event in the window'),
});

export const VerifyNetworkAbsentInputSchema = z.object({
    ...VerifyCommonFields,
    afterAction: AfterActionRefSchema,
    withinMs: z.number().int().positive().default(3000),
    forbiddenCalls: z
        .array(NetworkMatcherSchema)
        .describe('No matcher in this list may find any event in the window'),
});

export const VerifyNetworkSequenceInputSchema = z.object({
    ...VerifyCommonFields,
    afterAction: AfterActionRefSchema.optional(),
    withinMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional window around afterAction; omit to scan all session traffic'),
    matcher: NetworkMatcherSchema.optional().describe('Optional pre-filter applied before ordering'),
    expectedOrder: z
        .array(NetworkMatcherSchema)
        .describe('Matchers that must fire in this chronological order'),
    strict: z
        .boolean()
        .default(false)
        .describe('If true, no un-matched events may appear between ordered matches'),
});

export const VerifyNetworkPerformanceInputSchema = z.object({
    ...VerifyCommonFields,
    matcher: NetworkMatcherSchema.describe('Predicate selecting requests to measure'),
    afterAction: AfterActionRefSchema.optional(),
    withinMs: z.number().int().positive().optional(),
    maxIndividualMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Each matching request must complete within this many milliseconds'),
    maxTotalMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('First request start → last request end must be within this many milliseconds'),
});

const PayloadAssertionSchema = z.object({
    path: z
        .string()
        .describe('Dot/bracket path into the JSON response (e.g., "data.items[0].type")'),
    equals: z.unknown().optional().describe('Value must equal this (deep compare)'),
    contains: z
        .string()
        .optional()
        .describe('String value must contain this substring (stringified for non-strings)'),
    exists: z
        .boolean()
        .optional()
        .describe('If true, the path must resolve; if false, it must not'),
    type: z
        .enum(['string', 'number', 'boolean', 'object', 'array', 'null'])
        .optional()
        .describe('Value must be of this JSON type'),
    minLength: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('For arrays/strings: length must be at least this'),
});

export const VerifyNetworkPayloadInputSchema = z.object({
    ...VerifyCommonFields,
    url: z.string().optional().describe('Exact or partial URL; use this OR matcher'),
    matcher: NetworkMatcherSchema.optional().describe('Matcher to locate the event; use this OR url'),
    responseAssertions: z
        .array(PayloadAssertionSchema)
        .describe('Path-based assertions to evaluate on the response body'),
});

export const VerifyNetworkDeduplicationInputSchema = z.object({
    ...VerifyCommonFields,
    matcher: NetworkMatcherSchema.optional(),
    afterAction: AfterActionRefSchema.optional(),
    withinMs: z.number().int().positive().optional(),
    groupBy: z
        .enum(['url', 'operationName'])
        .default('operationName')
        .describe('Group events by URL or by extracted GraphQL operationName'),
    maxDuplicates: z
        .number()
        .int()
        .positive()
        .default(1)
        .describe('Each unique key may appear at most this many times'),
});

export const VerifyNetworkErrorHandlingInputSchema = z.object({
    ...VerifyCommonFields,
    expectedErrors: z
        .array(
            NetworkMatcherSchema.extend({
                statusCode: z
                    .number()
                    .int()
                    .describe('Expected error status code'),
            }),
        )
        .describe('Error responses that must appear in session traffic'),
    afterAction: AfterActionRefSchema.optional(),
    withinMs: z.number().int().positive().optional(),
});

export const RegisterSegmentInputSchema = z.object({
    name: z.string().describe('Human-readable segment name (e.g., "login", "navigate-to-settings")'),
    sessionId: z.string().describe('Session ID whose correlated steps define this segment'),
    registryPath: z
        .string()
        .optional()
        .describe('Path to registry.json (defaults to ./segments/registry.json)'),
});

export const BuildAppInputSchema = z.object({
    platform: z.enum(['ios', 'android']).describe('Target mobile platform'),
    workspacePath: z
        .string()
        .optional()
        .describe(
            'iOS only: Absolute path to a .xcworkspace. Takes precedence over projectPath.',
        ),
    projectPath: z
        .string()
        .optional()
        .describe(
            'Absolute path to the project. iOS: .xcodeproj (required if workspacePath omitted). ' +
            'Android: Gradle project root containing ./gradlew (required).',
        ),
    scheme: z
        .string()
        .optional()
        .describe('iOS only: Xcode scheme name. Required for iOS builds.'),
    configuration: z
        .string()
        .optional()
        .describe('iOS only: Build configuration (e.g., "Debug", "Release"). Default: "Debug".'),
    destination: z
        .string()
        .optional()
        .describe(
            'iOS only: xcodebuild -destination value. Default: "generic/platform=iOS Simulator".',
        ),
    derivedDataPath: z
        .string()
        .optional()
        .describe(
            'iOS only: Path for Xcode build artifacts. Default: tmpdir/mobile-automator-build.',
        ),
    module: z
        .string()
        .optional()
        .describe('Android only: Gradle module name. Default: "app".'),
    variant: z
        .string()
        .optional()
        .describe('Android only: Build variant (e.g., "debug", "release"). Default: "debug".'),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum build duration in ms. Default: 900000 (15 minutes).'),
});

export const InstallAppInputSchema = z.object({
    platform: z.enum(['ios', 'android']).describe('Target mobile platform'),
    deviceUdid: z.string().describe('Target device UDID (from list_devices)'),
    appPath: z
        .string()
        .describe('Absolute path to the .app bundle (iOS) or .apk file (Android) to install'),
});

export const UninstallAppInputSchema = z.object({
    platform: z.enum(['ios', 'android']).describe('Target mobile platform'),
    deviceUdid: z.string().describe('Target device UDID (from list_devices)'),
    bundleId: z
        .string()
        .describe('iOS bundle identifier or Android package name of the app to remove'),
});

export const BootSimulatorInputSchema = z.object({
    platform: z.enum(['ios', 'android']).describe('Target mobile platform (Android booting is not yet supported)'),
    deviceUdid: z.string().describe('Simulator UDID to boot (from list_devices)'),
    openSimulatorApp: z
        .boolean()
        .optional()
        .describe('iOS only: open Simulator.app to surface the UI. Default: true.'),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max wait in ms for the device to reach Booted state. Default: 120000.'),
});

export const TakeScreenshotInputSchema = z.object({
    platform: z.enum(['ios', 'android']).describe('Target mobile platform'),
    deviceUdid: z.string().describe('UDID of the booted simulator or emulator (from list_devices)'),
    outputPath: z
        .string()
        .optional()
        .describe(
            'Absolute path where the PNG should be written. If omitted, a timestamped file is created under ' +
            'tmpdir/mobile-automator-screenshots/.',
        ),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max wait in ms for the capture to complete. Default: 30000.'),
});

export const RunUnitTestsInputSchema = z.object({
    platform: z.enum(['ios', 'android']).describe('Target mobile platform'),
    workspacePath: z
        .string()
        .optional()
        .describe('iOS only: Absolute path to a .xcworkspace. Takes precedence over projectPath.'),
    projectPath: z
        .string()
        .optional()
        .describe(
            'Absolute path to the project. iOS: .xcodeproj (required if workspacePath omitted). ' +
            'Android: Gradle project root containing ./gradlew (required).',
        ),
    scheme: z
        .string()
        .optional()
        .describe('iOS only: Xcode scheme name. Required for iOS.'),
    destination: z
        .string()
        .optional()
        .describe(
            'iOS only: xcodebuild -destination value. Defaults to the iOS Simulator for the first matching runtime.',
        ),
    configuration: z
        .string()
        .optional()
        .describe('iOS only: Build configuration (e.g., "Debug", "Release"). Default: "Debug".'),
    testPlan: z
        .string()
        .optional()
        .describe('iOS only: Optional xcodebuild -testPlan name to run a specific test plan.'),
    onlyTesting: z
        .array(z.string())
        .optional()
        .describe(
            'iOS only: Array of test identifiers to restrict the run. Each entry maps to xcodebuild ' +
            '-only-testing:<Target>/<Class>[/<Method>].',
        ),
    module: z
        .string()
        .optional()
        .describe('Android only: Gradle module name. Default: "app".'),
    variant: z
        .string()
        .optional()
        .describe('Android only: Build variant (e.g., "debug", "release"). Default: "debug".'),
    gradleTask: z
        .string()
        .optional()
        .describe(
            'Android only: Explicit Gradle task (e.g., "test", "connectedCheck"). Default: ' +
            'test<Variant>UnitTest (derived from variant).',
        ),
    testFilter: z
        .string()
        .optional()
        .describe(
            'Android only: Value forwarded to `--tests` (e.g., "com.example.MyTest" or "com.example.*"). ' +
            'Omit to run all tests.',
        ),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max test-run duration in ms. Default: 1800000 (30 minutes).'),
});

export const ListFlowsInputSchema = z.object({
    flowsDir: z
        .string()
        .optional()
        .describe(
            'Directory containing flow .yaml files (default: ./flows relative to the MCP server\'s working directory). ' +
            'Optional _manifest.json in this directory adds descriptions, tags, and param specs.',
        ),
});

export const RunFlowInputSchema = z.object({
    name: z.string().describe('Flow name (the filename without the .yaml suffix)'),
    flowsDir: z
        .string()
        .optional()
        .describe('Directory containing flow .yaml files (default: ./flows)'),
    params: z
        .record(z.string())
        .optional()
        .describe(
            'Parameters forwarded to Maestro as environment variables (-e KEY=VALUE). ' +
            'Referenced inside the flow YAML as ${KEY}. Manifest-declared params with ' +
            'defaults are applied automatically when omitted.',
        ),
    platform: z
        .enum(['ios', 'android'])
        .optional()
        .describe('Target platform (default: ios)'),
    debugOutput: z
        .string()
        .optional()
        .describe('Path where Maestro should dump debug output (screenshots, hierarchies, logs)'),
    stubsDir: z
        .string()
        .optional()
        .describe(
            'Optional WireMock stubs root directory. If provided, a stub server is started for the flow run.',
        ),
    stubServerPort: z
        .number()
        .optional()
        .describe('Port for the optional stub server (default: auto-select)'),
    driverCooldownMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            'iOS-only: pause after uninstalling the XCTest driver to let port 7001 drain (default: 3000). ' +
            'Only applies on the uninstall path — a healthy driver is reused without cooldown.',
        ),
});

export const RunTestInputSchema = z.object({
    yamlPath: z.string().describe('Path to the Maestro YAML test file'),
    debugOutput: z
        .string()
        .optional()
        .describe('Path to a directory or filename where Maestro should dump debug output (screenshots, hierarchies, logs)'),
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
    driverCooldownMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            'iOS-only: pause after uninstalling the XCTest driver to let port 7001 drain (default: 3000). ' +
            'Only applies on the uninstall path — a healthy driver is reused without cooldown.',
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
// set_mock_response / clear_mock_responses — Proxyman MCP gateway
// ──────────────────────────────────────────────
//
// Per-session live response mocking, implemented as a thin gateway over the
// Proxyman MCP server. Our handler translates a structured spec into a
// JavaScript scripting rule and asks Proxyman to install it on the running
// proxy. Rules are tagged with the session ID in their display name so we can
// bulk-delete on stop_and_compile_test.

const MockMatcherSchema = z.object({
    pathContains: z.string().optional().describe('Substring match on the URL path'),
    urlPathEquals: z.string().optional().describe('Exact URL path match (no query string)'),
    method: z
        .enum(['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])
        .optional()
        .describe('HTTP method (default: ANY)'),
    requestBodyContains: z
        .string()
        .optional()
        .describe(
            'Substring match on the request body (e.g., a GraphQL operationName). ' +
            'Enforced inside the generated script — Proxyman has no native filter for this.',
        ),
    graphqlQueryName: z
        .string()
        .optional()
        .describe(
            'GraphQL operation name (translated to Proxyman\'s native graphql_query_name filter). ' +
            'More precise than requestBodyContains for GraphQL traffic.',
        ),
});

const JsonPatchOpSchema = z.object({
    op: z.enum(['replace', 'add', 'remove']).describe('RFC 6902 operation'),
    path: z.string().describe('RFC 6901 JSON Pointer (e.g., "/data/customerStatusV3/loginStatus")'),
    value: z.unknown().optional().describe('Required for replace/add; ignored for remove'),
});

const MockStaticResponseSchema = z.object({
    status: z.number().int().positive().default(200),
    jsonBody: z.unknown().optional().describe('Returned verbatim as JSON with Content-Type application/json'),
    body: z.string().optional().describe('Returned verbatim as raw text. Use jsonBody for JSON.'),
    headers: z.record(z.string()).optional(),
});

const MockResponseTransformSchema = z.object({
    jsonPatch: z
        .array(JsonPatchOpSchema)
        .describe('Applied to the JSON-decoded response body in flight'),
});

// Exported so FeatureTestSpec can declare mocks: [...] inline.
export const MockSpecSchema = z.object({
    id: z.string().optional().describe('Stable mock ID. Auto-generated if omitted.'),
    matcher: MockMatcherSchema,
    responseTransform: MockResponseTransformSchema.optional(),
    staticResponse: MockStaticResponseSchema.optional(),
}).refine(
    (m) => Boolean(m.staticResponse) !== Boolean(m.responseTransform),
    { message: 'Exactly one of staticResponse or responseTransform must be set' },
);

export const SetMockResponseInputSchema = z.object({
    sessionId: z.string().optional().describe(
        'Active recording session ID. Mocks tagged with the session auto-clean on stop_and_compile_test. ' +
        'OMIT to install a STANDALONE mock that persists until explicitly cleared via clear_mock_responses ' +
        '({ mockId } or { allStandalone: true }) — useful for agents mocking outside any recording session.',
    ),
    mock: MockSpecSchema,
});

export const SetMockResponseOutputSchema = z.object({
    mockId: z.string().describe('Stable mock ID (echoed if provided, generated if not)'),
    proxymanRuleId: z.string().describe('Proxyman rule ID, useful for direct inspection in the Proxyman UI'),
    ruleName: z.string().describe(
        'Display name of the rule in Proxyman: mca:<sessionId>:<mockId> for session-scoped, ' +
        'or mca:standalone:<mockId> for standalone.',
    ),
    scope: z.enum(['session', 'standalone']).describe(
        'Whether the mock is auto-cleaned on stop_and_compile (session) or persists (standalone)',
    ),
    totalSessionMocks: z.number().int().optional().describe(
        'Total active mocks for this session after this call. Only set when scope === "session".',
    ),
    totalStandaloneMocks: z.number().int().optional().describe(
        'Total active standalone mocks after this call. Only set when scope === "standalone".',
    ),
});

export const ClearMockResponsesInputSchema = z.object({
    sessionId: z.string().optional().describe(
        'Clear mocks scoped to this session. Pair with mockId to clear one; omit mockId to clear all session mocks.',
    ),
    mockId: z.string().optional().describe(
        'Clear one specific mock by ID. With sessionId: targets that session\'s ledger. Without: targets the standalone ledger.',
    ),
    allStandalone: z.boolean().optional().describe(
        'Clear ALL standalone mocks (those installed without a sessionId). Mutually exclusive with sessionId.',
    ),
}).refine(
    (input) => {
        const hasSession = !!input.sessionId;
        const hasAllStandalone = input.allStandalone === true;
        const hasMockId = !!input.mockId;
        if (hasAllStandalone && hasSession) return false;
        if (!hasSession && !hasAllStandalone && !hasMockId) return false;
        return true;
    },
    {
        message:
            'Provide one of: sessionId (clear session mocks), mockId (clear one standalone), ' +
            'or allStandalone:true (clear all standalone). sessionId and allStandalone are mutually exclusive.',
    },
);

export const ClearMockResponsesOutputSchema = z.object({
    removed: z.number().int().describe('Number of rules deleted from Proxyman'),
    remaining: z.number().int().describe('Number of rules still active in the targeted scope'),
    scope: z.enum(['session', 'standalone-one', 'standalone-all']).describe('Which scope was targeted'),
});

// ──────────────────────────────────────────────
// run_feature_test — declarative composite test spec
// ──────────────────────────────────────────────
//
// A single tool call that executes the setup → record → act → assert → teardown
// lifecycle deterministically. Replaces 8–15 AI-orchestrated tool calls per run.

const FlowRefSchema = z.object({
    flow: z.string().describe('Flow name (filename without .yaml extension) under flowsDir'),
    params: z
        .record(z.string())
        .optional()
        .describe('Per-flow param overrides merged on top of top-level env'),
});

// Selector shared by tap / assertVisible. Uses the same priority order as UIElement
// (id > accessibilityLabel > text > point).
const ActionSelectorSchema = z.object({
    id: z.string().optional(),
    accessibilityLabel: z.string().optional(),
    text: z.string().optional(),
    point: PointSchema.optional(),
});

// `type` action: the inline `text` is the text to type; id/accessibilityLabel target
// the field. Deliberately separate from ActionSelectorSchema to disambiguate `text`.
const TypeActionSchema = z.object({
    id: z.string().optional(),
    accessibilityLabel: z.string().optional(),
    point: PointSchema.optional(),
    text: z.string().describe('Text to type into the target field'),
});

const ScrollSpecSchema = z
    .object({
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    })
    .optional();

// `inputText` action: bare text-typing into the already-focused field. No
// preceding tap. The reliable path for iOS secure password fields where
// `type`'s tap-then-type pattern can drop focus or trip the strong-password
// suggestion. Pair with a separate `tap` action first if focus isn't where
// you need it.
const InputTextSpecSchema = z.object({
    text: z.string().describe('Text to type into the currently-focused field'),
});

const FeatureActionSpecSchema = z
    .union([
        z.object({ tap: ActionSelectorSchema }).strict(),
        z.object({ type: TypeActionSchema }).strict(),
        z.object({ inputText: InputTextSpecSchema }).strict(),
        z.object({ scroll: ScrollSpecSchema }).strict(),
        z.object({ wait: z.number().int().nonnegative() }).strict(),
        z.object({ assertVisible: ActionSelectorSchema }).strict(),
    ])
    .describe(
        'One action per array entry. Exactly one of tap / type / scroll / wait / assertVisible must be set.',
    );

// Assertion variants — composed from the existing verify_network_* input schemas
// via .omit so that the spec stays in lock-step with each tool's contract.
const AssertionParallelismSchema = VerifyNetworkParallelismInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({ type: z.literal('parallelism') });

const AssertionOnScreenSchema = VerifyNetworkOnScreenInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({
        type: z.literal('on_screen'),
        afterAction: AfterActionRefSchema.optional(),
    });

const AssertionAbsentSchema = VerifyNetworkAbsentInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({
        type: z.literal('absent'),
        afterAction: AfterActionRefSchema.optional(),
    });

const AssertionSequenceSchema = VerifyNetworkSequenceInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({ type: z.literal('sequence') });

const AssertionPerformanceSchema = VerifyNetworkPerformanceInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({ type: z.literal('performance') });

const AssertionPayloadSchema = VerifyNetworkPayloadInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({ type: z.literal('payload') });

const AssertionDeduplicationSchema = VerifyNetworkDeduplicationInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({ type: z.literal('deduplication') });

const AssertionErrorHandlingSchema = VerifyNetworkErrorHandlingInputSchema
    .omit({ sessionId: true, filterDomains: true })
    .extend({ type: z.literal('error_handling') });

const FeatureAssertionSpecSchema = z.discriminatedUnion('type', [
    AssertionParallelismSchema,
    AssertionOnScreenSchema,
    AssertionAbsentSchema,
    AssertionSequenceSchema,
    AssertionPerformanceSchema,
    AssertionPayloadSchema,
    AssertionDeduplicationSchema,
    AssertionErrorHandlingSchema,
]);

export const FeatureTestSpecSchema = z.object({
    name: z.string().describe('Short human-readable test name'),
    description: z.string().optional(),
    appBundleId: z.string().describe('The app under test (passed to start_recording_session)'),
    setup: z.array(FlowRefSchema).optional().default([]),
    mocks: z
        .array(MockSpecSchema)
        .optional()
        .default([])
        .describe(
            'Live response-mocking rules installed via Proxyman MCP after start_recording_session ' +
            'and before actions begin. Same shape as set_mock_response. Auto-cleaned when the session ends.',
        ),
    actions: z.array(FeatureActionSpecSchema).describe('UI actions dispatched inside the recording session'),
    assertions: z
        .array(FeatureAssertionSpecSchema)
        .describe('Network assertions run sequentially after actions settle'),
    teardown: z.array(FlowRefSchema).optional().default([]),
    filterDomains: z
        .array(z.string())
        .optional()
        .describe('Proxyman domain filter applied to the recording session and all assertions'),
    captureMode: z.enum(['event-triggered', 'polling']).optional(),
    trackEventPaths: z.array(z.string()).optional(),
});

export const RunFeatureTestInputSchema = z.object({
    spec: z
        .union([FeatureTestSpecSchema, z.string()])
        .describe('Inline FeatureTestSpec object or absolute path to a .yaml/.json spec file'),
    env: z
        .record(z.string())
        .optional()
        .describe('Env vars passed to every setup/teardown flow as Maestro -e KEY=VALUE'),
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (default: ios)'),
    flowsDir: z.string().optional().describe('Directory for setup/teardown flow YAML files'),
    stubsDir: z
        .string()
        .optional()
        .describe('Optional WireMock stubs root directory used by setup/teardown flows'),
    setupTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max wall-clock time for all setup flows combined (default: 120000)'),
    actionTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max wall-clock time for the entire actions phase (default: 30000)'),
    settleMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Wait after the last action before running assertions (default: 5000)'),
    driverCooldownMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            'Unified iOS driver cooldown (default: 5000). Applied in two places: ' +
            '(1) sleep between consecutive setup flows, ' +
            '(2) cooldown after the XCTest driver is uninstalled inside start_recording_session / run_flow ' +
            '(only hits that path when the driver health probe fails).',
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

export const BuildAppOutputSchema = z.object({
    passed: z.boolean().describe('Whether the build succeeded'),
    platform: z.enum(['ios', 'android']),
    appPath: z
        .string()
        .optional()
        .describe('Absolute path to the built .app (iOS) or .apk (Android). Undefined on failure.'),
    bundleId: z
        .string()
        .optional()
        .describe('iOS bundle identifier extracted from the built .app (best-effort).'),
    derivedDataPath: z
        .string()
        .optional()
        .describe('iOS only: Derived data path used for the build (may be auto-generated).'),
    module: z.string().optional().describe('Android only: Module that was built.'),
    variant: z.string().optional().describe('Android only: Variant that was built.'),
    durationMs: z.number().describe('Total build duration in ms'),
    output: z.string().describe('Truncated stdout/stderr from the build tool'),
});

export const InstallAppOutputSchema = z.object({
    passed: z.boolean().describe('Whether install succeeded'),
    platform: z.enum(['ios', 'android']),
    deviceUdid: z.string(),
    bundleId: z
        .string()
        .optional()
        .describe('iOS only: bundle identifier extracted from the .app (best-effort).'),
    durationMs: z.number(),
    output: z.string(),
});

export const UninstallAppOutputSchema = z.object({
    passed: z.boolean().describe('Whether uninstall succeeded'),
    platform: z.enum(['ios', 'android']),
    deviceUdid: z.string(),
    bundleId: z.string().describe('iOS bundle identifier or Android package name that was removed'),
    durationMs: z.number(),
    output: z.string(),
});

export const BootSimulatorOutputSchema = z.object({
    passed: z.boolean().describe('Whether the device reached Booted state'),
    platform: z.enum(['ios', 'android']),
    deviceUdid: z.string(),
    state: z.string().describe('Device state after the boot attempt'),
    alreadyBooted: z.boolean().describe('True if the device was already Booted before the call'),
    durationMs: z.number(),
    output: z.string(),
});

export const TakeScreenshotOutputSchema = z.object({
    passed: z.boolean().describe('Whether the screenshot was captured and saved'),
    platform: z.enum(['ios', 'android']),
    deviceUdid: z.string(),
    imagePath: z.string().describe('Absolute path of the written PNG'),
    sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Size of the saved PNG in bytes'),
    durationMs: z.number(),
    output: z.string().describe('Truncated stdout/stderr from the capture tool'),
});

const UnitTestFailureSchema = z.object({
    name: z.string().describe('Fully-qualified test identifier (e.g., MyTests/testLoginFlow)'),
    message: z
        .string()
        .optional()
        .describe('First-line failure message extracted from the tool output'),
    file: z.string().optional().describe('Source file that reported the failure, if known'),
    line: z.number().int().nonnegative().optional().describe('Source line of the failure, if known'),
});

export const RunUnitTestsOutputSchema = z.object({
    passed: z.boolean().describe('True when the run finished cleanly with zero failing tests'),
    platform: z.enum(['ios', 'android']),
    totalTests: z.number().int().nonnegative().describe('Total tests executed'),
    passedTests: z.number().int().nonnegative().describe('Tests that passed'),
    failedTests: z.number().int().nonnegative().describe('Tests that failed'),
    skippedTests: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Tests reported as skipped, if the tool emits that information'),
    failures: z
        .array(UnitTestFailureSchema)
        .describe('Failing tests with first-line messages (may be empty)'),
    durationMs: z.number().describe('Total test-run wall clock time in ms'),
    resultBundlePath: z
        .string()
        .optional()
        .describe('iOS only: path to the .xcresult bundle written by xcodebuild'),
    reportDir: z
        .string()
        .optional()
        .describe('Android only: directory containing the JUnit XML reports that were parsed'),
    output: z.string().describe('Truncated stdout/stderr from the test run'),
});

const FlowParamSpecSchema = z.object({
    required: z.boolean().optional().describe('Whether the caller must provide this parameter'),
    default: z.string().optional().describe('Default value applied when the caller omits this parameter'),
    description: z.string().optional().describe('Human-readable description of the parameter'),
});

const FlowSummarySchema = z.object({
    name: z.string().describe('Flow name (derived from the filename)'),
    path: z.string().describe('Absolute path to the flow YAML'),
    description: z.string().optional().describe('Description from the manifest, if any'),
    tags: z.array(z.string()).optional().describe('Free-form tags from the manifest'),
    params: z.record(FlowParamSpecSchema).optional().describe('Declared parameter specs from the manifest'),
});

export const ListFlowsOutputSchema = z.object({
    flows: z.array(FlowSummarySchema).describe('Discovered flows, sorted by name'),
    flowsDir: z.string().describe('Absolute path to the directory that was scanned'),
    total: z.number().describe('Number of flows returned'),
});

export const RunFlowOutputSchema = z.object({
    passed: z.boolean().describe('Whether the flow executed successfully'),
    flowName: z.string().describe('Name of the flow that ran'),
    flowPath: z.string().describe('Absolute path of the executed YAML'),
    appliedParams: z
        .record(z.string())
        .describe('Final parameters passed to Maestro (after manifest defaults + caller overrides)'),
    output: z.string().describe('Maestro CLI stdout/stderr output'),
    stubServerPort: z.number().optional().describe('Port the stub server ran on, if stubs were used'),
    durationMs: z.number().describe('Total flow execution time in milliseconds'),
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
    diagnostics: z
        .array(z.string())
        .optional()
        .describe(
            'Diagnostic warnings when the result may be incomplete (e.g., empty parsed tree with non-empty raw output).'
        ),
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

// ──────────────────────────────────────────────
// verify_network_* output schemas
// ──────────────────────────────────────────────

const EventSummarySchema = z.object({
    timestamp: z.string(),
    method: z.string(),
    url: z.string(),
    statusCode: z.number(),
    durationMs: z.number().optional(),
    operationName: z.string().optional(),
});

export const VerifyNetworkParallelismOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string().describe('Human-readable summary'),
    count: z.number().describe('Total matching events'),
    actualSpanMs: z.number().describe('Span (ms) from first to last matching event'),
    avgGapMs: z.number().describe('Average time between consecutive matching events'),
    events: z.array(EventSummarySchema),
});

const ExpectedCallOutcomeSchema = z.object({
    matcher: z.record(z.unknown()).describe('The matcher description'),
    description: z.string(),
    matched: z.boolean(),
    event: EventSummarySchema.optional(),
});

export const VerifyNetworkOnScreenOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string(),
    anchorTimestamp: z.string().optional(),
    matched: z.array(ExpectedCallOutcomeSchema),
    missing: z.array(ExpectedCallOutcomeSchema),
    extras: z.array(EventSummarySchema).describe('Events in the window that did not correspond to any expected matcher'),
});

export const VerifyNetworkAbsentOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string(),
    anchorTimestamp: z.string().optional(),
    violations: z.array(
        z.object({
            matcher: z.record(z.unknown()),
            description: z.string(),
            events: z.array(EventSummarySchema),
        }),
    ),
});

export const VerifyNetworkSequenceOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string(),
    actualOrder: z.array(
        z.object({
            expectedIndex: z.number(),
            description: z.string(),
            event: EventSummarySchema,
        }),
    ),
    firstDeviationIndex: z.number().optional(),
    missing: z
        .array(z.object({ expectedIndex: z.number(), description: z.string() }))
        .optional(),
});

export const VerifyNetworkPerformanceOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string(),
    count: z.number(),
    unknownDurationCount: z.number(),
    totalMs: z.number().describe('First start → last end (ms)'),
    slowestMs: z.number().optional(),
    fastestMs: z.number().optional(),
    p50: z.number().optional(),
    p95: z.number().optional(),
    violators: z.array(
        z.object({
            event: EventSummarySchema,
            reason: z.string(),
        }),
    ),
});

export const VerifyNetworkPayloadOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string(),
    event: EventSummarySchema.optional(),
    mismatches: z.array(z.string()),
});

export const VerifyNetworkDeduplicationOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string(),
    duplicates: z.array(
        z.object({
            key: z.string(),
            count: z.number(),
            timestamps: z.array(z.string()),
        }),
    ),
});

export const VerifyNetworkErrorHandlingOutputSchema = z.object({
    passed: z.boolean(),
    verdict: z.string(),
    errorsFound: z.array(
        z.object({
            expectedIndex: z.number(),
            description: z.string(),
            event: EventSummarySchema,
        }),
    ),
    missingErrors: z.array(
        z.object({
            expectedIndex: z.number(),
            description: z.string(),
        }),
    ),
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

// ── run_feature_test output ──

const FlowResultSchema = z.object({
    name: z.string(),
    passed: z.boolean(),
    durationMs: z.number(),
    error: z.string().optional(),
});

const InteractionSummarySchema = z.object({
    action: z.string(),
    element: z.string().describe('Human-readable target description'),
    durationMs: z.number(),
    waitMs: z.number().optional().describe('Set when the entry is a `wait` pause'),
});

const AssertionResultSchema = z.object({
    type: z.string(),
    passed: z.boolean(),
    verdict: z.string(),
    details: z.record(z.unknown()).describe('Full structured output from the verify_network_* tool'),
    error: z.string().optional(),
});

const MockInstallSummarySchema = z.object({
    mockId: z.string(),
    proxymanRuleId: z.string(),
    ruleName: z.string(),
});

export const RunFeatureTestOutputSchema = z.object({
    passed: z.boolean().describe('True only if setup, all actions, and every assertion passed'),
    name: z.string(),
    durationMs: z.number(),
    setup: z.object({
        passed: z.boolean(),
        flows: z.array(FlowResultSchema),
    }),
    mocks: z.object({
        installed: z.array(MockInstallSummarySchema)
            .describe('Mocks successfully installed via Proxyman MCP, in spec order'),
        error: z.string().optional()
            .describe('Populated when a mock failed to install — earlier mocks may already be active'),
    }).default({ installed: [] }),
    actions: z.object({
        sessionId: z.string(),
        interactions: z.array(InteractionSummarySchema),
    }),
    assertions: z.array(AssertionResultSchema),
    teardown: z.object({
        flows: z.array(FlowResultSchema),
        compiledYamlPath: z.string().optional(),
    }),
    error: z.string().optional().describe('Populated when the test aborted before completion'),
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

export type VerifyNetworkParallelismInput = z.infer<typeof VerifyNetworkParallelismInputSchema>;
export type VerifyNetworkParallelismOutput = z.infer<typeof VerifyNetworkParallelismOutputSchema>;

export type VerifyNetworkOnScreenInput = z.infer<typeof VerifyNetworkOnScreenInputSchema>;
export type VerifyNetworkOnScreenOutput = z.infer<typeof VerifyNetworkOnScreenOutputSchema>;

export type VerifyNetworkAbsentInput = z.infer<typeof VerifyNetworkAbsentInputSchema>;
export type VerifyNetworkAbsentOutput = z.infer<typeof VerifyNetworkAbsentOutputSchema>;

export type VerifyNetworkSequenceInput = z.infer<typeof VerifyNetworkSequenceInputSchema>;
export type VerifyNetworkSequenceOutput = z.infer<typeof VerifyNetworkSequenceOutputSchema>;

export type VerifyNetworkPerformanceInput = z.infer<typeof VerifyNetworkPerformanceInputSchema>;
export type VerifyNetworkPerformanceOutput = z.infer<typeof VerifyNetworkPerformanceOutputSchema>;

export type VerifyNetworkPayloadInput = z.infer<typeof VerifyNetworkPayloadInputSchema>;
export type VerifyNetworkPayloadOutput = z.infer<typeof VerifyNetworkPayloadOutputSchema>;

export type VerifyNetworkDeduplicationInput = z.infer<typeof VerifyNetworkDeduplicationInputSchema>;
export type VerifyNetworkDeduplicationOutput = z.infer<typeof VerifyNetworkDeduplicationOutputSchema>;

export type VerifyNetworkErrorHandlingInput = z.infer<typeof VerifyNetworkErrorHandlingInputSchema>;
export type VerifyNetworkErrorHandlingOutput = z.infer<typeof VerifyNetworkErrorHandlingOutputSchema>;

export type RegisterSegmentInput = z.infer<typeof RegisterSegmentInputSchema>;
export type RegisterSegmentOutput = z.infer<typeof RegisterSegmentOutputSchema>;

export type RunTestInput = z.infer<typeof RunTestInputSchema>;
export type RunTestOutput = z.infer<typeof RunTestOutputSchema>;

export type ListDevicesInput = z.infer<typeof ListDevicesInputSchema>;
export type ListDevicesOutput = z.infer<typeof ListDevicesOutputSchema>;

export type GetSessionTimelineInput = z.infer<typeof GetSessionTimelineInputSchema>;
export type GetSessionTimelineOutput = z.infer<typeof GetSessionTimelineOutputSchema>;

export type ListFlowsInput = z.infer<typeof ListFlowsInputSchema>;
export type ListFlowsOutput = z.infer<typeof ListFlowsOutputSchema>;

export type RunFlowInput = z.infer<typeof RunFlowInputSchema>;
export type RunFlowOutput = z.infer<typeof RunFlowOutputSchema>;

export type BuildAppInput = z.infer<typeof BuildAppInputSchema>;
export type BuildAppOutput = z.infer<typeof BuildAppOutputSchema>;

export type InstallAppInput = z.infer<typeof InstallAppInputSchema>;
export type InstallAppOutput = z.infer<typeof InstallAppOutputSchema>;

export type UninstallAppInput = z.infer<typeof UninstallAppInputSchema>;
export type UninstallAppOutput = z.infer<typeof UninstallAppOutputSchema>;

export type BootSimulatorInput = z.infer<typeof BootSimulatorInputSchema>;
export type BootSimulatorOutput = z.infer<typeof BootSimulatorOutputSchema>;

export type TakeScreenshotInput = z.infer<typeof TakeScreenshotInputSchema>;
export type TakeScreenshotOutput = z.infer<typeof TakeScreenshotOutputSchema>;

export type RunUnitTestsInput = z.infer<typeof RunUnitTestsInputSchema>;
export type RunUnitTestsOutput = z.infer<typeof RunUnitTestsOutputSchema>;

export type FeatureTestSpec = z.infer<typeof FeatureTestSpecSchema>;
export type RunFeatureTestInput = z.infer<typeof RunFeatureTestInputSchema>;
export type RunFeatureTestOutput = z.infer<typeof RunFeatureTestOutputSchema>;

export type SetMockResponseInput = z.infer<typeof SetMockResponseInputSchema>;
export type SetMockResponseOutput = z.infer<typeof SetMockResponseOutputSchema>;
export type ClearMockResponsesInput = z.infer<typeof ClearMockResponsesInputSchema>;
export type ClearMockResponsesOutput = z.infer<typeof ClearMockResponsesOutputSchema>;

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
    VERIFY_NETWORK_PARALLELISM: 'verify_network_parallelism',
    VERIFY_NETWORK_ON_SCREEN: 'verify_network_on_screen',
    VERIFY_NETWORK_ABSENT: 'verify_network_absent',
    VERIFY_NETWORK_SEQUENCE: 'verify_network_sequence',
    VERIFY_NETWORK_PERFORMANCE: 'verify_network_performance',
    VERIFY_NETWORK_PAYLOAD: 'verify_network_payload',
    VERIFY_NETWORK_DEDUPLICATION: 'verify_network_deduplication',
    VERIFY_NETWORK_ERROR_HANDLING: 'verify_network_error_handling',
    REGISTER_SEGMENT: 'register_segment',
    RUN_TEST: 'run_test',
    LIST_DEVICES: 'list_devices',
    GET_SESSION_TIMELINE: 'get_session_timeline',
    LIST_FLOWS: 'list_flows',
    RUN_FLOW: 'run_flow',
    BUILD_APP: 'build_app',
    INSTALL_APP: 'install_app',
    UNINSTALL_APP: 'uninstall_app',
    BOOT_SIMULATOR: 'boot_simulator',
    TAKE_SCREENSHOT: 'take_screenshot',
    RUN_UNIT_TESTS: 'run_unit_tests',
    RUN_FEATURE_TEST: 'run_feature_test',
    SET_MOCK_RESPONSE: 'set_mock_response',
    CLEAR_MOCK_RESPONSES: 'clear_mock_responses',
} as const;
