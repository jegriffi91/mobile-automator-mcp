/**
 * Tests for MaestroWrapper.runTest opt-in streaming via onLine callback.
 *
 * Uses node as the child process to emit deterministic stdout/stderr lines
 * without requiring a real Maestro installation. Mirrors the approach in
 * src/build/stream.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { MaestroWrapper } from './wrapper.js';

/**
 * Create a wrapper instance whose maestroBin points at `node` and whose
 * buildArgs always returns ['-e', <script>], discarding all Maestro-specific
 * prefixes and the yamlPath suffix.
 *
 * Usage: call `wrapper.runTest('ignored.yaml', ...)`. buildArgs intercepts
 * the assembled args array and replaces everything with [-e, script].
 */
function makeScriptWrapper(script: string): MaestroWrapper {
    const wrapper = new MaestroWrapper() as any;
    wrapper.maestroBin = process.execPath; // node
    // buildArgs receives ['test', ...envArgs, yamlPath]. Replace all of that
    // with [-e, script] so the effective command is: node -e <script>.
    wrapper.buildArgs = (_args: string[]) => ['-e', script];
    return wrapper as MaestroWrapper;
}

describe('MaestroWrapper.runTest streaming (onLine callback)', () => {
    it('calls onLine for each stdout line with stream="stdout"', async () => {
        const lines: Array<{ line: string; stream: string }> = [];
        const wrapper = makeScriptWrapper("console.log('line1'); console.log('line2');");

        await wrapper.runTest(
            'ignored.yaml',
            undefined,
            undefined,
            undefined,
            (line, stream) => lines.push({ line, stream }),
        );

        const stdoutLines = lines.filter((l) => l.stream === 'stdout').map((l) => l.line);
        expect(stdoutLines).toContain('line1');
        expect(stdoutLines).toContain('line2');
    });

    it('calls onLine for stderr lines with stream="stderr"', async () => {
        const lines: Array<{ line: string; stream: string }> = [];
        const wrapper = makeScriptWrapper("console.error('err1'); process.exit(1);");

        await wrapper.runTest(
            'ignored.yaml',
            undefined,
            undefined,
            undefined,
            (line, stream) => lines.push({ line, stream }),
        );

        const stderrLines = lines.filter((l) => l.stream === 'stderr').map((l) => l.line);
        expect(stderrLines).toContain('err1');
    });

    it('returns passed=true when exit code is 0', async () => {
        const wrapper = makeScriptWrapper('process.exit(0);');

        const result = await wrapper.runTest(
            'ignored.yaml',
            undefined,
            undefined,
            undefined,
            vi.fn(),
        );

        expect(result.passed).toBe(true);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns passed=false when exit code is non-zero', async () => {
        const wrapper = makeScriptWrapper('process.exit(1);');

        const result = await wrapper.runTest(
            'ignored.yaml',
            undefined,
            undefined,
            undefined,
            vi.fn(),
        );

        expect(result.passed).toBe(false);
    });

    it('distinguishes stdout vs stderr in same run', async () => {
        const lines: Array<{ line: string; stream: string }> = [];
        const wrapper = makeScriptWrapper(
            "console.log('OUT'); console.error('ERR'); process.exit(0);",
        );

        await wrapper.runTest(
            'ignored.yaml',
            undefined,
            undefined,
            undefined,
            (line, stream) => lines.push({ line, stream }),
        );

        const out = lines.find((l) => l.line === 'OUT');
        const err = lines.find((l) => l.line === 'ERR');
        expect(out?.stream).toBe('stdout');
        expect(err?.stream).toBe('stderr');
    });

    it('falls back to buffered path when onLine is absent', async () => {
        const wrapper = makeScriptWrapper('process.exit(0);');

        // No onLine — uses buffered execFileWithAbort path.
        const result = await wrapper.runTest('ignored.yaml');

        // exit code 0 → passed=true on buffered path
        expect(result.passed).toBe(true);
    });
});
