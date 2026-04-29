/**
 * Tests for the Maestro version-check helper introduced when the project
 * pin moved from 2.3.0 → 2.5.0. The wrapper's validateSetup() reads the
 * raw `--version` stdout and pipes it through `checkMaestroVersion`, so
 * unit tests cover the parser/comparator independently.
 */

import { describe, it, expect } from 'vitest';
import { compareVersions, parseMaestroVersion, checkMaestroVersion, MIN_MAESTRO_VERSION } from './env.js';

describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
        expect(compareVersions('2.5.0', '2.5.0')).toBe(0);
    });
    it('returns -1 when a < b across major/minor/patch', () => {
        expect(compareVersions('2.3.0', '2.5.0')).toBe(-1);
        expect(compareVersions('2.5.0', '2.5.1')).toBe(-1);
        expect(compareVersions('1.99.99', '2.0.0')).toBe(-1);
    });
    it('returns 1 when a > b', () => {
        expect(compareVersions('2.5.1', '2.5.0')).toBe(1);
        expect(compareVersions('3.0.0', '2.99.0')).toBe(1);
    });
    it('ignores pre-release suffixes', () => {
        expect(compareVersions('2.5.0-rc1', '2.5.0')).toBe(0);
    });
});

describe('parseMaestroVersion', () => {
    it('extracts versions from various output shapes', () => {
        expect(parseMaestroVersion('2.5.0')).toBe('2.5.0');
        expect(parseMaestroVersion('Maestro CLI 2.5.0')).toBe('2.5.0');
        expect(parseMaestroVersion('cli-2.5.0\n')).toBe('2.5.0');
        expect(parseMaestroVersion('1.40.3 (some-build)')).toBe('1.40.3');
    });
    it('returns null for unparseable output', () => {
        expect(parseMaestroVersion('')).toBeNull();
        expect(parseMaestroVersion('Maestro')).toBeNull();
    });
});

describe('checkMaestroVersion', () => {
    it('returns ok=true when version >= MIN_MAESTRO_VERSION', () => {
        const r = checkMaestroVersion('2.5.0');
        expect(r.ok).toBe(true);
        expect(r.version).toBe('2.5.0');
        expect(r.warning).toBeUndefined();
    });

    it('returns ok=true for newer versions', () => {
        expect(checkMaestroVersion('2.5.1').ok).toBe(true);
        expect(checkMaestroVersion('3.0.0').ok).toBe(true);
    });

    it('returns ok=false with an upgrade warning when version is too old', () => {
        const r = checkMaestroVersion('2.3.0');
        expect(r.ok).toBe(false);
        expect(r.version).toBe('2.3.0');
        expect(r.warning).toContain('2.3.0');
        expect(r.warning).toContain(MIN_MAESTRO_VERSION);
        expect(r.warning).toContain('22087');
    });

    it('returns ok=false with a parse warning when stdout is unintelligible', () => {
        const r = checkMaestroVersion('???');
        expect(r.ok).toBe(false);
        expect(r.version).toBeNull();
        expect(r.warning).toMatch(/Could not parse/);
    });
});
