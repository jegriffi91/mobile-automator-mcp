/**
 * iOS build operations — shells xcodebuild and xcrun simctl.
 *
 * Builds a simulator-compatible .app, finds it in the derived-data tree,
 * extracts the bundle identifier, and exposes install/boot/uninstall helpers.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import {
    findAppBundles,
    extractIosBundleId,
    truncateOutput,
    execFileWithAbort,
} from './utils.js';

const execFileAsync = promisify(execFile);

const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_BOOT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_INSTALL_TIMEOUT_MS = 2 * 60 * 1000;

export interface IosBuildOptions {
    /** Absolute path to a .xcworkspace. Takes precedence over projectPath. */
    workspacePath?: string;
    /** Absolute path to a .xcodeproj. Required if workspacePath is absent. */
    projectPath?: string;
    /** Xcode scheme name. Required. */
    scheme: string;
    /** Build configuration (e.g., "Debug", "Release"). Default: "Debug". */
    configuration?: string;
    /** xcodebuild -destination value. Default: generic simulator. */
    destination?: string;
    /** Where to place build artifacts. Default: tmpdir/mobile-automator-build. */
    derivedDataPath?: string;
    /** Per-build timeout in ms. Default: 15 minutes. */
    timeoutMs?: number;
    /** Optional AbortSignal — on abort, SIGTERM xcodebuild, SIGKILL after 5s. */
    signal?: AbortSignal;
}

export interface IosBuildResult {
    passed: boolean;
    appPath?: string;
    bundleId?: string;
    derivedDataPath: string;
    durationMs: number;
    output: string;
}

export async function buildIosApp(options: IosBuildOptions): Promise<IosBuildResult> {
    if (!options.workspacePath && !options.projectPath) {
        throw new Error('iOS build requires either workspacePath or projectPath');
    }
    const configuration = options.configuration ?? 'Debug';
    const destination = options.destination ?? 'generic/platform=iOS Simulator';
    const derivedDataPath =
        options.derivedDataPath ?? path.join(os.tmpdir(), 'mobile-automator-build');

    const args: string[] = [];
    if (options.workspacePath) {
        args.push('-workspace', options.workspacePath);
    } else if (options.projectPath) {
        args.push('-project', options.projectPath);
    }
    args.push(
        '-scheme', options.scheme,
        '-configuration', configuration,
        '-destination', destination,
        '-derivedDataPath', derivedDataPath,
        'build',
    );

    const start = Date.now();
    let stdoutStderr = '';
    let passed = false;
    try {
        const { stdout, stderr } = await execFileWithAbort('xcodebuild', args, {
            maxBuffer: 50 * 1024 * 1024,
            timeout: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
            signal: options.signal,
        });
        stdoutStderr = [stdout, stderr].filter(Boolean).join('\n');
        passed = true;
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string; name?: string };
        stdoutStderr = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        if (options.signal?.aborted) {
            stdoutStderr = `[aborted] ${stdoutStderr}`;
        }
        passed = false;
    }
    const durationMs = Date.now() - start;

    let appPath: string | undefined;
    let bundleId: string | undefined;
    if (passed) {
        const productsDir = path.join(
            derivedDataPath,
            'Build',
            'Products',
            `${configuration}-iphonesimulator`,
        );
        const apps = await findAppBundles(productsDir);
        if (apps.length > 0) {
            appPath = apps[0];
            try {
                bundleId = await extractIosBundleId(appPath);
            } catch {
                // bundleId extraction is best-effort
            }
        }
    }

    return {
        passed,
        appPath,
        bundleId,
        derivedDataPath,
        durationMs,
        output: truncateOutput(stdoutStderr),
    };
}

export interface IosInstallOptions {
    deviceUdid: string;
    appPath: string;
    signal?: AbortSignal;
}

export interface IosInstallResult {
    passed: boolean;
    bundleId?: string;
    durationMs: number;
    output: string;
}

