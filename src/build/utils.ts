/**
 * Shared utilities for build operations.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
