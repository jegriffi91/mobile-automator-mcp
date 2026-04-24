/**
 * Tests for MaestroWrapper.probeDriverHealth + ensureCleanDriverState.
 *
 * These cover the Bug #9 fix: probe-first, only uninstall if the XCTest driver
 * isn't responding on port 7001. The probe uses real TCP against an ephemeral
 * port so we don't depend on an actual Maestro install.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'net';
import { MaestroWrapper } from './wrapper.js';

async function listen(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('unexpected server address'));
                return;
            }
            resolve({ server, port: addr.port });
        });
    });
}

async function getFreePort(): Promise<number> {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

describe('MaestroWrapper.probeDriverHealth', () => {
    it('returns true when something is listening on the target port', async () => {
        const { server, port } = await listen();
        try {
            const wrapper = new MaestroWrapper();
            const healthy = await wrapper.probeDriverHealth(500, port);
            expect(healthy).toBe(true);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('returns false when the port is closed (ECONNREFUSED)', async () => {
        const port = await getFreePort();
        const wrapper = new MaestroWrapper();
        const healthy = await wrapper.probeDriverHealth(500, port);
        expect(healthy).toBe(false);
    });

    it('returns false when the probe times out', async () => {
        // 10.255.255.1 is in TEST-NET; connect hangs until timeout rather than
        // being refused. Use a very short timeout so the test stays fast.
        const wrapper = new MaestroWrapper();
        const healthy = await wrapper.probeDriverHealth(150, 7001);
        expect(healthy).toBe(false);
    });
});

describe('MaestroWrapper.ensureCleanDriverState', () => {
    let wrapper: MaestroWrapper;
    let uninstallSpy: ReturnType<typeof vi.spyOn>;
    let probeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        wrapper = new MaestroWrapper(undefined, { driverCooldownMs: 0 });
        uninstallSpy = vi.spyOn(wrapper, 'uninstallDriver').mockResolvedValue();
        probeSpy = vi.spyOn(wrapper, 'probeDriverHealth');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('iOS: skips uninstall when the probe reports a healthy driver', async () => {
        probeSpy.mockResolvedValue(true);
        await wrapper.ensureCleanDriverState('ios', 'UDID-123');
        expect(probeSpy).toHaveBeenCalledOnce();
        expect(uninstallSpy).not.toHaveBeenCalled();
    });

    it('iOS: uninstalls when the probe reports the driver is dead', async () => {
        probeSpy.mockResolvedValue(false);
        await wrapper.ensureCleanDriverState('ios', 'UDID-123');
        expect(probeSpy).toHaveBeenCalledOnce();
        expect(uninstallSpy).toHaveBeenCalledWith('ios', 'UDID-123');
    });

    it('iOS: skips the probe and always uninstalls when force=true', async () => {
        probeSpy.mockResolvedValue(true);
        await wrapper.ensureCleanDriverState('ios', 'UDID-123', { force: true });
        expect(probeSpy).not.toHaveBeenCalled();
        expect(uninstallSpy).toHaveBeenCalledOnce();
    });

    it('iOS: forwards probeTimeoutMs to probeDriverHealth', async () => {
        probeSpy.mockResolvedValue(true);
        await wrapper.ensureCleanDriverState('ios', 'UDID-123', { probeTimeoutMs: 250 });
        expect(probeSpy).toHaveBeenCalledWith(250);
    });

    it('Android: never probes and always uninstalls', async () => {
        await wrapper.ensureCleanDriverState('android', 'emulator-5554');
        expect(probeSpy).not.toHaveBeenCalled();
        expect(uninstallSpy).toHaveBeenCalledWith('android', 'emulator-5554');
    });

    it('honors the configured cooldown after an iOS uninstall', async () => {
        const cooldownWrapper = new MaestroWrapper(undefined, { driverCooldownMs: 25 });
        vi.spyOn(cooldownWrapper, 'uninstallDriver').mockResolvedValue();
        vi.spyOn(cooldownWrapper, 'probeDriverHealth').mockResolvedValue(false);

        const start = Date.now();
        await cooldownWrapper.ensureCleanDriverState('ios', 'UDID-123');
        const elapsed = Date.now() - start;

        // Allow scheduler jitter but verify the cooldown actually took effect.
        expect(elapsed).toBeGreaterThanOrEqual(20);
    });

    it('skips the cooldown when driverCooldownMs is 0', async () => {
        probeSpy.mockResolvedValue(false);
        const start = Date.now();
        await wrapper.ensureCleanDriverState('ios', 'UDID-123');
        const elapsed = Date.now() - start;
        // Probe (mocked) + uninstall (mocked) + no sleep. Should be fast.
        expect(elapsed).toBeLessThan(100);
    });
});
