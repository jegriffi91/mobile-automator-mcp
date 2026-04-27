import { describe, it, expect } from 'vitest';
import { assertNoActiveSessions } from './driver-conflict.js';

describe('assertNoActiveSessions', () => {
    it('passes when no sessions are active', () => {
        expect(() => assertNoActiveSessions([], 'run_test')).not.toThrow();
    });

    it('throws with a descriptive message listing active session IDs', () => {
        try {
            assertNoActiveSessions(['session-abc', 'session-xyz'], 'run_test');
            throw new Error('expected to throw');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain('run_test');
            expect(msg).toContain('session-abc');
            expect(msg).toContain('session-xyz');
            expect(msg).toContain('execute_ui_action');
        }
    });

    it('mentions the tool name passed in', () => {
        expect(() => assertNoActiveSessions(['s1'], 'run_flow')).toThrow(/run_flow/);
    });
});
