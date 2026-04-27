/**
 * Android build operations — shells ./gradlew and adb.
 *
 * Builds the specified module+variant, finds the APK under
 * <project>/<module>/build/outputs/apk/<variant>/, and exposes
 * install/uninstall helpers. Booting an emulator is not supported
 * in this iteration — start your emulator manually.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { findApkFiles, truncateOutput, execFileWithAbort } from './utils.js';
import { spawnStream } from './stream.js';

const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INSTALL_TIMEOUT_MS = 2 * 60 * 1000;

export interface AndroidBuildOptions {
    /** Gradle project root (the directory containing ./gradlew). */
    projectPath: string;
    /** Gradle module name. Default: "app". */
    module?: string;
    /** Build variant (e.g., "debug", "release"). Default: "debug". */
    variant?: string;
    /** Per-build timeout in ms. Default: 15 minutes. */
    timeoutMs?: number;
    /** Optional AbortSignal — on abort, SIGTERM gradle, SIGKILL after 5s. */
    signal?: AbortSignal;
    /**
     * If provided, output streams line-by-line through this callback (also
     * captured into the result). When absent, output is buffered until process
     * exit (legacy path).
     */
    onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface AndroidBuildResult {
    passed: boolean;
    apkPath?: string;
    module: string;
    variant: string;
    durationMs: number;
    output: string;
}

function assembleTaskName(module: string, variant: string): string {
    const capitalized = variant.charAt(0).toUpperCase() + variant.slice(1);
    return `:${module}:assemble${capitalized}`;
}

export async function buildAndroidApp(
    options: AndroidBuildOptions,
): Promise<AndroidBuildResult> {
    const module = options.module ?? 'app';
    const variant = options.variant ?? 'debug';
    const task = assembleTaskName(module, variant);
    const gradlew = path.join(options.projectPath, 'gradlew');

    try {
        await fs.access(gradlew);
    } catch {
        throw new Error(
            `./gradlew not found at ${gradlew}. ` +
            `Ensure projectPath points to the Gradle project root.`,
        );
    }

    const start = Date.now();
    let output = '';
    let passed = false;
    if (options.onLine) {
        try {
            const result = await spawnStream(gradlew, [task], {
                cwd: options.projectPath,
                maxBufferBytes: 50 * 1024 * 1024,
                timeout: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
                signal: options.signal,
                onLine: options.onLine,
            });
            output = [result.stdout, result.stderr].filter(Boolean).join('\n');
            passed = result.code === 0 && !result.timedOut && !result.aborted;
            if (result.aborted) output = `[aborted] ${output}`;
            else if (result.timedOut) output = `[timed-out] ${output}`;
        } catch (error: unknown) {
            const e = error as { message?: string };
            output = e.message ?? String(error);
            passed = false;
        }
    } else {
        try {
            const { stdout, stderr } = await execFileWithAbort(gradlew, [task], {
                cwd: options.projectPath,
                maxBuffer: 50 * 1024 * 1024,
                timeout: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
                signal: options.signal,
            });
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
    }

    let apkPath: string | undefined;
    if (passed) {
        const outputDir = path.join(
            options.projectPath,
            module,
            'build',
            'outputs',
            'apk',
            variant,
        );
        const apks = await findApkFiles(outputDir);
        if (apks.length > 0) apkPath = apks[0];
    }

    return {
        passed,
        apkPath,
        module,
        variant,
        durationMs: Date.now() - start,
        output: truncateOutput(output),
    };
}

export interface AndroidInstallOptions {
    deviceUdid: string;
    apkPath: string;
    signal?: AbortSignal;
}

export interface AndroidInstallResult {
    passed: boolean;
    durationMs: number;
    output: string;
}

export async function installAndroidApp(
    options: AndroidInstallOptions,
): Promise<AndroidInstallResult> {
    try {
        await fs.access(options.apkPath);
    } catch {
        throw new Error(`APK not found at ${options.apkPath}`);
    }

    const start = Date.now();
    let output = '';
    let passed = false;
    try {
        const { stdout, stderr } = await execFileWithAbort(
            'adb',
            ['-s', options.deviceUdid, 'install', '-r', options.apkPath],
            { timeout: DEFAULT_INSTALL_TIMEOUT_MS, signal: options.signal },
        );
        output = [stdout, stderr].filter(Boolean).join('\n');
        passed = !/Failure/i.test(output);
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        if (options.signal?.aborted) {
            output = `[aborted] ${output}`;
        }
        passed = false;
    }

    return {
        passed,
        durationMs: Date.now() - start,
        output: truncateOutput(output),
    };
}

export interface AndroidUninstallOptions {
    deviceUdid: string;
    packageName: string;
    signal?: AbortSignal;
}

export interface AndroidUninstallResult {
    passed: boolean;
    durationMs: number;
    output: string;
}

export async function uninstallAndroidApp(
    options: AndroidUninstallOptions,
): Promise<AndroidUninstallResult> {
    const start = Date.now();
    let output = '';
    let passed = false;
    try {
        const { stdout, stderr } = await execFileWithAbort(
            'adb',
            ['-s', options.deviceUdid, 'uninstall', options.packageName],
            { timeout: DEFAULT_INSTALL_TIMEOUT_MS, signal: options.signal },
        );
        output = [stdout, stderr].filter(Boolean).join('\n');
        passed = /Success/i.test(output);
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        if (options.signal?.aborted) {
            output = `[aborted] ${output}`;
        }
        passed = false;
    }
    return {
        passed,
        durationMs: Date.now() - start,
        output: truncateOutput(output),
    };
}
