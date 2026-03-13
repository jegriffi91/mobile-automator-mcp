/**
 * MaestroDaemonDriver — AutomationDriver backed by MaestroDaemon + MaestroWrapper.
 *
 * Uses the persistent `maestro mcp` daemon for hierarchy operations (sub-second
 * on a warm JVM). Falls back to MaestroWrapper for actions, test runs, and
 * setup/teardown operations that the daemon doesn't support.
 *
 * If the daemon fails to start, gracefully degrades to pure CLI mode for
 * hierarchy operations as well.
 */

import type { AutomationDriver, TreeHierarchyReader } from './driver.js';
import { MaestroWrapper } from './wrapper.js';
import { MaestroDaemon } from './daemon.js';
import { HierarchyParser } from './hierarchy.js';
import type { UIActionType, UIElement, MobilePlatform, TimeoutConfig } from '../types.js';

export class MaestroDaemonDriver implements AutomationDriver {
    private wrapper: MaestroWrapper;
    private daemon: MaestroDaemon;
    private daemonStarted = false;

    constructor(timeouts: TimeoutConfig) {
        this.wrapper = new MaestroWrapper(undefined, timeouts);
        this.daemon = new MaestroDaemon(undefined, timeouts);
    }

    // ── Hierarchy (daemon fast path with CLI fallback) ──

    async dumpHierarchy(): Promise<string> {
        if (this.daemonStarted) {
            try {
                return await this.daemon.getHierarchyRaw();
            } catch (err) {
                console.error(
                    '[MaestroDaemonDriver] daemon hierarchy failed, falling back to CLI:',
                    err,
                );
            }
        }
        return this.wrapper.dumpHierarchy();
    }

    async dumpHierarchyLite(): Promise<string> {
        if (this.daemonStarted) {
            try {
                return await this.daemon.getHierarchyRaw();
            } catch (err) {
                console.error(
                    '[MaestroDaemonDriver] daemon hierarchy (lite) failed, falling back to CLI:',
                    err,
                );
            }
        }
        return this.wrapper.dumpHierarchyLite();
    }

    async dumpHierarchyUntilSettled(
        settleTimeoutMs?: number,
    ): Promise<{ hierarchy: string; settleDurationMs: number }> {
        // Settle detection requires repeated snapshots with diff comparison —
        // delegate to wrapper which has the HierarchyDiffer integration.
        // The wrapper will use its own dumpHierarchy() under the hood.
        return this.wrapper.dumpHierarchyUntilSettled(settleTimeoutMs);
    }

    // ── Actions (daemon doesn't support these — always CLI) ──

    async executeAction(
        action: UIActionType,
        element: UIElement,
        textInput?: string,
    ): Promise<{ success: boolean; error?: string }> {
        return this.wrapper.executeAction(action, element, textInput);
    }

    // ── Test execution (daemon doesn't support this — always CLI) ──

    async runTest(
        yamlPath: string,
        env?: Record<string, string>,
    ): Promise<{ passed: boolean; output: string; durationMs: number }> {
        return this.wrapper.runTest(yamlPath, env);
    }

    // ── Setup & teardown (delegated to wrapper — uses native toolchains) ──

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

    // ── Hierarchy tree reader (runtime daemon check with CLI fallback) ──

    createTreeReader(): TreeHierarchyReader {
        // Evaluate daemon health at CALL time, not creation time.
        // If the daemon crashes after the reader is created, the reader
        // falls back to CLI instead of throwing.
        return async () => {
            if (this.daemonStarted) {
                try {
                    return await this.daemon.getHierarchy();
                } catch (err) {
                    console.error(
                        '[MaestroDaemonDriver] daemon tree reader failed, falling back to CLI:',
                        err,
                    );
                }
            }
            const raw = await this.wrapper.dumpHierarchyLite();
            return HierarchyParser.parse(raw);
        };
    }

    // ── Lifecycle ──

    async start(deviceId?: string): Promise<void> {
        try {
            await this.daemon.start(deviceId);
            this.daemonStarted = true;
            console.error('[MaestroDaemonDriver] daemon started successfully');
        } catch (err) {
            console.error(
                '[MaestroDaemonDriver] daemon failed to start, will use CLI fallback:',
                err,
            );
            this.daemonStarted = false;
        }
    }

    async stop(): Promise<void> {
        if (this.daemonStarted) {
            await this.daemon.stop();
            this.daemonStarted = false;
            console.error('[MaestroDaemonDriver] daemon stopped');
        }
    }

    get isRunning(): boolean {
        return this.daemonStarted && this.daemon.isRunning;
    }
}
