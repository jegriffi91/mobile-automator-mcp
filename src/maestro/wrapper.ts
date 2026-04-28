/**
 * MaestroWrapper — Interface to the Maestro CLI via child_process.
 *
 * Phase 3 will implement:
 *   • validateSimulator(): confirm a booted simulator is available
 *   • dumpHierarchy(): capture the current UI tree as XML
 *   • executeAction(): dispatch tap/type/scroll/swipe/back via Maestro
 *   • startPolling() / stopPolling(): background monitoring of interactions
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Socket } from 'net';
import { randomUUID } from 'crypto';
import type { UIActionType, UIElement, MobilePlatform, TimeoutConfig } from '../types.js';
import { DEFAULT_TIMEOUTS } from '../types.js';
import { resolveMaestroBin, getExecEnv } from './env.js';
import { withRetry, isTransientMaestroError } from './retry.js';
import { execFileWithAbort } from '../build/utils.js';
import { spawnStream } from '../build/stream.js';

/**
 * Port the iOS XCTest driver (XCUITest / WebDriverAgent) listens on. This is
 * fixed by Maestro and isn't configurable per-run, so we can probe it without
 * plumbing a setting through every call site.
 */
const XCTEST_DRIVER_PORT = 7001;

/**
 * JSON-encode a string so it round-trips safely as a YAML scalar. JSON-quoted
 * strings are a strict subset of YAML's flow-style strings, so this gives us
 * correct escaping for quotes, backslashes, newlines, and unicode without
 * needing a YAML dump library. Used by executeAction to emit selectors and
 * inputText payloads.
 */
function yamlString(s: string): string {
    return JSON.stringify(s);
}

export type BuildActionYamlResult =
    | { ok: true; yaml: string; commandStr: string }
    | { ok: false; error: string };

/**
 * Build the Maestro YAML script that `executeAction` writes to a temp file.
 * Pulled out as a pure function so its output (escaping, selector ordering,
 * inputText vs type emission) is unit-testable without invoking the Maestro
 * subprocess.
 */
export function buildActionYaml(
    action: UIActionType,
    element: UIElement,
    textInput?: string,
): BuildActionYamlResult {
    const selector = element.id || element.accessibilityLabel || element.text;
    const hasElement = !!(selector || element.bounds || element.point);

    // Actions that target a specific element. `inputText` and the no-target
    // actions (scroll/swipe/back) are exempt: inputText types into the focused
    // field by design (the reliable path for iOS secure text fields where
    // tapOn+inputText drops focus); scroll/swipe/back operate on the screen
    // directly.
    const SELECTOR_REQUIRED: ReadonlySet<UIActionType> = new Set([
        'tap', 'type', 'scrollUntilVisible', 'swipeUntilVisible', 'assertVisible',
    ]);
    if (SELECTOR_REQUIRED.has(action) && !hasElement) {
        return { ok: false, error: 'No valid selector (id, label, text, bounds, point) provided for element.' };
    }

    // Point takes precedence — it's the explicit escape hatch for custom
    // controls (e.g. Bureau tabs) that don't respond to accessibility selectors.
    const target = (() => {
        if (element.point) return `point: ${element.point.x},${element.point.y}`;
        if (element.id) return `id: ${yamlString(element.id)}`;
        if (element.accessibilityLabel) return `label: ${yamlString(element.accessibilityLabel)}`;
        if (element.text) return `text: ${yamlString(element.text)}`;
        if (element.bounds) return `point: ${element.bounds.x},${element.bounds.y}`;
        return '';
    })();
    const safeText = yamlString(textInput ?? '');

    let commandStr = '';
    switch (action) {
        case 'tap':
            commandStr = `- tapOn:\n    ${target}`;
            break;
        case 'type':
            commandStr = `- tapOn:\n    ${target}\n- inputText: ${safeText}`;
            break;
        case 'inputText':
            // Bare inputText — no preceding tap. Mirrors Maestro's native YAML
            // command exactly. The reliable path for iOS secure text fields
            // where tapOn+inputText fails: the tap can drop focus, animations
            // can shift the cursor, or the strong-password suggestion can
            // intercept input.
            commandStr = `- inputText: ${safeText}`;
            break;
        case 'scroll':
            commandStr = `- scroll`;
            break;
        case 'swipe':
            commandStr = `- swipe:\n    direction: DOWN`;
            break;
        case 'scrollUntilVisible':
            commandStr = `- scrollUntilVisible:\n    element:\n      ${target}\n    direction: DOWN`;
            break;
        case 'swipeUntilVisible':
            commandStr = `- scrollUntilVisible:\n    element:\n      ${target}\n    direction: RIGHT`;
            break;
        case 'back':
            commandStr = `- back`;
            break;
        case 'assertVisible':
            commandStr = `- assertVisible:\n    ${target}`;
            break;
        default:
            return { ok: false, error: `Unsupported action: ${action satisfies never}` };
    }

    return { ok: true, yaml: `appId: ""\n---\n${commandStr}\n`, commandStr };
}

