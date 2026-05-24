/**
 * Behavioral tests for LoupeDriver.
 *
 * The driver composes a `LoupeClient` (which speaks to Loupe's HTTP server)
 * and a `MaestroWrapper` (which delegates to the Maestro CLI). Tests inject
 * a mock client and replace the wrapper's methods to assert the routing
 * decisions — selector priority for tap, focus-then-type for inputText,
 * delegation for back/swipe/scroll/runTest/setup, and graceful degradation
 * when injection fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoupeDriver } from './loupe-driver.js';
import type { LoupeClient } from './client.js';
import { DEFAULT_TIMEOUTS } from '../types.js';

interface MockLoupeClient {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    getAccessibility: ReturnType<typeof vi.fn>;
    getObservation: ReturnType<typeof vi.fn>;
    probeHealth: ReturnType<typeof vi.fn>;
    tapByTestId: ReturnType<typeof vi.fn>;
    tapByRef: ReturnType<typeof vi.fn>;
    tapAtPoint: ReturnType<typeof vi.fn>;
    typeText: ReturnType<typeof vi.fn>;
    isInjected: boolean;
    currentBundleId: string | undefined;
}

function makeMockClient(): MockLoupeClient {
    return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getAccessibility: vi.fn().mockResolvedValue({ rootRefs: [], nodes: {} }),
        getObservation: vi.fn().mockResolvedValue({ interactive: [] }),
        probeHealth: vi.fn().mockResolvedValue(true),
        tapByTestId: vi.fn().mockResolvedValue(undefined),
        tapByRef: vi.fn().mockResolvedValue(undefined),
        tapAtPoint: vi.fn().mockResolvedValue(undefined),
        typeText: vi.fn().mockResolvedValue(undefined),
        isInjected: false,
        currentBundleId: undefined,
    };
}

/**
 * Build a driver with a mock LoupeClient and a stubbed internal MaestroWrapper.
 * Returns handles to all the spies so individual tests can assert on routing.
 */
function makeDriverWithMocks() {
    const mockClient = makeMockClient();
    const driver = new LoupeDriver(DEFAULT_TIMEOUTS, 'com.example.app', mockClient as unknown as LoupeClient);

    // Replace wrapper methods with spies so we can assert on delegation
    // without touching the real Maestro CLI.
    const wrapperSpies = {
        executeAction: vi.fn().mockResolvedValue({ success: true }),
        runTest: vi.fn().mockResolvedValue({ passed: true, output: '', durationMs: 1 }),
        validateSetup: vi.fn().mockResolvedValue(undefined),
        validateSimulator: vi.fn().mockResolvedValue({ booted: true, deviceId: 'sim-42' }),
        uninstallDriver: vi.fn().mockResolvedValue(undefined),
        ensureCleanDriverState: vi.fn().mockResolvedValue(undefined),
        dumpHierarchy: vi.fn().mockResolvedValue('<from-wrapper/>'),
        dumpHierarchyLite: vi.fn().mockResolvedValue('<from-wrapper/>'),
        dumpHierarchyUntilSettled: vi.fn().mockResolvedValue({
            hierarchy: '<from-wrapper/>',
            settleDurationMs: 0,
        }),
    };
    Object.assign((driver as unknown as { wrapper: typeof wrapperSpies }).wrapper, wrapperSpies);

    return { driver, mockClient, wrapperSpies };
}

async function inject(driver: LoupeDriver): Promise<void> {
    await driver.start('sim-42');
    // start() calls injectOrDegrade which calls client.start; our mock resolves
    // — but the driver only flips `injected` to true on success. Ensure the
    // mock client's start() resolves cleanly (the default in makeMockClient).
}

