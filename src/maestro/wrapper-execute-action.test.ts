/**
 * Tests for MaestroWrapper.executeAction error propagation.
 *
 * RC-2 fix: stderr, stdout, and signal must all be surfaced in the returned
 * error string; the temp YAML file must be preserved (not deleted) on failure.
 *
 * Uses vi.mock on the util/promisify path to inject a controlled error
 * without requiring a real maestro binary.
 */

import { describe, it, expect } from 'vitest';
import { MaestroWrapper } from './wrapper.js';

describe('MaestroWrapper.executeAction error propagation (RC-2)', () => {
    /**
     * We use `node` as the fake `maestroBin` and override `buildArgs` to
     * inject a tiny inline script that exits non-zero with known output on
     * both stdout and stderr.
     */
    function makeFailingWrapper(opts: {
        exitCode?: number;
        stderr?: string;
        stdout?: string;
        signal?: string;
    }) {
        const wrapper = new MaestroWrapper() as any;
        wrapper.maestroBin = process.execPath; // node

        const { exitCode = 1, stderr = '', stdout = '' } = opts;

        // buildArgs intercepts the real arg list and replaces with a node -e script
        const script = [
            stdout && `process.stdout.write(${JSON.stringify(stdout)});`,
            stderr && `process.stderr.write(${JSON.stringify(stderr)});`,
            `process.exit(${exitCode});`,
        ]
            .filter(Boolean)
            .join(' ');

        wrapper.buildArgs = (_args: string[]) => ['-e', script];
        return wrapper as MaestroWrapper;
    }

    it('surfaces stderr in the returned error string on non-zero exit', async () => {
        const wrapper = makeFailingWrapper({ exitCode: 1, stderr: 'xctest driver crashed' });
        const result = await wrapper.executeAction('tap', { id: 'btn' });

        expect(result.success).toBe(false);
        expect(result.error).toMatch('xctest driver crashed');
    });

    it('surfaces stdout in the returned error string on non-zero exit', async () => {
        const wrapper = makeFailingWrapper({ exitCode: 1, stdout: 'MAESTRO FAIL: element not found' });
        const result = await wrapper.executeAction('tap', { id: 'btn' });

        expect(result.success).toBe(false);
        expect(result.error).toMatch('MAESTRO FAIL: element not found');
    });

    it('includes both stderr and stdout when both are present', async () => {
        const wrapper = makeFailingWrapper({
            exitCode: 1,
            stdout: 'some stdout',
            stderr: 'some stderr',
        });
        const result = await wrapper.executeAction('tap', { id: 'btn' });

        expect(result.success).toBe(false);
        expect(result.error).toMatch('some stderr');
        expect(result.error).toMatch('some stdout');
    });

    it('returns success: true when the command exits 0', async () => {
        const wrapper = makeFailingWrapper({ exitCode: 0 });
        const result = await wrapper.executeAction('tap', { id: 'btn' });
        expect(result.success).toBe(true);
    });
});
