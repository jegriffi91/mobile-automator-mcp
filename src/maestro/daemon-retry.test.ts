/**
 * Tests for the retry layer wrapping MaestroDaemon.sendRequest, plus the
 * `classifyDaemonError` helper that drives retry decisions and the
 * driver-respawn callback path.
 *
 * The daemon's public action methods (tapOn/inputText/etc) call sendRequest
 * exactly once, so testing retry semantics through them is the realistic
 * coverage path. We patch sendRequestOnce — the per-attempt JSON-RPC round
 * trip — and let the real retry wrapper run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaestroDaemon, classifyDaemonError } from './daemon.js';

/** Build a daemon stubbed past start() with a controllable sendRequestOnce. */
function makeDaemon(): {
    daemon: MaestroDaemon;
    sendRequestOnceSpy: ReturnType<typeof vi.fn>;
} {
    const daemon = new MaestroDaemon();
    (daemon as any).initialized = true;
    (daemon as any).process = { stdin: { writable: true } };
    (daemon as any).deviceId = 'udid-test';

    const sendRequestOnceSpy = vi.fn();
    (daemon as any).sendRequestOnce = sendRequestOnceSpy;
    return { daemon, sendRequestOnceSpy };
}

describe('classifyDaemonError', () => {
    it('classifies AbortError as fatal', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        expect(classifyDaemonError(err)).toBe('fatal');
    });

    it('classifies ZodError as fatal', () => {
        const err = new Error('shape mismatch');
        err.name = 'ZodError';
        expect(classifyDaemonError(err)).toBe('fatal');
    });

    it('classifies XCTest port-22087 connection failures as driver-dead', () => {
        const err = new Error('Failed to connect to /127.0.0.1:22087');
        expect(classifyDaemonError(err)).toBe('driver-dead');
    });

    it('classifies ECONNREFUSED on port 22087 as driver-dead', () => {
        const err = Object.assign(new Error('ECONNREFUSED 127.0.0.1:22087'), { code: 'ECONNREFUSED' });
        expect(classifyDaemonError(err)).toBe('driver-dead');
    });

    it('classifies XCUITest stack traces as driver-dead', () => {
        const err = new Error('XCUITest driver crashed: WebDriverAgent runtime error');
        expect(classifyDaemonError(err)).toBe('driver-dead');
    });

    it('classifies ECONNREFUSED without a known driver port as plain retriable', () => {
        const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' });
        expect(classifyDaemonError(err)).toBe('retriable');
    });

    it('classifies EPIPE / broken pipe as retriable', () => {
        const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        expect(classifyDaemonError(err)).toBe('retriable');
    });

    it('classifies socket hang up as retriable', () => {
        expect(classifyDaemonError(new Error('socket hang up'))).toBe('retriable');
    });

    it('classifies "element not found" structured Maestro errors as fatal', () => {
        expect(classifyDaemonError(new Error('Element not found: id=missing'))).toBe('fatal');
    });

    it('classifies plain timeout messages as retriable', () => {
        expect(classifyDaemonError(new Error('Request timed out after 1000ms'))).toBe('retriable');
    });

    it('classifies unrecognised errors as fatal (default-conservative)', () => {
        expect(classifyDaemonError(new Error('something weird'))).toBe('fatal');
    });

    it('classifies bare strings as fatal', () => {
        expect(classifyDaemonError('boom')).toBe('fatal');
    });
});

describe('MaestroDaemon retry wrapper', () => {
    let daemon: MaestroDaemon;
    let sendRequestOnceSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ({ daemon, sendRequestOnceSpy } = makeDaemon());
    });

    it('eventually succeeds after a retriable failure (EPIPE then ok)', async () => {
        let calls = 0;
        sendRequestOnceSpy.mockImplementation(async () => {
            calls += 1;
            if (calls < 2) {
                const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
                throw err;
            }
            return { content: [{ type: 'text', text: 'ok' }] };
        });

        await daemon.tapOn('udid-test', { id: 'btn' });
        expect(calls).toBe(2);
    });

    it('retries up to 3 attempts then surfaces the final retriable error', async () => {
        let calls = 0;
        sendRequestOnceSpy.mockImplementation(async () => {
            calls += 1;
            const err = Object.assign(new Error(`socket hang up (#${calls})`), { code: 'ECONNRESET' });
            throw err;
        });

        await expect(daemon.tapOn('udid-test', { id: 'btn' })).rejects.toThrow(/socket hang up/);
        expect(calls).toBe(3);
    });

    it('does not retry on a fatal classification', async () => {
        sendRequestOnceSpy.mockRejectedValue(new Error('Element not found: id=missing'));
        await expect(daemon.tapOn('udid-test', { id: 'missing' })).rejects.toThrow('Element not found');
        expect(sendRequestOnceSpy).toHaveBeenCalledTimes(1);
    });

    it('classifies driver-dead errors and invokes the respawn hook before retrying', async () => {
        const respawnHook = vi.fn().mockResolvedValue(undefined);
        daemon.setDriverRespawnHook(respawnHook);

        let calls = 0;
        sendRequestOnceSpy.mockImplementation(async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error('Failed to connect to /127.0.0.1:22087');
            }
            return { content: [] };
        });

        await daemon.tapOn('udid-test', { id: 'btn' });
        expect(respawnHook).toHaveBeenCalledTimes(1);
        expect(calls).toBe(2);
        // Hook fires AFTER the failure but BEFORE the retry attempt.
        const hookOrder = respawnHook.mock.invocationCallOrder[0];
        const secondCallOrder = sendRequestOnceSpy.mock.invocationCallOrder[1];
        expect(hookOrder).toBeLessThan(secondCallOrder);
    });

    it('escalates a second driver-dead error to fatal (single-shot respawn)', async () => {
        const respawnHook = vi.fn().mockResolvedValue(undefined);
        daemon.setDriverRespawnHook(respawnHook);

        sendRequestOnceSpy.mockImplementation(async () => {
            throw new Error('Failed to connect to /127.0.0.1:22087');
        });

        await expect(daemon.tapOn('udid-test', { id: 'btn' })).rejects.toThrow(/22087/);
        // Hook fires once; second driver-dead error is treated as fatal.
        expect(respawnHook).toHaveBeenCalledTimes(1);
        // Two attempts: original + one post-respawn attempt.
        expect(sendRequestOnceSpy).toHaveBeenCalledTimes(2);
    });

    it('does not attempt a respawn when no hook is registered', async () => {
        sendRequestOnceSpy.mockImplementation(async () => {
            throw new Error('Failed to connect to /127.0.0.1:22087');
        });
        await expect(daemon.tapOn('udid-test', { id: 'btn' })).rejects.toThrow(/22087/);
        // Without a hook, driver-dead is still retried as long as classify
        // returns 'driver-dead' on the first call. The escalation gate
        // (`respawned` flag) prevents an infinite loop — first error retries,
        // second classifies driver-dead but `respawned` is still false (no
        // hook fired) so it retries again, third attempt is the final one.
        expect(sendRequestOnceSpy).toHaveBeenCalledTimes(3);
    });
});