/** Options controlling ensureCleanDriverState's behavior. */
export interface EnsureCleanDriverOptions {
    /**
     * If true, always uninstall + cooldown, skipping the health probe.
     * Use when you know the driver is wedged and MUST be replaced. Default: false.
     */
    force?: boolean;
    /** Timeout for the TCP health probe. Default: 500ms — the probe is best-effort. */
    probeTimeoutMs?: number;
}

const execFileAsync = promisify(execFile);

export class MaestroWrapper {
    /**
     * Strip the "None: \n" prefix that Maestro CLI prepends to hierarchy output.
     * Without this, downstream parsers fail.
     *
     * Handles both legacy JSON ("None: \n{...}") and the CSV format returned by
     * Maestro 2.4.0+ ("element_num,depth,...").
     */
    private static stripHierarchyPrefix(raw: string): string {
        const trimmed = raw.trimStart();
        // Already clean — preserve original (leading whitespace inside is harmless).
        if (trimmed.startsWith('{') || trimmed.startsWith('element_num')) {
            return trimmed;
        }
        // Prefixed output — strip to the first JSON/CSV marker, whichever comes first.
        const jsonIdx = raw.indexOf('{');
        const csvIdx = raw.indexOf('element_num');
        const candidates = [jsonIdx, csvIdx].filter((i) => i > 0);
        if (candidates.length === 0) return raw;
        return raw.slice(Math.min(...candidates));
    }
    private maestroBin: string;
    private activeDeviceId?: string;
    private timeouts: TimeoutConfig;

    constructor(maestroBin?: string, timeouts?: Partial<TimeoutConfig>) {
        this.maestroBin = resolveMaestroBin(maestroBin);
        this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    }

    /**
     * Build Maestro CLI args, prepending `--udid <deviceId>` when a target device
     * is known. This prevents the interactive multi-device selection prompt.
     */
    private buildArgs(subcommandArgs: string[]): string[] {
        if (this.activeDeviceId) {
            return ['--udid', this.activeDeviceId, ...subcommandArgs];
        }
        return subcommandArgs;
    }

    /**
     * Fast-fail validation of Maestro + Java availability.
     * Call once at session start — throws immediately if the toolchain is broken.
     */
    async validateSetup(): Promise<void> {
        const env = getExecEnv();

        // 1. Check Java is reachable
        try {
            await execFileAsync('java', ['-version'], { env, timeout: this.timeouts.setupValidationMs });
        } catch (error: any) {
            if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed || error.signal === 'SIGTERM') {
                throw new Error('Java validation timed out (5s). Is JAVA_HOME set correctly?');
            }
            throw new Error(
                `Java not found. Maestro requires a JDK.\n` +
                `  JAVA_HOME = ${env['JAVA_HOME'] || '(not set)'}\n` +
                `  Error: ${error.message || String(error)}`
            );
        }

        // 2. Check Maestro is executable
        try {
            await execFileAsync(this.maestroBin, ['--version'], { env, timeout: this.timeouts.setupValidationMs });
        } catch (error: any) {
            if (error.killed || error.signal === 'SIGTERM') {
                throw new Error('Maestro validation timed out (5s). Is Maestro installed correctly?');
            }
            throw new Error(
                `Maestro not functional at ${this.maestroBin}.\n` +
                `  Error: ${error.message || String(error)}`
            );
        }

