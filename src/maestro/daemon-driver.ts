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
    /** Stored at start() time so executeAction can pass it to daemon tool calls. */
    private deviceId?: string;

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

    // ── Actions (routed through daemon JSON-RPC; CLI fallback for point-based taps) ──

    async executeAction(
        action: UIActionType,
        element: UIElement,
        textInput?: string,
    ): Promise<{ success: boolean; error?: string }> {
        // If daemon isn't running (or never started), fall back to wrapper for
        // everything so existing CLI behaviour is preserved.
        if (!this.deviceId || !(await this.ensureDaemonAliveOrFalse())) {
            return this.wrapper.executeAction(action, element, textInput);
        }

        try {
            switch (action) {
                case 'tap':
                    if (element.point) {
                        // Point-based taps don't have a daemon equivalent — use the
                        // CLI wrapper. Port-7001 conflict exists but point taps fit
                        // within actionMs (verified in Phase 5 / RC-1 RCA) and we
                        // need the coordinate fallback for custom controls.
                        return this.wrapper.executeAction(action, element, textInput);
                    }
                    if (!element.id && !element.text) {
                        return {
                            success: false,
                            error: 'tap requires element.id or element.text (no point fallback was provided)',
                        };
                    }
                    await this.daemon.tapOn(this.deviceId, {
                        id: element.id,
                        text: element.text,
                    });
                    return { success: true };

                case 'type':
                case 'inputText':
                    if (!textInput) {
                        return { success: false, error: 'inputText requires textInput' };
                    }
                    await this.daemon.inputText(this.deviceId, textInput);
                    return { success: true };

                case 'back':
                    await this.daemon.back(this.deviceId);
                    return { success: true };

                case 'scroll':
                case 'swipe':
                case 'scrollUntilVisible':
                case 'swipeUntilVisible':
                case 'assertVisible':
                    return {
                        success: false,
                        error:
                            `Action '${action}' is not supported via the Maestro daemon. ` +
                            `Supported daemon actions: tap, inputText, back. ` +
                            `For scroll/swipe, use a Maestro flow via run_flow.`,
                    };

                default:
                    return { success: false, error: `Unknown UIActionType: ${action}` };
            }
        } catch (err) {
            // Daemon errors are structured — surface them in the standard shape.
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ── Test execution (daemon doesn't support this — always CLI) ──

    async runTest(
        yamlPath: string,
        env?: Record<string, string>,
        debugOutput?: string,
        signal?: AbortSignal,
        onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
    ): Promise<{ passed: boolean; output: string; durationMs: number }> {
        return this.wrapper.runTest(yamlPath, env, debugOutput, signal, onLine);
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

    async ensureCleanDriverState(
        platform: MobilePlatform,
        deviceId?: string,
        options?: { force?: boolean; probeTimeoutMs?: number },
    ): Promise<void> {
        return this.wrapper.ensureCleanDriverState(platform, deviceId, options);
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
        this.deviceId = deviceId;
        this.deviceIdForRespawn = deviceId;
        // Wire the driver-dead recovery hook BEFORE start() so the initialize
        // handshake itself benefits from it.
        this.daemon.setDriverRespawnHook(async () => {
            console.error('[MaestroDaemonDriver] driver-dead detected, respawning XCTest driver');
            await this.daemon.respawnXCTestDriver();
        });
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
