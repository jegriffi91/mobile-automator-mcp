/**
 * Domain models for the Mobile Automator MCP server.
 *
 * These types represent core business entities (sessions, UI elements,
 * network events). Tool-specific input/output types are derived from
 * Zod schemas in schemas.ts — do NOT duplicate them here.
 */

// ----- Session -----

export type SessionStatus = 'idle' | 'recording' | 'compiling' | 'done' | 'aborted';
export type MobilePlatform = 'ios' | 'android';
export type CaptureMode = 'event-triggered' | 'polling';

export interface Session {
    id: string;
    appBundleId: string;
    platform: MobilePlatform;
    status: SessionStatus;
    startedAt: string;
    stoppedAt?: string;
    /** Reason a session was force-cleaned or aborted (force_cleanup_session, timeout, etc). */
    abortedReason?: string;
    /** Proxyman entry count at recording start — used to scope HAR export */
    proxymanBaseline?: number;
    /** Domain filter for Proxyman traffic isolation (e.g., ["localhost.proxyman.io:3031"]) */
    filterDomains?: string[];
    /** Hierarchy capture fidelity — defaults to 'event-triggered' */
    captureMode?: CaptureMode;
    /** Polling interval in ms (only used when captureMode is 'polling') */
    pollingIntervalMs?: number;
    /** How long to wait for UI to stabilize after an action (ms) */
    settleTimeoutMs?: number;
    /** URL path patterns for network-based interaction tracking (e.g., ['/__track']) */
    trackEventPaths?: string[];
    /**
     * Phase 4: device UDID captured at start_recording_session. In-memory only
     * (not persisted to SQLite) — used by SessionManager.resumeSession to
     * recreate the daemon driver after a paused flow run.
     */
    deviceId?: string;
    /**
     * Phase 4: timeout overrides supplied to DriverFactory.create at session
     * start. In-memory only — used to recreate the driver with the same
     * config on resume.
     */
    driverTimeouts?: Partial<TimeoutConfig>;
    /**
     * Phase 4: per-flow records captured by SessionManager.resumeSession.
     * In-memory only. Compile-time event-weaving (a future phase) will use
     * these to splice synthesized flow events into the timeline; for now,
     * they are breadcrumbs for diagnostics.
     */
    flowExecutions?: FlowExecutionRecord[];
}

/**
 * Phase 4: a single run_test / run_flow execution captured during a paused
 * window of a recording session. `output` is the captured stdout+stderr from
 * the Maestro CLI; treat it as opaque text for compile-time consumption.
 *
 * Phase 5 additions (`cancelled`, `debugOutputDir`, `flowPath`) feed the
 * compile-time event-weaving pipeline — see src/synthesis/flow-weaver.ts.
 */
export interface FlowExecutionRecord {
    flowName: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    output: string;
    succeeded: boolean;
    /** True when the flow run was cancelled (cancel_task / watchdog), distinct from a failed flow. */
    cancelled?: boolean;
    /** Path passed to Maestro --debug-output. Phase 5 parses commands-*.json from here. */
    debugOutputDir?: string;
    /** Absolute path to the source flow YAML — emitted as `runFlow:` in the compiled artifact. */
    flowPath?: string;
}

// ----- UI Types -----

export type UIActionType =
    | 'tap'
    | 'type'
    | 'inputText'
    | 'scroll'
    | 'swipe'
    | 'scrollUntilVisible'
    | 'swipeUntilVisible'
    | 'back'
    | 'assertVisible';

export interface UIElement {
    id?: string;
    testId?: string;
    accessibilityLabel?: string;
    text?: string;
    role?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    /**
     * Absolute point coordinates for a tap. Use for custom controls (e.g. Bureau
     * tabs) that don't respond to accessibility-based selectors even when the
     * element is present in the hierarchy.
     */
    point?: { x: number; y: number };
    /** True when the element is a secure text field (password input). Used to emit env-var placeholders instead of literal credentials. */
    isSecure?: boolean;
}

export interface UIInteraction {
    id?: number;
    sessionId: string;
    /** @deprecated use dispatchedAt instead for network verification */
    timestamp: string;
    /** When the action was sent to the device (before execution). Used for network call verification. */
    dispatchedAt?: string;
    /** When the action completed on the device (after UI settled). */
    completedAt?: string;
    actionType: UIActionType;
    element: UIElement;
    textInput?: string;
    /** How this interaction was captured: 'dispatched' (via execute_ui_action), 'inferred' (passive touch capture), or 'tracked' (app-side event tracking) */
    source?: 'dispatched' | 'inferred' | 'inferred-transition' | 'tracked';
}