describe('LoupeDriver — lifecycle', () => {
    it('injects on start when a bundleId was passed to the constructor', async () => {
        const { driver, mockClient } = makeDriverWithMocks();
        await inject(driver);
        expect(mockClient.start).toHaveBeenCalledWith('sim-42', 'com.example.app');
        expect(driver.isRunning).toBe(true);
    });

    it('degrades to wrapper when injection throws', async () => {
        const { driver, mockClient, wrapperSpies } = makeDriverWithMocks();
        mockClient.start.mockRejectedValueOnce(new Error('loupe CLI missing'));

        // Suppress the expected console.error from the failure log.
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await inject(driver);
        expect(driver.isRunning).toBe(false);

        // Every method should now route to the wrapper.
        await driver.dumpHierarchy();
        expect(wrapperSpies.dumpHierarchy).toHaveBeenCalled();
        expect(mockClient.getAccessibility).not.toHaveBeenCalled();

        await driver.executeAction('tap', { id: 'btn' });
        expect(wrapperSpies.executeAction).toHaveBeenCalledWith('tap', { id: 'btn' }, undefined);
        expect(mockClient.tapByTestId).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
    });

    it('setAppContext switches bundle id idempotently', async () => {
        const { driver, mockClient } = makeDriverWithMocks();
        await inject(driver);
        expect(mockClient.start).toHaveBeenCalledTimes(1);

        // Same bundle id — no extra start
        await driver.setAppContext('com.example.app');
        expect(mockClient.start).toHaveBeenCalledTimes(1);

        // Different bundle id — stop + restart
        await driver.setAppContext('com.example.other');
        expect(mockClient.stop).toHaveBeenCalled();
        expect(mockClient.start).toHaveBeenCalledTimes(2);
        expect(mockClient.start).toHaveBeenLastCalledWith('sim-42', 'com.example.other');
    });
});

describe('LoupeDriver — executeAction tap selector priority', () => {
    let setup: ReturnType<typeof makeDriverWithMocks>;
    beforeEach(async () => {
        setup = makeDriverWithMocks();
        await inject(setup.driver);
    });

    it('prefers element.id → tapByTestId', async () => {
        const res = await setup.driver.executeAction('tap', { id: 'login_button' });
        expect(res.success).toBe(true);
        expect(setup.mockClient.tapByTestId).toHaveBeenCalledWith('login_button');
        expect(setup.mockClient.tapByRef).not.toHaveBeenCalled();
        expect(setup.mockClient.tapAtPoint).not.toHaveBeenCalled();
    });

    it('falls back to /observation lookup → tapByRef when only label is set', async () => {
        setup.mockClient.getObservation.mockResolvedValueOnce({
            interactive: [
                { ref: 'r-99', text: 'Submit' },
                { ref: 'r-77', text: 'Cancel' },
            ],
        });
        const res = await setup.driver.executeAction('tap', { accessibilityLabel: 'Submit' });
        expect(res.success).toBe(true);
        expect(setup.mockClient.tapByRef).toHaveBeenCalledWith('r-99');
        expect(setup.mockClient.tapByTestId).not.toHaveBeenCalled();
    });

    it('falls back to bounds center → tapAtPoint when no identifier matches', async () => {
        setup.mockClient.getObservation.mockResolvedValueOnce({ interactive: [] });
        const res = await setup.driver.executeAction('tap', {
            accessibilityLabel: 'Untrackable',
            bounds: { x: 100, y: 200, width: 50, height: 40 },
        });
        expect(res.success).toBe(true);
        expect(setup.mockClient.tapAtPoint).toHaveBeenCalledWith(125, 220);
    });

    it('uses explicit point over bounds center', async () => {
        const res = await setup.driver.executeAction('tap', {
            point: { x: 10, y: 20 },
        });
        expect(res.success).toBe(true);
        expect(setup.mockClient.tapAtPoint).toHaveBeenCalledWith(10, 20);
    });

    it('returns success:false when no usable selector is provided', async () => {
        const res = await setup.driver.executeAction('tap', { role: 'Button' });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/tap requires/);
    });
});

