import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { findAppBundles, findApkFiles, truncateOutput, execFileWithAbort } from './utils.js';

describe('build/utils', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-utils-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    describe('findAppBundles()', () => {
        it('returns empty array when dir does not exist', async () => {
            const result = await findAppBundles(path.join(tmpDir, 'nope'));
            expect(result).toEqual([]);
        });

        it('returns empty array when dir has no .app bundles', async () => {
            await fs.writeFile(path.join(tmpDir, 'random.txt'), '');
            expect(await findAppBundles(tmpDir)).toEqual([]);
        });

        it('finds .app directories', async () => {
            await fs.mkdir(path.join(tmpDir, 'Foo.app'));
            await fs.mkdir(path.join(tmpDir, 'Bar.app'));
            const result = await findAppBundles(tmpDir);
            expect(result.map((p) => path.basename(p))).toEqual(['Bar.app', 'Foo.app']);
        });

        it('ignores files with .app suffix (only directories count)', async () => {
            await fs.writeFile(path.join(tmpDir, 'Fake.app'), 'not a bundle');
            await fs.mkdir(path.join(tmpDir, 'Real.app'));
            const result = await findAppBundles(tmpDir);
            expect(result.map((p) => path.basename(p))).toEqual(['Real.app']);
        });

        it('ignores non-.app directories', async () => {
            await fs.mkdir(path.join(tmpDir, 'Foo.app'));
            await fs.mkdir(path.join(tmpDir, 'OtherDir'));
            const result = await findAppBundles(tmpDir);
            expect(result.map((p) => path.basename(p))).toEqual(['Foo.app']);
        });
    });

    describe('findApkFiles()', () => {
        it('returns empty array when dir does not exist', async () => {
            const result = await findApkFiles(path.join(tmpDir, 'nope'));
            expect(result).toEqual([]);
        });

        it('finds .apk files sorted alphabetically', async () => {
            await fs.writeFile(path.join(tmpDir, 'zulu.apk'), '');
            await fs.writeFile(path.join(tmpDir, 'alpha.apk'), '');
            const result = await findApkFiles(tmpDir);
            expect(result.map((p) => path.basename(p))).toEqual(['alpha.apk', 'zulu.apk']);
        });

        it('ignores non-.apk files', async () => {
            await fs.writeFile(path.join(tmpDir, 'build.log'), '');
            await fs.writeFile(path.join(tmpDir, 'app.apk'), '');
            const result = await findApkFiles(tmpDir);
            expect(result.map((p) => path.basename(p))).toEqual(['app.apk']);
        });

        it('ignores .apk directories (only files count)', async () => {
            await fs.mkdir(path.join(tmpDir, 'fake.apk'));
            await fs.writeFile(path.join(tmpDir, 'real.apk'), '');
            const result = await findApkFiles(tmpDir);
            expect(result.map((p) => path.basename(p))).toEqual(['real.apk']);
        });
    });

    describe('execFileWithAbort()', () => {
        it('resolves normally for short commands', async () => {
            const { stdout } = await execFileWithAbort('node', ['-e', 'console.log("hello")'], {});
            expect(stdout).toContain('hello');
        });

        it('aborts a long-running process via SIGTERM and rejects', async () => {
            const ac = new AbortController();
            const start = Date.now();
            // sleep 30 seconds, then exit
            const promise = execFileWithAbort(
                'node',
                ['-e', 'setTimeout(() => {}, 30000)'],
                { signal: ac.signal },
            );
            // Abort after 50ms
            setTimeout(() => ac.abort(), 50);
            await expect(promise).rejects.toBeDefined();
            const elapsed = Date.now() - start;
            // Should be killed well before the natural 30s exit.
            expect(elapsed).toBeLessThan(5_000);
        });

        it('preexisting aborted signal kills immediately', async () => {
            const ac = new AbortController();
            ac.abort();
            const promise = execFileWithAbort(
                'node',
                ['-e', 'setTimeout(() => {}, 30000)'],
                { signal: ac.signal },
            );
            await expect(promise).rejects.toBeDefined();
        });
    });

    describe('truncateOutput()', () => {
        it('returns unchanged output when under the limit', () => {
            const input = 'line1\nline2\nline3';
            expect(truncateOutput(input, 10)).toBe(input);
        });

        it('truncates long output keeping head and tail', () => {
            const lines = Array.from({ length: 500 }, (_, i) => `line${i + 1}`);
            const result = truncateOutput(lines.join('\n'), 100);
            expect(result).toContain('line1');
            expect(result).toContain('line500');
            expect(result).toContain('400 line(s) truncated');
        });

        it('handles exactly-at-limit output without truncation', () => {
            const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
            const input = lines.join('\n');
            expect(truncateOutput(input, 10)).toBe(input);
        });
    });
});