export async function installIosApp(options: IosInstallOptions): Promise<IosInstallResult> {
    try {
        await fs.access(options.appPath);
    } catch {
        throw new Error(`.app bundle not found at ${options.appPath}`);
    }

    const start = Date.now();
    let output = '';
    let passed = false;
    try {
        const { stdout, stderr } = await execFileWithAbort(
            'xcrun',
            ['simctl', 'install', options.deviceUdid, options.appPath],
            { timeout: DEFAULT_INSTALL_TIMEOUT_MS, signal: options.signal },
        );
        output = [stdout, stderr].filter(Boolean).join('\n');
        passed = true;
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        if (options.signal?.aborted) {
            output = `[aborted] ${output}`;
        }
        passed = false;
    }

    let bundleId: string | undefined;
    if (passed) {
        try {
            bundleId = await extractIosBundleId(options.appPath);
        } catch {
            // Best-effort
        }
    }

    return {
        passed,
        bundleId,
        durationMs: Date.now() - start,
        output: truncateOutput(output),
    };
}

export interface IosUninstallOptions {
    deviceUdid: string;
    bundleId: string;
}

export interface IosUninstallResult {
    passed: boolean;
    durationMs: number;
    output: string;
}

export async function uninstallIosApp(
    options: IosUninstallOptions,
): Promise<IosUninstallResult> {
    const start = Date.now();
    let output = '';
    let passed = false;
    try {
        const { stdout, stderr } = await execFileAsync(
            'xcrun',
            ['simctl', 'uninstall', options.deviceUdid, options.bundleId],
            { timeout: DEFAULT_INSTALL_TIMEOUT_MS },
        );
        output = [stdout, stderr].filter(Boolean).join('\n');
        passed = true;
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        passed = false;
    }
    return {
        passed,
        durationMs: Date.now() - start,
        output: truncateOutput(output),
    };
}

export interface IosBootOptions {
    deviceUdid: string;
    /** Whether to open the Simulator.app UI after booting. Default: true. */
    openSimulatorApp?: boolean;
    /** Wait up to this many ms for the device to reach Booted state. Default: 120s. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface IosBootResult {
    passed: boolean;
    deviceUdid: string;
    state: string;
    alreadyBooted: boolean;
    durationMs: number;
    output: string;
}

async function getSimulatorState(udid: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('xcrun', [
            'simctl', 'list', 'devices', '-j',
        ]);
        const data = JSON.parse(stdout) as {
            devices: Record<string, Array<{ udid: string; state: string }>>;
        };
        for (const list of Object.values(data.devices)) {
            const match = list.find((d) => d.udid === udid);
            if (match) return match.state;
        }
    } catch {
        // swallow — caller treats undefined as unknown
    }
    return undefined;
}

export async function bootIosSimulator(options: IosBootOptions): Promise<IosBootResult> {
    const start = Date.now();
    const initialState = await getSimulatorState(options.deviceUdid);
    const alreadyBooted = initialState === 'Booted';

    const chunks: string[] = [];
    let passed = false;

    try {
        if (!alreadyBooted) {
            const { stdout, stderr } = await execFileWithAbort(
                'xcrun',
                ['simctl', 'boot', options.deviceUdid],
                { timeout: options.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS, signal: options.signal },
            );
            chunks.push(stdout, stderr);
        }

        if (options.openSimulatorApp !== false) {
            try {
                const { stdout, stderr } = await execFileWithAbort(
                    'open',
                    ['-a', 'Simulator'],
                    { timeout: 15_000, signal: options.signal },
                );
                chunks.push(stdout, stderr);
            } catch (err: unknown) {
                const e = err as { message?: string };
                chunks.push(`[open Simulator failed]: ${e.message ?? ''}`);
            }
        }

        try {
            const { stdout, stderr } = await execFileWithAbort(
                'xcrun',
                ['simctl', 'bootstatus', options.deviceUdid, '-b'],
                { timeout: options.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS, signal: options.signal },
            );
            chunks.push(stdout, stderr);
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; message?: string };
            chunks.push(e.stdout ?? '', e.stderr ?? '', e.message ?? '');
        }

        passed = true;
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        chunks.push(e.stdout ?? '', e.stderr ?? '', e.message ?? '');
        if (options.signal?.aborted) {
            chunks.push('[aborted]');
        }
        passed = false;
    }

    const state = (await getSimulatorState(options.deviceUdid)) ?? initialState ?? 'Unknown';
    const output = truncateOutput(chunks.filter(Boolean).join('\n'));

    return {
        passed: passed && state === 'Booted',
        deviceUdid: options.deviceUdid,
        state,
        alreadyBooted,
        durationMs: Date.now() - start,
        output,
    };
}
