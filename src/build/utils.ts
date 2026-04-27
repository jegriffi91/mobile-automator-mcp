/**
 * Shared utilities for build operations.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile, type ExecFileOptions } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Run execFile with optional AbortSignal support.
 *
 * On abort: send SIGTERM, then SIGKILL after 5s if still alive. We don't use
 * `detached: true` / process-group kill — that's a behavioral change to spawn
 * semantics that could regress in subtle ways (orphaned children, terminal
 * control, etc). Long-running tools like xcodebuild are well-behaved enough
 * that SIGTERM-then-SIGKILL on the leader process suffices in practice.
 */
export async function execFileWithAbort(
    file: string,
    args: string[],
    options: ExecFileOptions & { signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
    const { signal, ...rest } = options;
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, rest, (error, stdout, stderr) => {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
            if (killTimer) clearTimeout(killTimer);
            if (error) {
                const e = error as NodeJS.ErrnoException & {
                    stdout?: string;
                    stderr?: string;
                };
                e.stdout = typeof stdout === 'string' ? stdout : stdout?.toString() ?? '';
                e.stderr = typeof stderr === 'string' ? stderr : stderr?.toString() ?? '';
                reject(e);
                return;
            }
            resolve({
                stdout: typeof stdout === 'string' ? stdout : stdout.toString(),
                stderr: typeof stderr === 'string' ? stderr : stderr.toString(),
            });
        });

        let killTimer: NodeJS.Timeout | undefined;
        const onAbort = () => {
            try {
                child.kill('SIGTERM');
            } catch {
                // already exited
            }
            killTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // gone
                }
            }, 5000);
            if (killTimer.unref) killTimer.unref();
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
    });
}

/** Find all .app bundles directly inside `dir` (non-recursive). */
export async function findAppBundles(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter((e) => e.isDirectory() && e.name.endsWith('.app'))
            .map((e) => path.join(dir, e.name))
            .sort();
    } catch {
        return [];
    }
}

/** Find all .apk files directly inside `dir` (non-recursive). */
export async function findApkFiles(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter((e) => e.isFile() && e.name.endsWith('.apk'))
            .map((e) => path.join(dir, e.name))
            .sort();
    } catch {
        return [];
    }
}

/**
 * Extract CFBundleIdentifier from an .app bundle's Info.plist using `plutil`.
 * Throws if the plist is missing or the key is absent.
 */
export async function extractIosBundleId(appPath: string): Promise<string> {
    const plistPath = path.join(appPath, 'Info.plist');
    const { stdout } = await execFileAsync('plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        plistPath,
    ]);
    return stdout.trim();
}

/**
 * Truncate long build output so MCP responses stay small. Keeps the first and
 * last portions, drops the middle, and adds a marker line.
 */
export function truncateOutput(output: string, maxLines = 200): string {
    const lines = output.split('\n');
    if (lines.length <= maxLines) return output;
    const half = Math.floor(maxLines / 2);
    const head = lines.slice(0, half).join('\n');
    const tail = lines.slice(-half).join('\n');
    const omitted = lines.length - half * 2;
    return `${head}\n...[${omitted} line(s) truncated]...\n${tail}`;
}
