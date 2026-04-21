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

/**
 * Minimum time between daemon respawn attempts. Prevents a dead-and-failing-to-start
 * daemon from throwing fresh errors on every hierarchy call.
 */
const RESPAWN_COOLDOWN_MS = 30_000;

export class MaestroDaemonDriver implements AutomationDriver {
    private wrapper: MaestroWrapper;
    private daemon: MaestroDaemon;
    private daemonStarted = false;
    private deviceIdForRespawn?: string;
    private lastRespawnAt = 0;

    constructor(timeouts: TimeoutConfig) {
        this.wrapper = new MaestroWrapper(undefined, timeouts);
        this.daemon = new MaestroDaemon(undefined, timeouts);
    }

    /**
     * Check whether the daemon is alive. If it has died but is still marked as
     * "started" by the driver, attempt to respawn it — but only once per
     * `RESPAWN_COOLDOWN_MS` window so a persistently-broken daemon doesn't
     * thrash on every hierarchy call. Returns true when the daemon is usable
     * after this call.
     */
    private async ensureDaemonAliveOrFalse(): Promise<boolean> {
        if (!this.daemonStarted) return false;
        if (this.daemon.isRunning) return true;

        const now = Date.now();
        if (now - this.lastRespawnAt < RESPAWN_COOLDOWN_MS) {
            return false;
        }
        this.lastRespawnAt = now;

        console.error('[MaestroDaemonDriver] daemon is not running — attempting respawn');
        try {
            await this.daemon.start(this.deviceIdForRespawn);
            console.error('[MaestroDaemonDriver] respawn succeeded');
            return true;
        } catch (err) {
            console.error('[MaestroDaemonDriver] respawn failed, staying on CLI:', err);
            return false;
        }
    }

    // ── Hierarchy (daemon fast path with CLI fallback) ──

    async dumpHierarchy(): Promise<string> {
        if (await this.ensureDaemonAliveOrFalse()) {
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
        if (await this.ensureDaemonAliveOrFalse()) {
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
        debugOutput?: string
    ): Promise<{ passed: boolean; output: string; durationMs: number }> {
        return this.wrapper.runTest(yamlPath, env, debugOutput);
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
        // attempts a cooldown-guarded respawn before falling back to CLI.
        return async () => {
            if (await this.ensureDaemonAliveOrFalse()) {
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
        this.deviceIdForRespawn = deviceId;
        try {
            await this.daemon.start(deviceId);
            this.daemonStarted = true;
            this.lastRespawnAt = Date.now();
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
