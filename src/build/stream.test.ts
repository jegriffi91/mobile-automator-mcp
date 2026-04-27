import { describe, it, expect } from 'vitest';
import { spawnStream } from './stream.js';

describe('spawnStream', () => {
    it('emits each stdout line via onLine with stream tag', async () => {
        const lines: Array<{ line: string; stream: string }> = [];
        const result = await spawnStream(
            process.execPath,
            ['-e', "console.log('a'); console.log('b'); console.log('c');"],
            {
                onLine: (line, stream) => lines.push({ line, stream }),
            },
        );
        expect(result.code).toBe(0);
        expect(lines.map((l) => l.line)).toEqual(['a', 'b', 'c']);
        expect(lines.every((l) => l.stream === 'stdout')).toBe(true);
    });

    it('distinguishes stdout vs stderr', async () => {
        const lines: Array<{ line: string; stream: string }> = [];
        await spawnStream(
            process.execPath,
            ['-e', "console.log('OUT'); console.error('ERR');"],
            {
                onLine: (line, stream) => lines.push({ line, stream }),
            },
        );
        const out = lines.find((l) => l.line === 'OUT');
        const err = lines.find((l) => l.line === 'ERR');
        expect(out?.stream).toBe('stdout');
        expect(err?.stream).toBe('stderr');
    });

    it('sets code on normal exit', async () => {
        const result = await spawnStream(process.execPath, ['-e', 'process.exit(7)']);
        expect(result.code).toBe(7);
        expect(result.aborted).toBe(false);
        expect(result.timedOut).toBe(false);
    });

    it('aborted=true when signal aborts mid-output', async () => {
        const controller = new AbortController();
        const promise = spawnStream(
            process.execPath,
            [
                '-e',
                "setInterval(() => console.log('tick'), 50); setTimeout(() => {}, 60_000);",
            ],
            { signal: controller.signal },
        );
        // Let it print at least one line.
        await new Promise((r) => setTimeout(r, 80));
        controller.abort();
        const result = await promise;
        expect(result.aborted).toBe(true);
    }, 10_000);

    it('timedOut=true when child exceeds timeout', async () => {
        const result = await spawnStream(
            process.execPath,
            ['-e', "setInterval(() => console.log('tick'), 50); setTimeout(() => {}, 60_000);"],
            { timeout: 200 },
        );
        expect(result.timedOut).toBe(true);
    }, 10_000);

    it('truncates stdout when exceeding maxBufferBytes (head + tail markers)', async () => {
        // Emit ~10KB of stdout but cap at 1KB.
        const result = await spawnStream(
            process.execPath,
            [
                '-e',
                "for (let i = 0; i < 200; i++) console.log('x'.repeat(40) + ' line ' + i);",
            ],
            { maxBufferBytes: 1024 },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('truncated');
        expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(2048);
    });

    it('rejects on spawn error (ENOENT)', async () => {
        await expect(
            spawnStream('/nonexistent/binary-that-should-not-exist', []),
        ).rejects.toThrow();
    });
});
