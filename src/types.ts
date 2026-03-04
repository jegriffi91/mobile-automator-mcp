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

export interface Session {
    id: string;
    appBundleId: string;
    platform: MobilePlatform;
    status: SessionStatus;
    startedAt: string;
    stoppedAt?: string;
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
}

export interface UIHierarchyNode {
    id?: string;
    testId?: string;
    accessibilityLabel?: string;
    text?: string;
    role: string;
    children: UIHierarchyNode[];
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
