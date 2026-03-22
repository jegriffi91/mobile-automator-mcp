/**
 * MaestroCliDriver — AutomationDriver backed by MaestroWrapper (CLI subprocess).
 *
 * Thin adapter over the existing MaestroWrapper. Each hierarchy dump spawns a new
 * JVM process (~5s cold start). This is the fallback when the daemon is unavailable.
 */

import type { AutomationDriver, TreeHierarchyReader } from './driver.js';
import { MaestroWrapper } from './wrapper.js';
import { HierarchyParser } from './hierarchy.js';
import type { UIActionType, UIElement, MobilePlatform, TimeoutConfig } from '../types.js';

export class MaestroCliDriver implements AutomationDriver {
    private wrapper: MaestroWrapper;

    constructor(timeouts: TimeoutConfig) {
        this.wrapper = new MaestroWrapper(undefined, timeouts);
    }

    // ── Hierarchy ──

    async dumpHierarchy(): Promise<string> {
        return this.wrapper.dumpHierarchy();
    }

    async dumpHierarchyLite(): Promise<string> {
        return this.wrapper.dumpHierarchyLite();
    }

    async dumpHierarchyUntilSettled(
        settleTimeoutMs?: number,
    ): Promise<{ hierarchy: string; settleDurationMs: number }> {
        return this.wrapper.dumpHierarchyUntilSettled(settleTimeoutMs);
    }

    // ── Actions ──

    async executeAction(
        action: UIActionType,
        element: UIElement,
        textInput?: string,
    ): Promise<{ success: boolean; error?: string }> {
        return this.wrapper.executeAction(action, element, textInput);
    }

    // ── Test execution ──

    async runTest(
        yamlPath: string,
        env?: Record<string, string>,
        debugOutput?: string
    ): Promise<{ passed: boolean; output: string; durationMs: number }> {
        return this.wrapper.runTest(yamlPath, env, debugOutput);
    }

    // ── Setup & teardown ──

    async validateSetup(): Promise<void> {
        return this.wrapper.validateSetup();
    }

    async validateSimulator(
        platform: MobilePlatform,
    ): Promise<{ booted: boolean; deviceId?: string }> {
        return this.wrapper.validateSimulator(platform);
    }

    async uninstallDriver(platform: MobilePlatform, deviceId?: string): Promise<void> {
        return this.wrapper.uninstallDriver(platform, deviceId);
    }

    // ── Hierarchy tree reader ──

    createTreeReader(): TreeHierarchyReader {
        return async () => {
            const raw = await this.wrapper.dumpHierarchyLite();
            return HierarchyParser.parse(raw);
        };
    }

    // ── Lifecycle (no-ops for CLI — no persistent state) ──

    async start(_deviceId?: string): Promise<void> {
        // CLI driver has no persistent process to manage
    }

    async stop(): Promise<void> {
        // CLI driver has no persistent process to manage
    }

    get isRunning(): boolean {
        return true; // CLI is always "available" (each call is independent)
    }
}
