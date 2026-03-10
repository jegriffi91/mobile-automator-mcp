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
import { randomUUID } from 'crypto';
import type { UIActionType, UIElement, MobilePlatform } from '../types.js';
import { resolveMaestroBin, getExecEnv } from './env.js';

const execFileAsync = promisify(execFile);

export class MaestroWrapper {
    /**
     * Strip the "None: \n" prefix that Maestro CLI prepends to hierarchy JSON output.
     * Without this, JSON.parse() fails downstream in HierarchyParser and HierarchyDiffer.
     */
    private static stripHierarchyPrefix(raw: string): string {
        // Maestro outputs "None: \n{...}" — strip everything before the first '{'
        const idx = raw.indexOf('{');
        if (idx > 0) {
            return raw.slice(idx);
        }
        return raw;
    }
    private maestroBin: string;
    private activeDeviceId?: string;

    constructor(maestroBin?: string) {
        this.maestroBin = resolveMaestroBin(maestroBin);
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
            await execFileAsync('java', ['-version'], { env, timeout: 5_000 });
        } catch (error: any) {
            if (error.killed || error.signal === 'SIGTERM') {
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
            await execFileAsync(this.maestroBin, ['--version'], { env, timeout: 5_000 });
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
            const { stdout } = await execFileAsync(this.maestroBin, args, {
                env: getExecEnv(),
                timeout: 15_000, // 15s — fail fast if XCTest driver is dead
            });
            return MaestroWrapper.stripHierarchyPrefix(stdout);
        } catch (error: any) {
            console.error('[MaestroWrapper] dumpHierarchy failed:', error);
            // Clean up the process we just spawned (timeout only kills the parent)
            await this.killStaleMaestroProcesses();

            if (error.killed || error.signal === 'SIGTERM') {
                throw new Error('Hierarchy dump timed out after 15s. Is the simulator responsive?');
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
                timeout: 10_000, // 10s — shorter timeout for frequent polling
            });
            return MaestroWrapper.stripHierarchyPrefix(stdout);
        } catch (error: any) {
            if (error.killed || error.signal === 'SIGTERM') {
                throw new Error('Hierarchy dump (lite) timed out after 10s.');
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
        try {
            let commandStr = '';
            const selector = element.id || element.accessibilityLabel || element.text;

            if (!selector && !element.bounds) {
                return { success: false, error: 'No valid selector (id, label, text, bounds) provided for element.' };
            }

            const getSelectorMap = () => {
                if (element.id) return `id: "${element.id}"`;
                if (element.accessibilityLabel) return `label: "${element.accessibilityLabel}"`;
                if (element.text) return `text: "${element.text}"`;
                if (element.bounds) return `point: ${element.bounds.x},${element.bounds.y}`;
                return '';
            };

            const target = getSelectorMap();

            switch (action) {
                case 'tap':
                    commandStr = `- tapOn:\n    ${target}`;
                    break;
                case 'type':
                    commandStr = `- tapOn:\n    ${target}\n- inputText: "${textInput || ''}"`;
                    break;
                case 'scroll':
                    commandStr = `- scroll`;
                    break;
                case 'swipe':
                    commandStr = `- swipe:\n    direction: DOWN`;
                    break;
                case 'back':
                    commandStr = `- back`;
                    break;
                case 'assertVisible':
                    commandStr = `- assertVisible:\n    ${target}`;
                    break;
                default:
                    return { success: false, error: `Unsupported action: ${action}` };
            }

            const yamlContent = `appId: ""\n---\n${commandStr}\n`;

            const tmpFile = path.join(os.tmpdir(), `maestro-action-${randomUUID()}.yaml`);
            await fs.writeFile(tmpFile, yamlContent, 'utf-8');

            // Execute the temporary script
            await execFileAsync(this.maestroBin, this.buildArgs(['test', tmpFile]), { env: getExecEnv(), timeout: 15_000 });

            // Cleanup
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
    async runTest(yamlPath: string): Promise<{ passed: boolean; output: string; durationMs: number }> {
        const start = Date.now();
        try {
            const { stdout, stderr } = await execFileAsync(
                this.maestroBin,
                this.buildArgs(['test', yamlPath]),
                {
                    env: getExecEnv(),
                    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for verbose output
                    timeout: 120_000, // 120s — full test flows need more time than single actions
                }
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