export interface UIHierarchyNode {
    id?: string;
    testId?: string;
    accessibilityLabel?: string;
    text?: string;
    role: string;
    children: UIHierarchyNode[];
    /** True when the node is a secure text field (password input) */
    isSecure?: boolean;
    /**
     * Pre-computed hash of the tree's identifiable elements.
     * Enables O(1) equality comparison in HierarchyDiffer.areEqualTrees.
     * Computed during parsing — only present on root nodes.
     */
    structuralHash?: string;
    /** Pixel bounds of the element on the device screen, when reported by the source.
     *  Width/height are computed from the raw [x1,y1][x2,y2] format. Absent for nodes
     *  whose source didn't emit bounds (e.g., legacy JSON parser without attrs.bounds). */
    bounds?: { x: number; y: number; width: number; height: number };
}

// ----- Hierarchy Capture Types -----

export interface HierarchySnapshot {
    id?: number;
    sessionId: string;
    timestamp: string;
    /** What triggered this snapshot */
    trigger: 'pre-action' | 'post-settle' | 'poll';
    /** Links to the interaction that triggered this (for event-triggered mode) */
    actionId?: number;
    /** Raw JSON string from maestro hierarchy */
    hierarchyJson: string;
}

/** Tracks an attribute change on a persistent element (same id, different text/value) */
export interface ElementChange {
    /** The element's stable identity key (id or accessibilityLabel) */
    identityKey: string;
    /** The element before the change */
    before: UIElement;
    /** The element after the change */
    after: UIElement;
    /** Which attribute changed */
    changedAttribute: 'text' | 'accessibilityLabel' | 'role';
}

export interface StateChange {
    timestamp: string;
    /** Links to the interaction that caused this change */
    actionId?: number;
    /** Elements that appeared between pre-action and post-settle snapshots */
    elementsAdded: UIElement[];
    /** Elements that disappeared between pre-action and post-settle snapshots */
    elementsRemoved: UIElement[];
    /** Elements whose attributes changed (e.g., text field value updated) */
    elementsChanged: ElementChange[];
    /** How long the UI took to stabilize (ms) */
    settleDurationMs: number;
}

// ----- Network Types -----

export interface NetworkEvent {
    id?: number;
    sessionId: string;
    timestamp: string;
    method: string;
    url: string;
    statusCode: number;
    requestBody?: string;
    responseBody?: string;
    durationMs?: number;
}

// ----- Timeout Config -----

/** Centralized timeout configuration for Maestro CLI and daemon operations. */
export interface TimeoutConfig {
    /** Timeout for hierarchy dump calls (ms). Default: 30000 */
    hierarchyDumpMs: number;
    /** Timeout for lightweight/polling hierarchy calls (ms). Default: 10000 */
    hierarchyLiteMs: number;
    /** Timeout for single UI action execution (ms). Default: 15000 */
    actionMs: number;
    /** Timeout for full test run (ms). Default: 120000 */
    testRunMs: number;
    /** Timeout for setup validation calls (ms). Default: 15000 */
    setupValidationMs: number;
    /** Timeout for daemon JSON-RPC requests (ms). Default: 15000 */
    daemonRequestMs: number;
    /** Timeout for daemon graceful shutdown (ms). Default: 3000 */
    daemonShutdownMs: number;
    /**
     * Pause after uninstalling the iOS XCTest driver before the next `maestro`
     * invocation (ms). Default: 3000.
     *
     * Gives the simulator time to fully terminate the XCTRunner process and
     * release port 7001 from TIME_WAIT. Without this, back-to-back
     * `maestro test` runs can fail with `ConnectException: Failed to connect
     * to /127.0.0.1:7001` on the first command.
     *
     * iOS-only; Android's UiAutomator driver uses a different connection model.
     */
    driverCooldownMs: number;
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
    hierarchyDumpMs: 30_000,
    hierarchyLiteMs: 10_000,
    actionMs: 15_000,
    testRunMs: 120_000,
    setupValidationMs: 15_000,
    daemonRequestMs: 15_000,
    daemonShutdownMs: 3_000,
    driverCooldownMs: 3_000,
};

