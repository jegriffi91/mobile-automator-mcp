/**
 * Unit tests for MaestroDaemon JSON-RPC action wrappers.
 *
 * Mocks the internal `sendRequest` private method so we can verify
 * each wrapper sends the correct JSON-RPC payload and correctly parses
 * (or rejects) response shapes without spawning a real `maestro mcp` process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaestroDaemon } from './daemon.js';

/** Helper: create a daemon instance with its internals patched for testing. */
function makeDaemon() {
    const daemon = new MaestroDaemon();
    // Mark as initialized so the guards in each method pass
    (daemon as any).initialized = true;
    (daemon as any).process = { stdin: { writable: true } }; // minimal stub

    // Replace private sendRequest with a spy we can control per-test
    const sendRequestSpy = vi.fn();
    (daemon as any).sendRequest = sendRequestSpy;

    return { daemon, sendRequestSpy };
}

const DEVICE = 'test-device-udid';

// ── tapOn ─────────────────────────────────────────────────────────────────────

describe('MaestroDaemon.tapOn', () => {
    let daemon: MaestroDaemon;
    let sendRequestSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ({ daemon, sendRequestSpy } = makeDaemon());
    });

    it('sends tap_on with id selector', async () => {
        sendRequestSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
        await daemon.tapOn(DEVICE, { id: 'my-button' });

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'tap_on',
            arguments: { device_id: DEVICE, id: 'my-button' },
        });
    });

    it('sends tap_on with text selector', async () => {
        sendRequestSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
        await daemon.tapOn(DEVICE, { text: 'Submit' });

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'tap_on',
            arguments: { device_id: DEVICE, text: 'Submit' },
        });
    });

    it('sends tap_on with index and use_fuzzy_matching', async () => {
        sendRequestSpy.mockResolvedValue({ content: [] });
        await daemon.tapOn(DEVICE, { text: 'Button', index: 2, useFuzzyMatching: true });

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'tap_on',
            arguments: {
                device_id: DEVICE,
                text: 'Button',
                index: 2,
                use_fuzzy_matching: true,
            },
        });
    });

    it('throws when isError is true', async () => {
        sendRequestSpy.mockResolvedValue({
            isError: true,
            content: [{ type: 'text', text: 'Element not found' }],
        });

        await expect(daemon.tapOn(DEVICE, { id: 'missing' })).rejects.toThrow(
            '[MaestroDaemon] tap_on error: Element not found',
        );
    });

    it('throws when daemon is not initialized', async () => {
        (daemon as any).initialized = false;
        await expect(daemon.tapOn(DEVICE, { id: 'x' })).rejects.toThrow('not started');
    });
});

// ── inputText ─────────────────────────────────────────────────────────────────

describe('MaestroDaemon.inputText', () => {
    let daemon: MaestroDaemon;
    let sendRequestSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ({ daemon, sendRequestSpy } = makeDaemon());
    });

    it('sends input_text with device_id and text', async () => {
        sendRequestSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
        await daemon.inputText(DEVICE, 'hello world');

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'input_text',
            arguments: { device_id: DEVICE, text: 'hello world' },
        });
    });

    it('does not include an element selector in the arguments', async () => {
        sendRequestSpy.mockResolvedValue({ content: [] });
        await daemon.inputText(DEVICE, 'pw');

        const call = sendRequestSpy.mock.calls[0];
        const args = call[1].arguments as Record<string, unknown>;
        expect(args).not.toHaveProperty('id');
        expect(args).not.toHaveProperty('text_selector');
        expect(args).not.toHaveProperty('element');
    });

    it('throws when isError is true', async () => {
        sendRequestSpy.mockResolvedValue({
            isError: true,
            content: [{ type: 'text', text: 'No focused element' }],
        });

        await expect(daemon.inputText(DEVICE, 'text')).rejects.toThrow(
            '[MaestroDaemon] input_text error: No focused element',
        );
    });
});

// ── back ──────────────────────────────────────────────────────────────────────

describe('MaestroDaemon.back', () => {
    let daemon: MaestroDaemon;
    let sendRequestSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ({ daemon, sendRequestSpy } = makeDaemon());
    });

    it('sends back with device_id only', async () => {
        sendRequestSpy.mockResolvedValue({ content: [] });
        await daemon.back(DEVICE);

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'back',
            arguments: { device_id: DEVICE },
        });
    });

    it('throws when isError is true', async () => {
        sendRequestSpy.mockResolvedValue({
            isError: true,
            content: [{ type: 'text', text: 'Device unreachable' }],
        });

        await expect(daemon.back(DEVICE)).rejects.toThrow(
            '[MaestroDaemon] back error: Device unreachable',
        );
    });
});