        console.error(`[MaestroWrapper] validateSetup: Java + Maestro OK (bin: ${this.maestroBin})`);
    }

    // getExecEnv() and resolveMaestroBin() moved to env.ts as shared utilities

    /**
     * Validate that a booted iOS/Android simulator is available.
     * Uses native toolchains (xcrun/adb) rather than Maestro for raw availability checking.
     */
    async validateSimulator(platform: MobilePlatform): Promise<{ booted: boolean; deviceId?: string }> {
        try {
            if (platform === 'ios') {
                const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j']);
                const data = JSON.parse(stdout);

                for (const runtime in data.devices) {
                    const devices = data.devices[runtime];
                    for (const device of devices) {
                        if (device.state === 'Booted') {
                            this.activeDeviceId = device.udid;
                            return { booted: true, deviceId: device.udid };
                        }
                    }
                }
                return { booted: false };
            } else if (platform === 'android') {
                const { stdout } = await execFileAsync('adb', ['devices']);
                const lines = stdout.split('\n');
                for (const line of lines.slice(1)) {
                    if (line.includes('\tdevice')) {
                        const deviceId = line.split('\t')[0];
                        this.activeDeviceId = deviceId;
                        return { booted: true, deviceId };
                    }
                }
                return { booted: false };
            }
        } catch (error) {
            console.error(`[MaestroWrapper] validateSimulator failed for ${platform}:`, error);
        }
        return { booted: false };
    }

    /**
     * Uninstall the Maestro UI driver from the target device.
     * On iOS: removes the XCTest runner app. On Android: removes the Maestro server APKs.
     * The next `maestro test` invocation will reinstall a fresh copy automatically.
     */
    async uninstallDriver(platform: MobilePlatform, deviceId?: string): Promise<void> {
        const udid = deviceId || this.activeDeviceId;
        if (!udid) {
            console.error('[MaestroWrapper] uninstallDriver: no device ID — skipping');
            return;
        }

        try {
            if (platform === 'ios') {
                const bundleId = 'dev.mobile.maestro-driver-iosUITests.xctrunner';
                await execFileAsync('xcrun', ['simctl', 'uninstall', udid, bundleId], { timeout: 10_000 });
                console.error(`[MaestroWrapper] uninstallDriver: removed iOS driver (${bundleId}) from ${udid}`);
            } else if (platform === 'android') {
                const adbPath = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
                for (const pkg of ['dev.mobile.maestro.test', 'dev.mobile.maestro']) {
                    await execFileAsync(adbPath, ['-s', udid, 'uninstall', pkg], { timeout: 10_000 }).catch(() => {});
                }
                console.error(`[MaestroWrapper] uninstallDriver: removed Android driver from ${udid}`);
            }
        } catch (error: unknown) {
            // Non-fatal — driver may not be installed yet
            console.error('[MaestroWrapper] uninstallDriver: failed (driver may not be installed):', error);
        }
    }

    /**
     * Probe whether a Maestro driver is currently listening on port 7001.
     *
     * Uses a plain TCP connect with a short timeout. A healthy driver accepts
     * the connection; a dead or missing driver rejects (ECONNREFUSED) or times
     * out. We deliberately do not send any bytes — this is purely a liveness
     * check, not a protocol-level handshake.
     *
     * iOS-only. Android's UiAutomator uses a different transport.
     */
    async probeDriverHealth(
        timeoutMs: number = 500,
        port: number = XCTEST_DRIVER_PORT,
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const socket = new Socket();
            let settled = false;
            const finish = (healthy: boolean) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                resolve(healthy);
            };
            socket.setTimeout(timeoutMs);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
            socket.connect(port, '127.0.0.1');
        });
    }

    /**
     * Ensure the XCTest driver is in a usable state before the next `maestro` call.
     *
     * On iOS: probe port 7001 first. If a driver is already listening, we leave
     * it alone — the prior approach of unconditionally uninstalling + reinstalling
     * turned out to destabilize heavy UI transitions (secure text input + login →
     * dashboard) even with a cooldown, because the freshly-installed XCTRunner
     * was flaky under load (Bug #9). If the probe fails, we fall back to the
     * original uninstall + cooldown path, which is still required to handle the
     * port-7001 TIME_WAIT drain on actual back-to-back runs (Bug #5, commit
     * 02e3819).
     *
     * On Android: uninstall unconditionally — the UiAutomator driver doesn't
     * exhibit the same stability issue and there's no port to probe.
     *
     * Pass `{ force: true }` to skip the probe (e.g., when you already know the
     * driver is wedged and must be replaced).
     */
    async ensureCleanDriverState(
        platform: MobilePlatform,
        deviceId?: string,
        options: EnsureCleanDriverOptions = {},
    ): Promise<void> {
        if (platform === 'ios' && !options.force) {
            const healthy = await this.probeDriverHealth(options.probeTimeoutMs);
            if (healthy) {
                console.error(
                    `[MaestroWrapper] ensureCleanDriverState: driver healthy on port ${XCTEST_DRIVER_PORT} — reusing (skipping uninstall)`,
                );
                return;
            }
            console.error(
                `[MaestroWrapper] ensureCleanDriverState: no driver on port ${XCTEST_DRIVER_PORT} — proceeding with uninstall + cooldown`,
            );
        }

        await this.uninstallDriver(platform, deviceId);
        if (platform === 'ios' && this.timeouts.driverCooldownMs > 0) {
            console.error(
                `[MaestroWrapper] ensureCleanDriverState: iOS cooldown ${this.timeouts.driverCooldownMs}ms (port ${XCTEST_DRIVER_PORT} TIME_WAIT drain)`,
            );
            await new Promise((r) => setTimeout(r, this.timeouts.driverCooldownMs));
        }
    }

    /**
     * Kill any orphaned `maestro hierarchy` Java processes from previous timed-out calls.
     */
    private async killStaleMaestroProcesses(): Promise<void> {
        try {
            await execFileAsync('pkill', ['-f', 'maestro.cli.AppKt hierarchy'], { timeout: 3_000 });
            console.error('[MaestroWrapper] Cleaned up stale maestro hierarchy processes');
            // Brief pause to let the OS reclaim resources
            await new Promise((r) => setTimeout(r, 500));
        } catch {
            // pkill returns non-zero if no matching processes — that's fine
        }
    }

    /**
     * Dump the current UI hierarchy.
     * Exclusively uses `maestro hierarchy` to avoid the unstable `idb` dependency.
     */
    async dumpHierarchy(): Promise<string> {
        // Clean up any orphaned processes from previous timed-out attempts
        await this.killStaleMaestroProcesses();

        try {
            const args = this.buildArgs(['hierarchy']);
            // Retry only transient failures (broken pipe, timeout, stream closed).
            // Caller-surfaced errors like "simulator not booted" are left untouched.
            const { stdout } = await withRetry(
                () => execFileAsync(this.maestroBin, args, {
                    env: getExecEnv(),
                    timeout: this.timeouts.hierarchyDumpMs,
                }),
                {
                    maxAttempts: 3,
                    baseDelayMs: 250,
                    maxDelayMs: 1500,
                    isRetryable: isTransientMaestroError,
                    onRetry: (err, attempt, delayMs) => {
                        console.error(
                            `[MaestroWrapper] dumpHierarchy retry ${attempt} after ${delayMs}ms: ${(err as Error).message}`,
                        );
                    },
                },
            );
            return MaestroWrapper.stripHierarchyPrefix(stdout);
        } catch (error: any) {
            console.error('[MaestroWrapper] dumpHierarchy failed:', error);
            // Clean up the process we just spawned (timeout only kills the parent)
            await this.killStaleMaestroProcesses();

            if (error.killed || error.signal === 'SIGTERM') {
                throw new Error(`Hierarchy dump timed out after ${this.timeouts.hierarchyDumpMs}ms. Is the simulator responsive?`);
            }
            throw new Error(`Failed to dump hierarchy: ${error.message || String(error)}`);
        }
    }

    /**
     * Lightweight hierarchy dump for high-frequency polling.
     *
     * Unlike dumpHierarchy(), this skips the killStaleMaestroProcesses() call
     * which adds 500ms+ of overhead per invocation. This is critical for the
     * TouchInferrer which polls every 500ms — the kill step would prevent it
     * from ever completing a full cycle.
     *
     * Uses a shorter timeout (10s) since polls happen frequently and shouldn't
     * block for extended periods.
     */
    async dumpHierarchyLite(): Promise<string> {
        try {
            const args = this.buildArgs(['hierarchy']);
            const { stdout } = await execFileAsync(this.maestroBin, args, {
                env: getExecEnv(),
                timeout: this.timeouts.hierarchyLiteMs,
            });
            return MaestroWrapper.stripHierarchyPrefix(stdout);
        } catch (error: any) {
            if (error.killed || error.signal === 'SIGTERM') {
                throw new Error(`Hierarchy dump (lite) timed out after ${this.timeouts.hierarchyLiteMs}ms.`);
            }
            throw new Error(`Failed to dump hierarchy (lite): ${error.message || String(error)}`);
        }
    }

    /**
     * Repeatedly dump the hierarchy until the UI has settled (two consecutive
     * snapshots with identical elements). Used by event-triggered capture mode.
     *
     * @param settleTimeoutMs - Max time to wait for settle (default 3000ms)
     * @returns The settled hierarchy JSON and how long the settle took
     */
    async dumpHierarchyUntilSettled(
        settleTimeoutMs = 3000,
    ): Promise<{ hierarchy: string; settleDurationMs: number }> {
        const { HierarchyDiffer } = await import('./hierarchy-differ.js');
        const start = Date.now();
        let previousSnapshot = await this.dumpHierarchy();
        const pollInterval = 300;

        while (Date.now() - start < settleTimeoutMs) {
            await new Promise((r) => setTimeout(r, pollInterval));
            const currentSnapshot = await this.dumpHierarchy();

            if (HierarchyDiffer.areEqual(previousSnapshot, currentSnapshot)) {
                // UI has settled — two consecutive snapshots match
                const settleDurationMs = Date.now() - start;
                console.error(`[MaestroWrapper] dumpHierarchyUntilSettled: settled in ${settleDurationMs}ms`);
                return { hierarchy: currentSnapshot, settleDurationMs };
            }

            previousSnapshot = currentSnapshot;
        }

        // Timeout — return the last snapshot
        const settleDurationMs = Date.now() - start;
        console.error(`[MaestroWrapper] dumpHierarchyUntilSettled: timed out after ${settleDurationMs}ms, returning last snapshot`);
        return { hierarchy: previousSnapshot, settleDurationMs };
    }

    /**
     * Dispatch a UI action to the connected simulator.
     */
    async executeAction(
        action: UIActionType,
        element: UIElement,
        textInput?: string
    ): Promise<{ success: boolean; error?: string }> {
        const built = buildActionYaml(action, element, textInput);
        if (!built.ok) return { success: false, error: built.error };

        try {
            const tmpFile = path.join(os.tmpdir(), `maestro-action-${randomUUID()}.yaml`);
            await fs.writeFile(tmpFile, built.yaml, 'utf-8');
            await execFileAsync(this.maestroBin, this.buildArgs(['test', tmpFile]), { env: getExecEnv(), timeout: this.timeouts.actionMs });
            await fs.unlink(tmpFile).catch(() => { });
            return { success: true };
        } catch (error: any) {
            console.error(`[MaestroWrapper] executeAction failed:`, error);
            return { success: false, error: error.message || String(error) };
        }
    }

    /**
     * Run a Maestro test YAML file and capture results.
     *
     * @param yamlPath - Path to the Maestro YAML test file
     * @returns Test result with pass/fail, output, and duration
     */
    async runTest(
        yamlPath: string,
        env?: Record<string, string>,
        debugOutput?: string,
        signal?: AbortSignal,
        onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
    ): Promise<{ passed: boolean; output: string; durationMs: number }> {
        const start = Date.now();
        const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        const runArgs = ['test', ...envArgs];
        if (debugOutput) {
            runArgs.push('--debug-output', debugOutput);
        }
        runArgs.push(yamlPath);

        if (onLine) {
            // Streaming path: line-by-line via spawnStream.
            try {
                const result = await spawnStream(
                    this.maestroBin,
                    this.buildArgs(runArgs),
                    {
                        env: getExecEnv(),
                        maxBufferBytes: 10 * 1024 * 1024, // 10MB buffer for verbose output
                        timeout: this.timeouts.testRunMs,
                        signal,
                        onLine,
                    },
                );
                const durationMs = Date.now() - start;
                let output = [result.stdout, result.stderr].filter(Boolean).join('\n');
                if (result.aborted) output = `[aborted] ${output}`;
                else if (result.timedOut) output = `[timed-out] ${output}`;
                const passed = result.code === 0 && !result.timedOut && !result.aborted;
                console.error(`[MaestroWrapper] runTest: ${passed ? 'PASSED' : 'FAILED'} in ${durationMs}ms — ${yamlPath}`);
                return { passed, output, durationMs };
            } catch (error: any) {
                const durationMs = Date.now() - start;
                const output = error.message ?? String(error);
                console.error(`[MaestroWrapper] runTest: FAILED in ${durationMs}ms — ${yamlPath}`);
                return { passed: false, output, durationMs };
            }
        }

        // Buffered path (legacy): no streaming, keep existing behaviour verbatim.
        try {
            const { stdout, stderr } = await execFileWithAbort(
                this.maestroBin,
                this.buildArgs(runArgs),
                {
                    env: getExecEnv(),
                    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for verbose output
                    timeout: this.timeouts.testRunMs,
                    signal,
                },
            );
            const durationMs = Date.now() - start;
            const output = [stdout, stderr].filter(Boolean).join('\n');
            console.error(`[MaestroWrapper] runTest: PASSED in ${durationMs}ms — ${yamlPath}`);
            return { passed: true, output, durationMs };
        } catch (error: any) {
            const durationMs = Date.now() - start;
            const output = [error.stdout, error.stderr, error.message]
                .filter(Boolean)
                .join('\n');
            console.error(`[MaestroWrapper] runTest: FAILED in ${durationMs}ms — ${yamlPath}`);
            return { passed: false, output, durationMs };
        }
    }
}