describe('LoupeDriver — executeAction non-tap', () => {
    let setup: ReturnType<typeof makeDriverWithMocks>;
    beforeEach(async () => {
        setup = makeDriverWithMocks();
        await inject(setup.driver);
    });

    it('inputText focuses via tap, then sends the payload', async () => {
        const res = await setup.driver.executeAction('inputText', { id: 'username' }, 'alice');
        expect(res.success).toBe(true);
        expect(setup.mockClient.tapByTestId).toHaveBeenCalledWith('username');
        expect(setup.mockClient.typeText).toHaveBeenCalledWith('alice');
    });

    it('back delegates to the wrapper (Maestro semantics)', async () => {
        const res = await setup.driver.executeAction('back', {});
        expect(res.success).toBe(true);
        expect(setup.wrapperSpies.executeAction).toHaveBeenCalledWith('back', {}, undefined);
    });

    it('swipe delegates to the wrapper', async () => {
        await setup.driver.executeAction('swipe', { id: 'list' });
        expect(setup.wrapperSpies.executeAction).toHaveBeenCalledWith('swipe', { id: 'list' }, undefined);
    });

    it('scrollUntilVisible delegates to the wrapper', async () => {
        await setup.driver.executeAction('scrollUntilVisible', { text: 'foo' });
        expect(setup.wrapperSpies.executeAction).toHaveBeenCalled();
    });
});

describe('LoupeDriver — runTest + setup delegation', () => {
    it('runTest, validateSetup, validateSimulator, uninstallDriver, ensureCleanDriverState all forward to wrapper', async () => {
        const { driver, wrapperSpies } = makeDriverWithMocks();
        // No need to inject — these always delegate.

        await driver.runTest('/tmp/flow.yaml');
        expect(wrapperSpies.runTest).toHaveBeenCalledWith('/tmp/flow.yaml', undefined, undefined, undefined, undefined);

        await driver.validateSetup();
        expect(wrapperSpies.validateSetup).toHaveBeenCalled();

        await driver.validateSimulator('ios');
        expect(wrapperSpies.validateSimulator).toHaveBeenCalledWith('ios');

        await driver.uninstallDriver('ios', 'sim-42');
        expect(wrapperSpies.uninstallDriver).toHaveBeenCalledWith('ios', 'sim-42');

        await driver.ensureCleanDriverState('ios', 'sim-42', { force: true });
        expect(wrapperSpies.ensureCleanDriverState).toHaveBeenCalledWith('ios', 'sim-42', { force: true });
    });
});

describe('LoupeDriver — hierarchy routing', () => {
    it('dumpHierarchy returns JSON of the converted Loupe tree when injected', async () => {
        const { driver, mockClient } = makeDriverWithMocks();
        await inject(driver);
        mockClient.getAccessibility.mockResolvedValueOnce({
            rootRefs: ['n1'],
            nodes: {
                n1: { ref: 'n1', role: 'Application', isVisible: true, children: ['n2'] },
                n2: { ref: 'n2', role: 'Button', testID: 'go', isVisible: true, children: [] },
            },
        });
        const raw = await driver.dumpHierarchy();
        const parsed = JSON.parse(raw);
        expect(parsed.role).toBe('Application');
        expect(parsed.children[0]).toMatchObject({ id: 'go', role: 'Button' });
        expect(parsed.structuralHash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('createTreeReader returns parsed UIHierarchyNode (not stringified)', async () => {
        const { driver, mockClient } = makeDriverWithMocks();
        await inject(driver);
        mockClient.getAccessibility.mockResolvedValueOnce({
            rootRefs: ['n1'],
            nodes: {
                n1: { ref: 'n1', role: 'Application', isVisible: true, children: ['n2'] },
                n2: { ref: 'n2', role: 'Button', testID: 'go', isVisible: true, children: [] },
            },
        });
        const reader = driver.createTreeReader();
        const tree = await reader();
        expect(tree.role).toBe('Application');
        expect(tree.children[0].id).toBe('go');
    });

    it('falls back to wrapper when /accessibility throws', async () => {
        const { driver, mockClient, wrapperSpies } = makeDriverWithMocks();
        await inject(driver);
        mockClient.getAccessibility.mockRejectedValueOnce(new Error('connection refused'));

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await driver.dumpHierarchy();
        expect(result).toBe('<from-wrapper/>');
        expect(wrapperSpies.dumpHierarchy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});
