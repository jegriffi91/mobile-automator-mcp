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

/**
 * Optional hints passed to `DriverFactory.create`.
 *
 * `platform` lets the factory force the Maestro backend on Android even when
 * `MCA_UI_DRIVER=loupe` is set (Loupe is iOS Simulator only). `bundleId` lets
 * the Loupe backend inject its in-process HTTP server eagerly at start time
 * instead of waiting for a later `setAppContext` call.
 */
export interface DriverFactoryOptions {
    platform?: MobilePlatform;
    bundleId?: string;
}

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
    /**
     * Run a Maestro test/flow YAML.
     *
     * `signal` is the optional AbortSignal that will SIGTERM the underlying
     * `maestro test` subprocess (with a SIGKILL fallback after 5s — see
     * execFileWithAbort). Used by the Phase 4 pause/resume path so
     * cancel_task can interrupt a running flow without orphaning the
     * recording session it paused.
     */
    runTest(
        yamlPath: string,
        env?: Record<string, string>,
        debugOutput?: string,
        signal?: AbortSignal,
        onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
    ): Promise<{ passed: boolean; output: string; durationMs: number }>;

    // ── Setup & teardown ──
    validateSetup(): Promise<void>;
    validateSimulator(
        platform: MobilePlatform,
    ): Promise<{ booted: boolean; deviceId?: string }>;
    uninstallDriver(platform: MobilePlatform, deviceId?: string): Promise<void>;
    /**
     * Ensure the Maestro UI driver is in a usable state before the next run.
     *
     * iOS: probes port 7001 first; if a healthy driver is already listening, it
     * is reused and no uninstall is performed. If the probe fails (ECONNREFUSED /
     * timeout), falls back to the original uninstall + TIME_WAIT cooldown path.
     * Pass `{ force: true }` to skip the probe and always uninstall.
     *
     * Android: no probe; unconditional uninstall (no port contention).
     */
    ensureCleanDriverState(
        platform: MobilePlatform,
        deviceId?: string,
        options?: { force?: boolean; probeTimeoutMs?: number },
    ): Promise<void>;

    // ── Hierarchy tree reader (for TouchInferrer polling) ──
    createTreeReader(): TreeHierarchyReader;

    // ── Lifecycle ──
    start(deviceId?: string): Promise<void>;
    stop(): Promise<void>;
    readonly isRunning: boolean;

    /**
     * Inform the driver of the target app's bundle id. No-op for Maestro
     * backends. The Loupe backend uses this to spawn the in-process HTTP
     * server (`loupe start --bundle-id ...`) — lazy injection that can run
     * before or after `start(deviceId)`, in any order.
     */
    setAppContext(bundleId: string): Promise<void>;
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
        opts?: DriverFactoryOptions,
    ): Promise<AutomationDriver> {
        const mergedTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };

        // MCA_UI_DRIVER=loupe routes hierarchy + native HID actions through
        // Loupe's in-process HTTP server. Requires iOS and a known bundle id
        // at creation time (Loupe injects per-app). Standalone get_ui_hierarchy
        // calls don't carry a bundle id, so they transparently keep using
        // Maestro — no degraded-mode wrapper churn.
        const pref = (process.env.MCA_UI_DRIVER ?? 'maestro').toLowerCase();
        if (pref === 'loupe' && opts?.platform === 'ios' && opts?.bundleId) {
            try {
                const { LoupeDriver } = await import('../loupe/loupe-driver.js');
                return new LoupeDriver(mergedTimeouts, opts.bundleId);
            } catch (err) {
                console.error(
                    '[DriverFactory] Loupe init failed, falling back to Maestro:',
                    err,
                );
            }
        }

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
