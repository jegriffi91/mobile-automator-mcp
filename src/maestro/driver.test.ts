import { describe, it, expect, vi } from 'vitest';
import type { AutomationDriver } from './driver.js';
import type { TimeoutConfig } from '../types.js';
import { DEFAULT_TIMEOUTS } from '../types.js';

describe('DEFAULT_TIMEOUTS', () => {
    it('should have all expected timeout fields', () => {
        expect(DEFAULT_TIMEOUTS.hierarchyDumpMs).toBe(30_000);
        expect(DEFAULT_TIMEOUTS.hierarchyLiteMs).toBe(10_000);
        expect(DEFAULT_TIMEOUTS.actionMs).toBe(15_000);
        expect(DEFAULT_TIMEOUTS.testRunMs).toBe(120_000);
        expect(DEFAULT_TIMEOUTS.setupValidationMs).toBe(5_000);
        expect(DEFAULT_TIMEOUTS.daemonRequestMs).toBe(15_000);
        expect(DEFAULT_TIMEOUTS.daemonShutdownMs).toBe(3_000);
        expect(DEFAULT_TIMEOUTS.driverCooldownMs).toBe(3_000);
    });
});

describe('TimeoutConfig merge behavior', () => {
    it('should allow partial overrides to merge with defaults', () => {
        const overrides: Partial<TimeoutConfig> = { testRunMs: 300_000, actionMs: 30_000 };
        const merged: TimeoutConfig = { ...DEFAULT_TIMEOUTS, ...overrides };

        expect(merged.testRunMs).toBe(300_000);
        expect(merged.actionMs).toBe(30_000);
        // Unchanged values should keep defaults
        expect(merged.hierarchyDumpMs).toBe(30_000);
        expect(merged.daemonRequestMs).toBe(15_000);
    });

    it('should produce identical config when override is empty', () => {
        const merged: TimeoutConfig = { ...DEFAULT_TIMEOUTS };
        expect(merged).toEqual(DEFAULT_TIMEOUTS);
    });
});

describe('AutomationDriver interface', () => {
    it('should be implementable as a mock driver', async () => {
        const mockDriver: AutomationDriver = {
            dumpHierarchy: vi.fn().mockResolvedValue('<hierarchy/>'),
            dumpHierarchyLite: vi.fn().mockResolvedValue('<hierarchy/>'),
            dumpHierarchyUntilSettled: vi.fn().mockResolvedValue({
                hierarchy: '<hierarchy/>',
                settleDurationMs: 100,
            }),
            executeAction: vi.fn().mockResolvedValue({ success: true }),
            runTest: vi.fn().mockResolvedValue({ passed: true, output: 'ok', durationMs: 1000 }),
            validateSetup: vi.fn().mockResolvedValue(undefined),
            validateSimulator: vi.fn().mockResolvedValue({ booted: true, deviceId: 'test-123' }),
            uninstallDriver: vi.fn().mockResolvedValue(undefined),
            ensureCleanDriverState: vi.fn().mockResolvedValue(undefined),
            createTreeReader: vi.fn().mockReturnValue(async () => ({
                role: 'view',
                id: 'root',
                children: [],
            })),
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            isRunning: true,
        };

        // Verify all interface methods are callable
        const hierarchy = await mockDriver.dumpHierarchy();
        expect(hierarchy).toBe('<hierarchy/>');

        const result = await mockDriver.executeAction('tap', { id: 'btn' });
        expect(result.success).toBe(true);

        const test = await mockDriver.runTest('/tmp/test.yaml');
        expect(test.passed).toBe(true);

        const sim = await mockDriver.validateSimulator('ios');
        expect(sim.booted).toBe(true);
        expect(sim.deviceId).toBe('test-123');

        const reader = mockDriver.createTreeReader();
        const tree = await reader();
        expect(tree.role).toBe('view');

        expect(mockDriver.isRunning).toBe(true);
    });

    it('should support mock driver with configurable failure', async () => {
        const mockDriver: AutomationDriver = {
            dumpHierarchy: vi.fn().mockRejectedValue(new Error('daemon crashed')),
            dumpHierarchyLite: vi.fn().mockRejectedValue(new Error('daemon crashed')),
            dumpHierarchyUntilSettled: vi.fn().mockRejectedValue(new Error('settle timeout')),
            executeAction: vi.fn().mockResolvedValue({ success: false, error: 'element not found' }),
            runTest: vi.fn().mockResolvedValue({ passed: false, output: 'FAIL', durationMs: 500 }),
            validateSetup: vi.fn().mockRejectedValue(new Error('Java not found')),
            validateSimulator: vi.fn().mockResolvedValue({ booted: false }),
            uninstallDriver: vi.fn().mockResolvedValue(undefined),
            ensureCleanDriverState: vi.fn().mockResolvedValue(undefined),
            createTreeReader: vi.fn().mockReturnValue(async () => {
                throw new Error('hierarchy unavailable');
            }),
            start: vi.fn().mockRejectedValue(new Error('daemon start failed')),
            stop: vi.fn().mockResolvedValue(undefined),
            isRunning: false,
        };

        await expect(mockDriver.dumpHierarchy()).rejects.toThrow('daemon crashed');

        const failResult = await mockDriver.executeAction('tap', { id: 'missing' });
        expect(failResult.success).toBe(false);
        expect(failResult.error).toBe('element not found');

        const sim = await mockDriver.validateSimulator('android');
        expect(sim.booted).toBe(false);
        expect(sim.deviceId).toBeUndefined();

        expect(mockDriver.isRunning).toBe(false);
    });
});
