/**
 * Domain models for the Mobile Automator MCP server.
 *
 * These types represent core business entities (sessions, UI elements,
 * network events). Tool-specific input/output types are derived from
 * Zod schemas in schemas.ts — do NOT duplicate them here.
 */

// ----- Session -----

export type SessionStatus = 'idle' | 'recording' | 'compiling' | 'done';
export type MobilePlatform = 'ios' | 'android';
export type CaptureMode = 'event-triggered' | 'polling';

export interface Session {
    id: string;
    appBundleId: string;
    platform: MobilePlatform;
    status: SessionStatus;
    startedAt: string;
    stoppedAt?: string;
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
}

// ----- UI Types -----

export type UIActionType = 'tap' | 'type' | 'scroll' | 'swipe' | 'scrollUntilVisible' | 'swipeUntilVisible' | 'back' | 'assertVisible';

export interface UIElement {
    id?: string;
    testId?: string;
    accessibilityLabel?: string;
    text?: string;
    role?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    /** True when the element is a secure text field (password input). Used to emit env-var placeholders instead of literal credentials. */
    isSecure?: boolean;
}

export interface UIInteraction {
    id?: number;
    sessionId: string;
    timestamp: string;
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
    /** Timeout for hierarchy dump calls (ms). Default: 15000 */
    hierarchyDumpMs: number;
    /** Timeout for lightweight/polling hierarchy calls (ms). Default: 10000 */
    hierarchyLiteMs: number;
    /** Timeout for single UI action execution (ms). Default: 15000 */
    actionMs: number;
    /** Timeout for full test run (ms). Default: 120000 */
    testRunMs: number;
    /** Timeout for setup validation calls (ms). Default: 5000 */
    setupValidationMs: number;
    /** Timeout for daemon JSON-RPC requests (ms). Default: 15000 */
    daemonRequestMs: number;
    /** Timeout for daemon graceful shutdown (ms). Default: 3000 */
    daemonShutdownMs: number;
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
    hierarchyDumpMs: 15_000,
    hierarchyLiteMs: 10_000,
    actionMs: 15_000,
    testRunMs: 120_000,
    setupValidationMs: 5_000,
    daemonRequestMs: 15_000,
    daemonShutdownMs: 3_000,
};

