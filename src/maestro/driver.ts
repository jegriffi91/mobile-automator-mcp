/**
 * AutomationDriver — Abstraction layer for Maestro backends.
 *
 * Decouples handlers from the specific Maestro integration (CLI vs MCP daemon).
 * Implementations:
 *   • MaestroCliDriver  — delegates to MaestroWrapper (cold JVM per call)
 *   • MaestroDaemonDriver — delegates to MaestroDaemon for hierarchy (warm JVM),
 *                           falls back to MaestroWrapper for actions/tests
 *
 * DriverFactory encapsulates the daemon-preferred, CLI-fallback logic that was
 * previously inlined in handlers.ts and manager.ts.
 */

import type { UIActionType, UIElement, MobilePlatform, TimeoutConfig } from '../types.js';
import { DEFAULT_TIMEOUTS } from '../types.js';
import type { UIHierarchyNode } from '../types.js';

/** Returns a parsed UIHierarchyNode tree — used by TouchInferrer for polling */
export type TreeHierarchyReader = () => Promise<UIHierarchyNode>;

/**
 * Unified interface for UI automation backends.
 *
 * Both MaestroCliDriver and MaestroDaemonDriver implement this interface,
 * allowing handlers and SessionManager to operate without knowing which
 * backend is active.
 */
export interface AutomationDriver {
    // ── Hierarchy ──
    dumpHierarchy(): Promise<string>;
    dumpHierarchyLite(): Promise<string>;
    dumpHierarchyUntilSettled(
        settleTimeoutMs?: number,
    ): Promise<{ hierarchy: string; settleDurationMs: number }>;

    // ── Actions ──
    executeAction(
        action: UIActionType,
        element: UIElement,
        textInput?: string,
    ): Promise<{ success: boolean; error?: string }>;

    // ── Test execution ──
    runTest(yamlPath: string, env?: Record<string, string>, debugOutput?: string): Promise<{ passed: boolean; output: string; durationMs: number }>;

    // ── Setup & teardown ──
    validateSetup(): Promise<void>;
    validateSimulator(
        platform: MobilePlatform,
    ): Promise<{ booted: boolean; deviceId?: string }>;
    uninstallDriver(platform: MobilePlatform, deviceId?: string): Promise<void>;

    // ── Hierarchy tree reader (for TouchInferrer polling) ──
    createTreeReader(): TreeHierarchyReader;

    // ── Lifecycle ──
    start(deviceId?: string): Promise<void>;
    stop(): Promise<void>;
    readonly isRunning: boolean;
}

/**
 * Factory that creates an AutomationDriver with daemon-preferred, CLI-fallback logic.
 *
 * The factory encapsulates the decision that was previously inlined in handlers.ts
 * and manager.ts — try the daemon first for fast hierarchy, fall back to CLI if
 * the daemon fails to start.
 */
export class DriverFactory {
    /**
     * Create an AutomationDriver.
     *
     * Attempts to create a MaestroDaemonDriver (warm JVM, sub-second hierarchy).
     * If daemon initialization fails, falls back to MaestroCliDriver.
     *
     * Note: The driver is NOT started by the factory — call `driver.start(deviceId)`
     * after creation to initialize the daemon process.
     */
    static async create(
        timeouts?: Partial<TimeoutConfig>,
    ): Promise<AutomationDriver> {
        const mergedTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };

        // Always try daemon-backed driver first (will fall back to CLI internally
        // if daemon fails to start when start() is called)
        const { MaestroDaemonDriver } = await import('./daemon-driver.js');
        return new MaestroDaemonDriver(mergedTimeouts);
    }

    /**
     * Create a CLI-only driver (no daemon). Useful for tests or when the daemon
     * is known to be unavailable.
     */
    static async createCliOnly(
        timeouts?: Partial<TimeoutConfig>,
    ): Promise<AutomationDriver> {
        const mergedTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
        const { MaestroCliDriver } = await import('./cli-driver.js');
        return new MaestroCliDriver(mergedTimeouts);
    }
}
