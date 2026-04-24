import { describe, it, expect } from 'vitest';
import { assertNoActiveSessions } from './driver-conflict.js';
import type { AutomationDriver } from '../maestro/driver.js';

describe('assertNoActiveSessions', () => {
    it('passes when no sessions are active', () => {
        const drivers = new Map<string, AutomationDriver>();
        expect(() => assertNoActiveSessions(drivers, 'run_test')).not.toThrow();
    });

    it('throws with a descriptive message listing active session IDs', () => {
        const drivers = new Map<string, AutomationDriver>();
        drivers.set('session-abc', {} as AutomationDriver);
        drivers.set('session-xyz', {} as AutomationDriver);

        try {
            assertNoActiveSessions(drivers, 'run_test');
            throw new Error('expected to throw');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain("run_test");
            expect(msg).toContain('session-abc');
            expect(msg).toContain('session-xyz');
            expect(msg).toContain('execute_ui_action');
        }
    });

    it('mentions the tool name passed in', () => {
        const drivers = new Map<string, AutomationDriver>();
        drivers.set('s1', {} as AutomationDriver);
        expect(() => assertNoActiveSessions(drivers, 'run_flow')).toThrow(/run_flow/);
    });
});
