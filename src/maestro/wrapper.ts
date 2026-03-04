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

const execFileAsync = promisify(execFile);

export class MaestroWrapper {
    private maestroBin: string;

    constructor(maestroBin?: string) {
        if (maestroBin) {
            this.maestroBin = maestroBin;
        } else {
            // Resolve maestro from common install locations
            const home = os.homedir();
            const candidates = [
                path.join(home, '.maestro', 'bin', 'maestro'),
                '/usr/local/bin/maestro',
                '/opt/homebrew/bin/maestro',
                'maestro', // fallback to PATH
            ];
            this.maestroBin = candidates[candidates.length - 1]; // default fallback
            for (const candidate of candidates) {
                try {
                    require('fs').accessSync(candidate, require('fs').constants.X_OK);
                    this.maestroBin = candidate;
                    break;
                } catch { /* continue */ }
            }
        }
    }

    /**
     * Build an environment map that ensures Java and Maestro are on the PATH.
     */
    private getExecEnv(): Record<string, string> {
        const home = os.homedir();
        const extraPaths = [
            '/opt/homebrew/opt/openjdk/bin',
            path.join(home, '.maestro', 'bin'),
            '/opt/homebrew/bin',
        ];
        const currentPath = process.env['PATH'] || '/usr/bin:/bin';
        return {
            ...process.env as Record<string, string>,
            PATH: [...extraPaths, currentPath].join(':'),
            JAVA_HOME: process.env['JAVA_HOME'] || '/opt/homebrew/opt/openjdk',
        };
    }

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
     * Dump the current UI hierarchy.
     * Exclusively uses `maestro hierarchy` to avoid the unstable `idb` dependency.
     */
    async dumpHierarchy(): Promise<string> {
        try {
            const { stdout } = await execFileAsync(this.maestroBin, ['hierarchy'], { env: this.getExecEnv() });
            return stdout;
        } catch (error: any) {
            console.error('[MaestroWrapper] dumpHierarchy failed:', error);
            throw new Error(`Failed to dump hierarchy: ${error.message || String(error)}`);
        }
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
            await execFileAsync(this.maestroBin, ['test', tmpFile], { env: this.getExecEnv() });

            // Cleanup
            await fs.unlink(tmpFile).catch(() => { });

            return { success: true };
        } catch (error: any) {
            console.error(`[MaestroWrapper] executeAction failed:`, error);
            return { success: false, error: error.message || String(error) };
        }
    }
}