// ── launchApp ─────────────────────────────────────────────────────────────────

describe('MaestroDaemon.launchApp', () => {
    let daemon: MaestroDaemon;
    let sendRequestSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ({ daemon, sendRequestSpy } = makeDaemon());
    });

    it('sends launch_app with device_id and app_id', async () => {
        sendRequestSpy.mockResolvedValue({ content: [] });
        await daemon.launchApp(DEVICE, 'com.example.app');

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'launch_app',
            arguments: { device_id: DEVICE, app_id: 'com.example.app' },
        });
    });

    it('throws when isError is true', async () => {
        sendRequestSpy.mockResolvedValue({
            isError: true,
            content: [{ type: 'text', text: 'App not installed' }],
        });

        await expect(daemon.launchApp(DEVICE, 'com.missing')).rejects.toThrow(
            '[MaestroDaemon] launch_app error: App not installed',
        );
    });
});

// ── stopApp ───────────────────────────────────────────────────────────────────

describe('MaestroDaemon.stopApp', () => {
    let daemon: MaestroDaemon;
    let sendRequestSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ({ daemon, sendRequestSpy } = makeDaemon());
    });

    it('sends stop_app with app_id when provided', async () => {
        sendRequestSpy.mockResolvedValue({ content: [] });
        await daemon.stopApp(DEVICE, 'com.example.app');

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'stop_app',
            arguments: { device_id: DEVICE, app_id: 'com.example.app' },
        });
    });

    it('sends stop_app without app_id when omitted', async () => {
        sendRequestSpy.mockResolvedValue({ content: [] });
        await daemon.stopApp(DEVICE);

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'stop_app',
            arguments: { device_id: DEVICE },
        });
        const call = sendRequestSpy.mock.calls[0];
        expect(call[1].arguments).not.toHaveProperty('app_id');
    });

    it('throws when isError is true', async () => {
        sendRequestSpy.mockResolvedValue({
            isError: true,
            content: [{ type: 'text', text: 'Stop failed' }],
        });

        await expect(daemon.stopApp(DEVICE, 'com.example')).rejects.toThrow(
            '[MaestroDaemon] stop_app error: Stop failed',
        );
    });
});

// ── takeScreenshot ────────────────────────────────────────────────────────────

describe('MaestroDaemon.takeScreenshot', () => {
    let daemon: MaestroDaemon;
    let sendRequestSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ({ daemon, sendRequestSpy } = makeDaemon());
    });

    it('sends take_screenshot with device_id', async () => {
        sendRequestSpy.mockResolvedValue({
            content: [{ type: 'text', text: 'screenshot taken' }],
        });
        await daemon.takeScreenshot(DEVICE);

        expect(sendRequestSpy).toHaveBeenCalledWith('tools/call', {
            name: 'take_screenshot',
            arguments: { device_id: DEVICE },
        });
    });

    it('returns pngBase64 from image content block', async () => {
        sendRequestSpy.mockResolvedValue({
            content: [
                { type: 'image', mimeType: 'image/png', data: 'base64abc' },
                { type: 'text', text: '' },
            ],
        });
        const result = await daemon.takeScreenshot(DEVICE);
        expect(result.pngBase64).toBe('base64abc');
    });

    it('returns rawText from text content block', async () => {
        sendRequestSpy.mockResolvedValue({
            content: [{ type: 'text', text: 'screenshot-path.png' }],
        });
        const result = await daemon.takeScreenshot(DEVICE);
        expect(result.rawText).toBe('screenshot-path.png');
    });

    it('returns undefined pngBase64 when no image block present', async () => {
        sendRequestSpy.mockResolvedValue({
            content: [{ type: 'text', text: 'path/to/screenshot.png' }],
        });
        const result = await daemon.takeScreenshot(DEVICE);
        expect(result.pngBase64).toBeUndefined();
    });

    it('throws when isError is true', async () => {
        sendRequestSpy.mockResolvedValue({
            isError: true,
            content: [{ type: 'text', text: 'Screenshot capture failed' }],
        });

        await expect(daemon.takeScreenshot(DEVICE)).rejects.toThrow(
            '[MaestroDaemon] take_screenshot error: Screenshot capture failed',
        );
    });
});
