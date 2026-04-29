/**
 * Integration tests for MaestroDaemonDriver.executeAction.
 *
 * Mocks both the MaestroDaemon action methods and MaestroWrapper.executeAction
 * so no real `maestro` binary is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaestroDaemonDriver } from './daemon-driver.js';
import { DEFAULT_TIMEOUTS } from '../types.js';

const DEVICE = 'B7F81789-18D8-438E-BE13-ED317934E311';

/**
 * Set up a MaestroDaemonDriver with all its private daemon/wrapper dependencies
 * replaced by mocks, and with the daemon already "running" and device set.
 */
function makeDriver() {
    const driver = new MaestroDaemonDriver(DEFAULT_TIMEOUTS);

    // Patch the private `deviceId` field directly
    (driver as any).deviceId = DEVICE;

    // Patch ensureDaemonAliveOrFalse to always return true for these tests
    const ensureDaemonAliveOrFalse = vi.fn().mockResolvedValue(true);
    (driver as any).ensureDaemonAliveOrFalse = ensureDaemonAliveOrFalse;

    // Stub daemon methods
    const daemonTapOn = vi.fn().mockResolvedValue(undefined);
    const daemonInputText = vi.fn().mockResolvedValue(undefined);
    const daemonBack = vi.fn().mockResolvedValue(undefined);
    (driver as any).daemon = {
        tapOn: daemonTapOn,
        inputText: daemonInputText,
        back: daemonBack,
    };

    // Stub wrapper.executeAction
    const wrapperExecuteAction = vi.fn().mockResolvedValue({ success: true });
    (driver as any).wrapper = {
        executeAction: wrapperExecuteAction,
    };

    return {
        driver,
        daemonTapOn,
        daemonInputText,
        daemonBack,
        wrapperExecuteAction,
        ensureDaemonAliveOrFalse,
    };
}

// ── tap with id ───────────────────────────────────────────────────────────────

describe('MaestroDaemonDriver.executeAction — tap', () => {
    let mocks: ReturnType<typeof makeDriver>;

    beforeEach(() => {
        mocks = makeDriver();
    });

    it('tap with element.id → calls daemon.tapOn with { id }', async () => {
        const result = await mocks.driver.executeAction('tap', { id: 'submit-btn' });

        expect(mocks.daemonTapOn).toHaveBeenCalledWith(DEVICE, { id: 'submit-btn', text: undefined });
        expect(mocks.wrapperExecuteAction).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true });
    });

    it('tap with element.text → calls daemon.tapOn with { text }', async () => {
        const result = await mocks.driver.executeAction('tap', { text: 'Submit' });

        expect(mocks.daemonTapOn).toHaveBeenCalledWith(DEVICE, { id: undefined, text: 'Submit' });
        expect(mocks.wrapperExecuteAction).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true });
    });

    it('tap with element.point → falls back to wrapper.executeAction', async () => {
        const element = { point: { x: 100, y: 200 } };
        await mocks.driver.executeAction('tap', element);

        expect(mocks.wrapperExecuteAction).toHaveBeenCalledWith('tap', element, undefined);
        expect(mocks.daemonTapOn).not.toHaveBeenCalled();
    });

    it('tap with no selector and no point → returns error', async () => {
        const result = await mocks.driver.executeAction('tap', {});

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/requires element\.id or element\.text/);
        expect(mocks.daemonTapOn).not.toHaveBeenCalled();
    });

    it('daemon.tapOn throws → returns { success: false, error: <message> }', async () => {
        mocks.daemonTapOn.mockRejectedValue(new Error('[MaestroDaemon] tap_on error: Element not found'));

        const result = await mocks.driver.executeAction('tap', { id: 'ghost' });
        expect(result.success).toBe(false);
        expect(result.error).toMatch('Element not found');
    });
});

// ── inputText / type ──────────────────────────────────────────────────────────

describe('MaestroDaemonDriver.executeAction — inputText / type', () => {
    let mocks: ReturnType<typeof makeDriver>;

    beforeEach(() => {
        mocks = makeDriver();
    });

    it('inputText → calls daemon.inputText with the text', async () => {
        const result = await mocks.driver.executeAction('inputText', {}, 'hello');

        expect(mocks.daemonInputText).toHaveBeenCalledWith(DEVICE, 'hello');
        expect(result).toEqual({ success: true });
    });

    it('type → also calls daemon.inputText (alias)', async () => {
        const result = await mocks.driver.executeAction('type', {}, 'world');

        expect(mocks.daemonInputText).toHaveBeenCalledWith(DEVICE, 'world');
        expect(result).toEqual({ success: true });
    });

    it('inputText with no textInput → returns error', async () => {
        const result = await mocks.driver.executeAction('inputText', {});

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/requires textInput/);
        expect(mocks.daemonInputText).not.toHaveBeenCalled();
    });
});

// ── back ──────────────────────────────────────────────────────────────────────

describe('MaestroDaemonDriver.executeAction — back', () => {
    let mocks: ReturnType<typeof makeDriver>;

    beforeEach(() => {
        mocks = makeDriver();
    });

    it('back → calls daemon.back', async () => {
        const result = await mocks.driver.executeAction('back', {});

        expect(mocks.daemonBack).toHaveBeenCalledWith(DEVICE);
        expect(result).toEqual({ success: true });
    });
});

// ── unsupported actions ───────────────────────────────────────────────────────

describe('MaestroDaemonDriver.executeAction — unsupported actions', () => {
    let mocks: ReturnType<typeof makeDriver>;

    beforeEach(() => {
        mocks = makeDriver();
    });

    for (const action of ['scroll', 'swipe', 'scrollUntilVisible', 'swipeUntilVisible', 'assertVisible'] as const) {
        it(`${action} → returns { success: false, error mentioning run_flow }`, async () => {
            const result = await mocks.driver.executeAction(action, {});

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/run_flow/);
            expect(result.error).toContain(action);
        });
    }
});

// ── daemon not running (fallback to wrapper) ──────────────────────────────────

describe('MaestroDaemonDriver.executeAction — daemon not available', () => {
    it('falls back to wrapper when deviceId is absent', async () => {
        const driver = new MaestroDaemonDriver(DEFAULT_TIMEOUTS);
        // Do NOT set deviceId — simulate pre-start state

        const wrapperExecuteAction = vi.fn().mockResolvedValue({ success: true });
        (driver as any).wrapper = { executeAction: wrapperExecuteAction };

        const result = await driver.executeAction('tap', { id: 'btn' });

        expect(wrapperExecuteAction).toHaveBeenCalledWith('tap', { id: 'btn' }, undefined);
        expect(result).toEqual({ success: true });
    });

    it('falls back to wrapper when ensureDaemonAliveOrFalse returns false', async () => {
        const driver = new MaestroDaemonDriver(DEFAULT_TIMEOUTS);
        (driver as any).deviceId = DEVICE;
        (driver as any).ensureDaemonAliveOrFalse = vi.fn().mockResolvedValue(false);

        const wrapperExecuteAction = vi.fn().mockResolvedValue({ success: true });
        (driver as any).wrapper = { executeAction: wrapperExecuteAction };

        const result = await driver.executeAction('back', {});

        expect(wrapperExecuteAction).toHaveBeenCalledWith('back', {}, undefined);
        expect(result).toEqual({ success: true });
    });
});
