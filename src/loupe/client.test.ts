/**
 * Tests for the lower-risk parts of LoupeClient — binary resolution and the
 * "not injected" guards. The CLI/HTTP paths are exercised indirectly through
 * LoupeDriver's tests with a mocked client.
 */

import { describe, it, expect } from 'vitest';
import { LoupeClient, resolveLoupeBin } from './client.js';

describe('resolveLoupeBin', () => {
    it('returns the override path verbatim when provided', () => {
        expect(resolveLoupeBin('/custom/loupe')).toBe('/custom/loupe');
    });

    it('returns a string candidate when no override is given', () => {
        const bin = resolveLoupeBin();
        expect(typeof bin).toBe('string');
        expect(bin.length).toBeGreaterThan(0);
    });
});

describe('LoupeClient — initial state and guards', () => {
    it('is not injected before start()', () => {
        const c = new LoupeClient();
        expect(c.isInjected).toBe(false);
        expect(c.currentBundleId).toBeUndefined();
    });

    it('tap/type/getAccessibility throw before injection', async () => {
        const c = new LoupeClient();
        await expect(c.tapByTestId('foo')).rejects.toThrow(/not injected/);
        await expect(c.tapByRef('r1')).rejects.toThrow(/not injected/);
        await expect(c.tapAtPoint(1, 2)).rejects.toThrow(/not injected/);
        await expect(c.typeText('hi')).rejects.toThrow(/not injected/);
        await expect(c.getAccessibility()).rejects.toThrow(/no port/);
    });

    it('probeHealth returns false before injection (no port)', async () => {
        const c = new LoupeClient();
        const ok = await c.probeHealth();
        expect(ok).toBe(false);
    });

    it('stop() is a no-op before injection', async () => {
        const c = new LoupeClient();
        await expect(c.stop()).resolves.toBeUndefined();
    });
});
