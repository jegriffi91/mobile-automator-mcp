/**
 * Tests for screenshot capture resilience.
 *
 * Uses the `_setExecFileWithAbortForTests` / `_setExecAdbScreencapForTests`
 * DI seams (mirrors the `_setProxymanMcpClientFactory` pattern in handlers.ts)
 * to inject controllable exec stand-ins without spawning real xcrun/adb.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    takeIosScreenshot,
    takeAndroidScreenshot,
    _setExecFileWithAbortForTests,
    _setExecAdbScreencapForTests,
} from './capture.js';

function tmpScreenshotPath(): string {
    const ts = Date.now();
    const rand = Math.floor(Math.random() * 1e9);
    return path.join(os.tmpdir(), 'mobile-automator-screenshot-tests', `shot-${ts}-${rand}.png`);
}

async function writeStubPng(filePath: string): Promise<void> {
    // Minimal non-empty content — capture only checks size > 0.
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

describe('takeIosScreenshot resilience', () => {
    let restoreExec: ReturnType<typeof _setExecFileWithAbortForTests> | null = null;

    afterEach(() => {
        if (restoreExec) {
            _setExecFileWithAbortForTests(restoreExec);
            restoreExec = null;
        }
    });

    it('retries up to 2x on transient failure then succeeds', async () => {
        let calls = 0;
        const imagePath = tmpScreenshotPath();
        try {
            restoreExec = _setExecFileWithAbortForTests(async (file, args) => {
                calls += 1;
                if (calls < 3) {
                    const err: NodeJS.ErrnoException = new Error('xcrun timed out');
                    err.code = 'ETIMEDOUT';
                    throw err;
                }
                // On success, simulate xcrun writing the file.
                const outPath = args[args.length - 1] as string;
                await writeStubPng(outPath);
                return { stdout: '', stderr: '' };
            });

            const result = await takeIosScreenshot({
                deviceUdid: 'sim-123',
                outputPath: imagePath,
                timeoutMs: 5000,
            });
            expect(result.passed).toBe(true);
            expect(calls).toBe(3);
            expect(result.imagePath).toBe(imagePath);
        } finally {
            await fs.rm(imagePath, { force: true });
        }
    });

    it('returns structured passed:false after terminal failure (no throw)', async () => {
        let calls = 0;
        const imagePath = tmpScreenshotPath();
        restoreExec = _setExecFileWithAbortForTests(async () => {
            calls += 1;
            const err: NodeJS.ErrnoException = new Error('xcrun timed out');
            err.code = 'ETIMEDOUT';
            throw err;
        });

        const result = await takeIosScreenshot({
            deviceUdid: 'sim-123',
            outputPath: imagePath,
            timeoutMs: 5000,
        });
        expect(result.passed).toBe(false);
        expect(result.output.length).toBeGreaterThan(0);
        expect(calls).toBe(3); // 1 try + 2 retries
    });

    it('abort during retry exits without sleeping the remaining backoff', async () => {
        const ctrl = new AbortController();
        let calls = 0;
        const imagePath = tmpScreenshotPath();
        restoreExec = _setExecFileWithAbortForTests(async () => {
            calls += 1;
            // After the first attempt, abort — the retry's sleep should reject promptly.
            if (calls === 1) {
                setTimeout(() => ctrl.abort(), 5);
            }
            const err: NodeJS.ErrnoException = new Error('flake');
            err.code = 'ECONNRESET';
            throw err;
        });

        const start = Date.now();
        const result = await takeIosScreenshot({
            deviceUdid: 'sim-123',
            outputPath: imagePath,
            timeoutMs: 5000,
            signal: ctrl.signal,
        });
        const elapsed = Date.now() - start;
        // Should not have waited the full default backoff (250ms+); abort wakes it.
        expect(elapsed).toBeLessThan(2000);
        expect(result.passed).toBe(false);
        expect(calls).toBeLessThanOrEqual(2);
    });
});

describe('takeAndroidScreenshot resilience', () => {
    let restoreExec: ReturnType<typeof _setExecAdbScreencapForTests> | null = null;

    afterEach(() => {
        if (restoreExec) {
            _setExecAdbScreencapForTests(restoreExec);
            restoreExec = null;
        }
    });

    it('retries up to 2x on transient failure then succeeds', async () => {
        let calls = 0;
        const imagePath = tmpScreenshotPath();
        try {
            restoreExec = _setExecAdbScreencapForTests(async () => {
                calls += 1;
                if (calls < 3) {
                    const err: NodeJS.ErrnoException = new Error('adb pipe broke');
                    err.code = 'EPIPE';
                    throw err;
                }
                return {
                    stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
                    stderr: Buffer.alloc(0),
                };
            });

            const result = await takeAndroidScreenshot({
                deviceUdid: 'emu-456',
                outputPath: imagePath,
                timeoutMs: 5000,
            });
            expect(result.passed).toBe(true);
            expect(calls).toBe(3);
        } finally {
            await fs.rm(imagePath, { force: true });
        }
    });

    it('returns structured passed:false after terminal failure (no throw)', async () => {
        const imagePath = tmpScreenshotPath();
        restoreExec = _setExecAdbScreencapForTests(async () => {
            const err: NodeJS.ErrnoException = new Error('adb timed out');
            err.code = 'ETIMEDOUT';
            throw err;
        });

        const result = await takeAndroidScreenshot({
            deviceUdid: 'emu-456',
            outputPath: imagePath,
            timeoutMs: 5000,
        });
        expect(result.passed).toBe(false);
        expect(result.output.length).toBeGreaterThan(0);
    });
});
