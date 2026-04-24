/**
 * Tests for the feature-test CLI.
 *
 * Focus on the pure functions — arg parsing and summary formatting — which are
 * the only logic the CLI adds on top of the composite runner. End-to-end
 * orchestration is covered by src/featureTest/runner.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs, formatSummary, ArgParseError } from './feature-test.js';
import type { RunFeatureTestOutput } from '../schemas.js';

describe('parseArgs', () => {
    it('accepts a positional spec path', () => {
        const a = parseArgs(['./spec.yaml']);
        expect(a.specPath).toBe('./spec.yaml');
        expect(a.env).toEqual({});
        expect(a.quiet).toBe(false);
    });

    it('accepts --spec in addition to or instead of positional', () => {
        expect(parseArgs(['--spec', '/tmp/s.yaml']).specPath).toBe('/tmp/s.yaml');
    });

    it('rejects two positional arguments', () => {
        expect(() => parseArgs(['a.yaml', 'b.yaml'])).toThrow(ArgParseError);
    });

    it('requires a spec', () => {
        expect(() => parseArgs(['--quiet'])).toThrow(/spec path is required/);
    });

    it('parses --platform, validating the enum', () => {
        expect(parseArgs(['s.yaml', '--platform', 'android']).platform).toBe('android');
        expect(() => parseArgs(['s.yaml', '--platform', 'blackberry'])).toThrow(/must be "ios" or "android"/);
    });

    it('collects repeated --env KEY=VALUE flags', () => {
        const a = parseArgs([
            's.yaml',
            '--env', 'TOKEN=abc',
            '--env', 'USER=alice',
            '--env', 'URL=https://x.test?foo=bar',
        ]);
        expect(a.env).toEqual({
            TOKEN: 'abc',
            USER: 'alice',
            URL: 'https://x.test?foo=bar',
        });
    });

    it('rejects --env without an = sign', () => {
        expect(() => parseArgs(['s.yaml', '--env', 'NOT_KEY_VALUE'])).toThrow(/KEY=VALUE/);
        expect(() => parseArgs(['s.yaml', '--env', '=justvalue'])).toThrow(/KEY=VALUE/);
    });

    it('parses numeric timeout flags', () => {
        const a = parseArgs([
            's.yaml',
            '--setup-timeout-ms', '90000',
            '--action-timeout-ms', '20000',
            '--settle-ms', '2000',
            '--driver-cooldown-ms', '4000',
        ]);
        expect(a.setupTimeoutMs).toBe(90000);
        expect(a.actionTimeoutMs).toBe(20000);
        expect(a.settleMs).toBe(2000);
        expect(a.driverCooldownMs).toBe(4000);
    });

    it('rejects non-integer timeout values', () => {
        expect(() => parseArgs(['s.yaml', '--settle-ms', 'abc'])).toThrow(/non-negative integer/);
        expect(() => parseArgs(['s.yaml', '--settle-ms', '-5'])).toThrow(/non-negative integer/);
        expect(() => parseArgs(['s.yaml', '--settle-ms', '1.5'])).toThrow(/non-negative integer/);
    });

    it('forwards --flows-dir / --stubs-dir', () => {
        const a = parseArgs(['s.yaml', '--flows-dir', '/repo/flows', '--stubs-dir', '/repo/stubs']);
        expect(a.flowsDir).toBe('/repo/flows');
        expect(a.stubsDir).toBe('/repo/stubs');
    });

    it('honors --quiet and -q', () => {
        expect(parseArgs(['s.yaml', '--quiet']).quiet).toBe(true);
        expect(parseArgs(['s.yaml', '-q']).quiet).toBe(true);
    });

    it('surfaces --help via a sentinel error so the caller can print usage and exit 0', () => {
        expect(() => parseArgs(['--help'])).toThrow(/__HELP__/);
        expect(() => parseArgs(['-h'])).toThrow(/__HELP__/);
    });

    it('rejects unknown flags', () => {
        expect(() => parseArgs(['s.yaml', '--nope'])).toThrow(/Unknown flag: --nope/);
    });

    it('rejects a flag that needs a value at the end of argv', () => {
        expect(() => parseArgs(['s.yaml', '--platform'])).toThrow(/--platform requires a value/);
    });
});

describe('formatSummary', () => {
    const passing: RunFeatureTestOutput = {
        passed: true,
        name: 'SDUI parallelism',
        durationMs: 82000,
        setup: {
            passed: true,
            flows: [
                { name: 'login', passed: true, durationMs: 6000 },
                { name: 'navigate', passed: true, durationMs: 4000 },
            ],
        },
        actions: {
            sessionId: 'sess-xyz',
            interactions: [
                { action: 'tap', element: 'point(201,186)', durationMs: 1200 },
                { action: 'wait', element: '5000ms', durationMs: 5001, waitMs: 5000 },
            ],
        },
        assertions: [
            { type: 'parallelism', passed: true, verdict: '6 events in 453ms', details: {} },
            { type: 'performance', passed: true, verdict: 'p95=257ms', details: {} },
        ],
        teardown: {
            flows: [{ name: 'sign-out', passed: true, durationMs: 3000 }],
            compiledYamlPath: '/tmp/sess-xyz.yaml',
        },
    };

    it('renders PASS for a passing result and includes every phase', () => {
        const out = formatSummary(passing);
        expect(out).toContain('PASS  SDUI parallelism');
        expect(out).toContain('[ok] login');
        expect(out).toContain('tap point(201,186)');
        expect(out).toContain('[ok] parallelism: 6 events in 453ms');
        expect(out).toContain('/tmp/sess-xyz.yaml');
    });

    it('renders FAIL and surfaces the top-level error when the test aborted', () => {
        const failed: RunFeatureTestOutput = {
            passed: false,
            name: 'broken',
            durationMs: 14000,
            setup: {
                passed: false,
                flows: [{ name: 'login', passed: false, durationMs: 14000, error: 'Timeout waiting for splash' }],
            },
            actions: { sessionId: '', interactions: [] },
            assertions: [],
            teardown: { flows: [] },
            error: 'Setup phase failed',
        };
        const out = formatSummary(failed);
        expect(out).toContain('FAIL  broken');
        expect(out).toContain('error: Setup phase failed');
        expect(out).toContain('[FAIL] login');
        expect(out).toContain('Timeout waiting for splash');
    });

    it('marks failing assertions but still renders the passing ones', () => {
        const mixed: RunFeatureTestOutput = {
            ...passing,
            passed: false,
            assertions: [
                { type: 'parallelism', passed: false, verdict: 'only 3 events', details: {} },
                { type: 'deduplication', passed: true, verdict: 'no dupes', details: {} },
            ],
        };
        const out = formatSummary(mixed);
        expect(out).toContain('[FAIL] parallelism: only 3 events');
        expect(out).toContain('[ok] deduplication: no dupes');
    });

    it('renders teardown flow failures as WARN rather than FAIL', () => {
        const withTeardownFailure: RunFeatureTestOutput = {
            ...passing,
            teardown: {
                flows: [{ name: 'sign-out', passed: false, durationMs: 2000, error: 'network blip' }],
            },
        };
        const out = formatSummary(withTeardownFailure);
        expect(out).toContain('[WARN] sign-out');
    });
});
