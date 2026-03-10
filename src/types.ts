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
}

// ----- UI Types -----

export type UIActionType = 'tap' | 'type' | 'scroll' | 'swipe' | 'back' | 'assertVisible';

export interface UIElement {
    id?: string;
    testId?: string;
    accessibilityLabel?: string;
    text?: string;
    role?: string;
    bounds?: { x: number; y: number; width: number; height: number };
}

export interface UIInteraction {
    id?: number;
    sessionId: string;
    timestamp: string;
    actionType: UIActionType;
    element: UIElement;
    textInput?: string;
    /** How this interaction was captured: 'dispatched' (via execute_ui_action) or 'inferred' (passive touch capture) */
    source?: 'dispatched' | 'inferred';
}

export interface UIHierarchyNode {
    id?: string;
    testId?: string;
    accessibilityLabel?: string;
    text?: string;
    role: string;
    children: UIHierarchyNode[];
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

