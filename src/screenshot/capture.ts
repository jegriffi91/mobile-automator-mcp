/**
 * Screenshot capture for iOS Simulators and Android emulators/devices.
 *
 * iOS:     `xcrun simctl io <udid> screenshot <path>`         — writes directly to disk.
 * Android: `adb -s <udid> exec-out screencap -p`              — binary PNG on stdout, piped to disk.
 *
 * Both return a `ScreenshotResult` with the final image path, size on disk,
 * and a truncated stdout/stderr blob for diagnostics.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { truncateOutput, execFileWithAbort } from '../build/utils.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const ADB_MAX_BUFFER = 50 * 1024 * 1024;

export interface ScreenshotOptions {
    /** UDID of the booted simulator or emulator. */
    deviceUdid: string;
    /** Optional absolute path for the PNG. If omitted, a file is created under tmpdir. */
    outputPath?: string;
    /** Per-capture timeout in ms. Default: 30s. */
    timeoutMs?: number;
    /** Optional AbortSignal — on abort, SIGTERM the capture, SIGKILL after 5s. */
    signal?: AbortSignal;
}

export interface ScreenshotResult {
    passed: boolean;
    imagePath: string;
    sizeBytes?: number;
    durationMs: number;
    output: string;
}

function defaultOutputPath(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(os.tmpdir(), 'mobile-automator-screenshots', `screenshot-${ts}.png`);
}

async function ensureParentDir(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Buffer-mode adb screencap with optional abort. Mirrors execFileWithAbort
 * but returns Buffer stdout/stderr — needed because adb screencap writes
 * a binary PNG on stdout.
 */
function execAdbScreencap(
    deviceUdid: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            'adb',
            ['-s', deviceUdid, 'exec-out', 'screencap', '-p'],
            { encoding: 'buffer', timeout: timeoutMs, maxBuffer: ADB_MAX_BUFFER },
            (error, stdout, stderr) => {
                if (signal) signal.removeEventListener('abort', onAbort);
                if (killTimer) clearTimeout(killTimer);
                if (error) {
                    const e = error as NodeJS.ErrnoException & {
                        stdout?: Buffer;
                        stderr?: Buffer;
                    };
                    e.stdout = stdout as Buffer;
                    e.stderr = stderr as Buffer;
                    reject(e);
                    return;
                }
                resolve({ stdout: stdout as Buffer, stderr: stderr as Buffer });
            },
        );
        let killTimer: NodeJS.Timeout | undefined;
        const onAbort = () => {
            try { child.kill('SIGTERM'); } catch { /* gone */ }
            killTimer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* gone */ }
            }, 5000);
            if (killTimer.unref) killTimer.unref();
        };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function statSizeOrUndefined(filePath: string): Promise<number | undefined> {
    try {
        const s = await fs.stat(filePath);
        return s.size;
    } catch {
        return undefined;
    }
}

export async function takeIosScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const imagePath = options.outputPath ?? defaultOutputPath();
    await ensureParentDir(imagePath);

    const start = Date.now();
    const chunks: string[] = [];
    let passed = false;

    try {
        const { stdout, stderr } = await execFileWithAbort(
            'xcrun',
            ['simctl', 'io', options.deviceUdid, 'screenshot', imagePath],
            { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: options.signal },
        );
        chunks.push(stdout, stderr);
        passed = true;
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        chunks.push(e.stdout ?? '', e.stderr ?? '', e.message ?? '');
        if (options.signal?.aborted) {
            chunks.push('[aborted]');
        }
        passed = false;
    }

    const sizeBytes = passed ? await statSizeOrUndefined(imagePath) : undefined;
    if (passed && (sizeBytes === undefined || sizeBytes === 0)) {
        passed = false;
        chunks.push('[screenshot file missing or empty after capture]');
    }

    return {
        passed,
        imagePath,
        sizeBytes,
        durationMs: Date.now() - start,
        output: truncateOutput(chunks.filter(Boolean).join('\n')),
    };
}

export async function takeAndroidScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const imagePath = options.outputPath ?? defaultOutputPath();
    await ensureParentDir(imagePath);

    const start = Date.now();
    const chunks: string[] = [];
    let passed = false;

    try {
        const { stdout, stderr } = await execAdbScreencap(
            options.deviceUdid,
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            options.signal,
        );
        await fs.writeFile(imagePath, stdout);
        const stderrText = stderr.toString('utf8');
        if (stderrText) chunks.push(stderrText);
        passed = true;
    } catch (error: unknown) {
        const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
        const stderrText = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
        chunks.push(stderrText, e.message ?? '');
        if (options.signal?.aborted) {
            chunks.push('[aborted]');
        }
        passed = false;
    }

    const sizeBytes = passed ? await statSizeOrUndefined(imagePath) : undefined;
    if (passed && (sizeBytes === undefined || sizeBytes === 0)) {
        passed = false;
        chunks.push('[screenshot file missing or empty after capture]');
    }

    return {
        passed,
        imagePath,
        sizeBytes,
        durationMs: Date.now() - start,
        output: truncateOutput(chunks.filter(Boolean).join('\n')),
    };
}
