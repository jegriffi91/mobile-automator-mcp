/**
 * Unit/integration tests for the composite runFeatureTest orchestrator.
 *
 * The runner takes a RunnerDeps bag, so these tests drive it with in-memory
 * mocks — no session manager, no driver, no Proxyman. We assert the orchestration
 * contract: which deps are called, in what order, with what arguments, under
 * success and failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { runFeatureTest, loadSpec, type RunnerDeps } from './runner.js';
import type { FeatureTestSpec, RunFeatureTestInput } from '../schemas.js';

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
    const base: RunnerDeps = {
        runFlow: vi.fn().mockResolvedValue({
            passed: true,
            flowName: 'flow',
            flowPath: '/flows/flow.yaml',
            appliedParams: {},
            output: 'ok',
            durationMs: 1000,
        }),
        startRecording: vi.fn().mockResolvedValue({
            sessionId: 'sess-1',
            message: 'ready',
            readiness: { driverReady: true, baselineCaptured: true, pollerStarted: true },
        }),
        installRunnerMock: vi.fn().mockImplementation(async ({ ruleNamePrefix, mock }) => {
            const mockId = mock.id ?? 'mock-default';
            return {
                mockId,
                proxymanRuleId: `RULE-${mockId}`,
                ruleName: `${ruleNamePrefix}:${mockId}`,
            };
        }),
        deleteRunnerMock: vi.fn().mockResolvedValue(undefined),
        executeUIAction: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
        stopAndCompile: vi.fn().mockResolvedValue({
            sessionId: 'sess-1',
            yaml: 'appId: com.example.app',
            yamlPath: '/tmp/sess-1.yaml',
        }),
        verifyParallelism: vi.fn().mockResolvedValue({
            passed: true,
            verdict: '6 events in 400ms',
            count: 6,
            actualSpanMs: 400,
            avgGapMs: 80,
            events: [],
        }),
        verifyOnScreen: vi.fn().mockResolvedValue({
            passed: true,
            verdict: 'All expected calls observed',
            matched: [],
            missing: [],
            extras: [],
        }),
        verifyAbsent: vi.fn().mockResolvedValue({
            passed: true,
            verdict: 'no forbidden calls',
            violations: [],
        }),
        verifySequence: vi.fn().mockResolvedValue({
            passed: true, verdict: 'in order', actualOrder: [],
        }),
        verifyPerformance: vi.fn().mockResolvedValue({
            passed: true, verdict: 'fast', count: 0, unknownDurationCount: 0, totalMs: 0, violators: [],
        }),
        verifyPayload: vi.fn().mockResolvedValue({
            passed: true, verdict: 'payload matches', mismatches: [],
        }),
        verifyDeduplication: vi.fn().mockResolvedValue({
            passed: true, verdict: 'no duplicates', duplicates: [],
        }),
        verifyErrorHandling: vi.fn().mockResolvedValue({
            passed: true, verdict: 'errors matched', errorsFound: [], missingErrors: [],
        }),
        sleep: vi.fn().mockResolvedValue(undefined),
    };
    return { ...base, ...overrides };
}

const MINIMAL_SPEC: FeatureTestSpec = {
    name: 'minimal',
    appBundleId: 'com.example.app',
    setup: [],
    actions: [],
    assertions: [],
    teardown: [],
};

describe('runFeatureTest — happy path', () => {
    it('runs setup → recording → actions → assertions → teardown and returns passed: true', async () => {
        const deps = makeDeps();
        const spec: FeatureTestSpec = {
            ...MINIMAL_SPEC,
            name: 'full lifecycle',
            setup: [{ flow: 'login' }, { flow: 'navigate' }],
            actions: [
                { tap: { point: { x: 201, y: 186 } } },
                { wait: 500 },
            ],
            assertions: [
                { type: 'parallelism', matcher: { pathContains: '/graphql' }, maxWindowMs: 2000, minExpectedCount: 6 },
            ],
            teardown: [{ flow: 'sign-out' }],
        };
        const input: RunFeatureTestInput = { spec };

        const result = await runFeatureTest(input, deps);

        expect(result.passed).toBe(true);
        expect(result.name).toBe('full lifecycle');
        expect(result.setup.passed).toBe(true);
        expect(result.setup.flows).toHaveLength(2);
        expect(result.actions.sessionId).toBe('sess-1');
        expect(result.actions.interactions).toHaveLength(2);
        expect(result.actions.interactions[0]).toMatchObject({ action: 'tap', element: 'point(201,186)' });
        expect(result.actions.interactions[1]).toMatchObject({ action: 'wait', waitMs: 500 });
        expect(result.assertions).toHaveLength(1);
        expect(result.assertions[0].passed).toBe(true);
        expect(result.teardown.flows).toHaveLength(1);
        expect(result.teardown.compiledYamlPath).toBe('/tmp/sess-1.yaml');

        expect(deps.runFlow).toHaveBeenCalledTimes(3); // 2 setup + 1 teardown
        expect(deps.startRecording).toHaveBeenCalledTimes(1);
        expect(deps.executeUIAction).toHaveBeenCalledTimes(1);
        expect(deps.verifyParallelism).toHaveBeenCalledTimes(1);
        expect(deps.stopAndCompile).toHaveBeenCalledTimes(1);
    });

    it('inserts driverCooldown between consecutive setup flows but not after the last one', async () => {
        const deps = makeDeps();
        const spec: FeatureTestSpec = {
            ...MINIMAL_SPEC,
            setup: [{ flow: 'a' }, { flow: 'b' }, { flow: 'c' }],
        };
        await runFeatureTest({ spec, driverCooldownMs: 7777 }, deps);

        const cooldownCalls = vi.mocked(deps.sleep).mock.calls.filter((c) => c[0] === 7777);
        expect(cooldownCalls).toHaveLength(2);
    });

    it('settles for settleMs after actions before running assertions', async () => {
        const deps = makeDeps();
        const calls: string[] = [];
        deps.executeUIAction = vi.fn().mockImplementation(async () => {
            calls.push('action');
            return { success: true, message: 'ok' };
        });
        deps.sleep = vi.fn().mockImplementation(async (ms: number) => {
            if (ms === 2222) calls.push('settle');
        });
        deps.verifyParallelism = vi.fn().mockImplementation(async () => {
            calls.push('assert');
            return { passed: true, verdict: 'ok', count: 0, actualSpanMs: 0, avgGapMs: 0, events: [] };
        });

        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [{ type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 }],
                },
                settleMs: 2222,
            },
            deps,
        );

        expect(calls).toEqual(['action', 'settle', 'assert']);
    });

    it('threads driverCooldownMs into every runFlow call AND startRecording.timeouts', async () => {
        const deps = makeDeps();
        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    setup: [{ flow: 'login' }],
                    actions: [{ tap: { id: 'x' } }],
                    teardown: [{ flow: 'sign-out' }],
                },
                driverCooldownMs: 7500,
            },
            deps,
        );
        // Both setup and teardown flows receive the cooldown
        const runFlowCalls = vi.mocked(deps.runFlow).mock.calls;
        expect(runFlowCalls).toHaveLength(2);
        for (const [arg] of runFlowCalls) {
            expect(arg.driverCooldownMs).toBe(7500);
        }
        // start_recording_session's nested timeouts field picks it up too
        expect(deps.startRecording).toHaveBeenCalledWith(
            expect.objectContaining({
                timeouts: expect.objectContaining({ driverCooldownMs: 7500 }),
            }),
        );
    });

    it('merges top-level env with per-flow params (per-flow wins)', async () => {
        const deps = makeDeps();
        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    setup: [{ flow: 'login', params: { USER: 'alice' } }],
                },
                env: { USER: 'bob', TOKEN: 'abc' },
            },
            deps,
        );
        expect(deps.runFlow).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'login',
                params: { USER: 'alice', TOKEN: 'abc' },
            }),
        );
    });
});

describe('runFeatureTest — failure modes', () => {
    it('aborts and skips recording if a setup flow fails', async () => {
        const deps = makeDeps({
            runFlow: vi.fn()
                .mockResolvedValueOnce({
                    passed: false,
                    flowName: 'login',
                    flowPath: '/flows/login.yaml',
                    appliedParams: {},
                    output: 'Assertion failed: element not found',
                    durationMs: 12000,
                }),
        });
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    setup: [{ flow: 'login' }, { flow: 'navigate' }],
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [{ type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 }],
                },
            },
            deps,
        );

        expect(result.passed).toBe(false);
        expect(result.error).toBe('Setup phase failed');
        expect(result.setup.passed).toBe(false);
        expect(result.setup.flows).toHaveLength(1);
        expect(result.setup.flows[0].error).toContain('Assertion failed');
        expect(deps.startRecording).not.toHaveBeenCalled();
        expect(deps.executeUIAction).not.toHaveBeenCalled();
        expect(deps.verifyParallelism).not.toHaveBeenCalled();
    });

    it('still runs teardown and stopAndCompile even when an action throws', async () => {
        const deps = makeDeps({
            executeUIAction: vi.fn().mockRejectedValue(new Error('driver not ready')),
        });
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [
                        { type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 },
                    ],
                    teardown: [{ flow: 'sign-out' }],
                },
            },
            deps,
        );
        expect(result.passed).toBe(false);
        expect(result.error).toContain('driver not ready');
        // Assertions are skipped when actions failed — the data wouldn't be meaningful
        expect(result.assertions).toHaveLength(0);
        // But teardown + compile still run
        expect(deps.stopAndCompile).toHaveBeenCalledTimes(1);
        expect(result.teardown.flows).toHaveLength(1);
        expect(result.teardown.compiledYamlPath).toBe('/tmp/sess-1.yaml');
    });

    it('treats teardown flow failures as warnings (does not flip overall pass when assertions passed)', async () => {
        const deps = makeDeps({
            runFlow: vi.fn()
                // setup passes, teardown fails
                .mockResolvedValueOnce({ passed: true, flowName: 'login', flowPath: '/flows/login.yaml', appliedParams: {}, output: '', durationMs: 1 })
                .mockResolvedValueOnce({ passed: false, flowName: 'sign-out', flowPath: '/flows/sign-out.yaml', appliedParams: {}, output: 'nope', durationMs: 1 }),
        });
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    setup: [{ flow: 'login' }],
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [{ type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 }],
                    teardown: [{ flow: 'sign-out' }],
                },
            },
            deps,
        );
        expect(result.passed).toBe(true);
        expect(result.teardown.flows[0].passed).toBe(false);
    });

    it('returns passed=false when any assertion fails, but still runs the rest', async () => {
        const deps = makeDeps({
            verifyParallelism: vi.fn().mockResolvedValue({
                passed: false, verdict: 'only 3', count: 3, actualSpanMs: 1000, avgGapMs: 0, events: [],
            }),
        });
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [
                        { type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 6 },
                        { type: 'deduplication', matcher: {}, maxDuplicates: 1 },
                    ],
                },
            },
            deps,
        );
        expect(result.passed).toBe(false);
        expect(result.assertions).toHaveLength(2);
        expect(result.assertions[0].passed).toBe(false);
        expect(result.assertions[1].passed).toBe(true);
        expect(deps.verifyDeduplication).toHaveBeenCalledTimes(1);
    });

    it('captures an assertion crash in the result instead of propagating', async () => {
        const deps = makeDeps({
            verifyParallelism: vi.fn().mockRejectedValue(new Error('HAR export failed')),
        });
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [{ type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 }],
                },
            },
            deps,
        );
        expect(result.passed).toBe(false);
        expect(result.assertions[0].passed).toBe(false);
        expect(result.assertions[0].error).toBe('HAR export failed');
    });
});

describe('runFeatureTest — defaults & action mapping', () => {
    it('defaults on_screen/absent afterAction to { kind: "index", value: 0 } when omitted', async () => {
        const deps = makeDeps();
        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [
                        { type: 'on_screen', expectedCalls: [{ pathContains: '/a' }] },
                        { type: 'absent', forbiddenCalls: [{ pathContains: '/b' }] },
                    ],
                },
            },
            deps,
        );
        expect(deps.verifyOnScreen).toHaveBeenCalledWith(
            expect.objectContaining({ afterAction: { kind: 'index', value: 0 } }),
        );
        expect(deps.verifyAbsent).toHaveBeenCalledWith(
            expect.objectContaining({ afterAction: { kind: 'index', value: 0 } }),
        );
    });

    it('maps `type` action so inline `text` becomes textInput and keeps id as the selector', async () => {
        const deps = makeDeps();
        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    actions: [{ type: { id: 'email-field', text: 'a@b.c' } }],
                },
            },
            deps,
        );
        expect(deps.executeUIAction).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            action: 'type',
            element: { id: 'email-field' },
            textInput: 'a@b.c',
        });
    });

    it('threads filterDomains from spec through to every assertion', async () => {
        const deps = makeDeps();
        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    filterDomains: ['api.example.com'],
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [
                        { type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 },
                    ],
                },
            },
            deps,
        );
        expect(deps.verifyParallelism).toHaveBeenCalledWith(
            expect.objectContaining({ filterDomains: ['api.example.com'] }),
        );
        expect(deps.startRecording).toHaveBeenCalledWith(
            expect.objectContaining({ filterDomains: ['api.example.com'] }),
        );
    });
});

describe('runFeatureTest — mocks in spec (Phase 0 install)', () => {
    it('installs every mock BEFORE setup flows fire (was the loginStatus blocker)', async () => {
        const callOrder: string[] = [];
        const deps = makeDeps({
            installRunnerMock: vi.fn().mockImplementation(async ({ ruleNamePrefix, mock }) => {
                callOrder.push(`installMock:${mock.id ?? 'auto'}`);
                const mockId = mock.id ?? 'auto';
                return {
                    mockId,
                    proxymanRuleId: `RULE-${mockId}`,
                    ruleName: `${ruleNamePrefix}:${mockId}`,
                };
            }),
            runFlow: vi.fn().mockImplementation(async ({ name }) => {
                callOrder.push(`runFlow:${name}`);
                return {
                    passed: true, flowName: name, flowPath: `/flows/${name}.yaml`,
                    appliedParams: {}, output: 'ok', durationMs: 1,
                };
            }),
            startRecording: vi.fn().mockImplementation(async () => {
                callOrder.push('startRecording');
                return {
                    sessionId: 'sess-1',
                    message: 'ready',
                    readiness: { driverReady: true, baselineCaptured: true, pollerStarted: true },
                };
            }),
            executeUIAction: vi.fn().mockImplementation(async () => {
                callOrder.push('action');
                return { success: true, message: 'ok' };
            }),
        });

        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    mocks: [
                        { id: 'login-status', matcher: { pathContains: '/graphql' }, staticResponse: { status: 200 } },
                    ],
                    setup: [{ flow: 'login' }],
                    actions: [{ tap: { id: 'go' } }],
                    assertions: [{ type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 }],
                },
            },
            deps,
        );

        // The whole point of this PR: mocks install BEFORE setup flows so the
        // login-flow's GraphQL call hits the mocked response.
        expect(callOrder).toEqual([
            'installMock:login-status',
            'runFlow:login',
            'startRecording',
            'action',
        ]);
        expect(result.mocks.installed).toHaveLength(1);
        expect(result.mocks.installed[0]).toMatchObject({
            mockId: 'login-status',
            proxymanRuleId: 'RULE-login-status',
        });
        // Rule name uses the runner's run-tag prefix, not a session ID
        expect(result.mocks.installed[0].ruleName).toMatch(/^mca:run-/);
        expect(result.mocks.installed[0].ruleName).toContain('login-status');
        expect(result.passed).toBe(true);
    });

    it('records auto-generated mock IDs when the spec omits them', async () => {
        const deps = makeDeps();
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    mocks: [{ matcher: { pathContains: '/x' }, staticResponse: { status: 200 } }],
                    actions: [{ tap: { id: 'x' } }],
                },
            },
            deps,
        );
        expect(result.mocks.installed).toHaveLength(1);
        expect(result.mocks.installed[0].mockId).toBeTruthy();
        expect(result.mocks.installed[0].proxymanRuleId).toBeTruthy();
    });

    it('aborts the entire test and skips ALL phases when a mock fails to install', async () => {
        const deps = makeDeps({
            installRunnerMock: vi.fn()
                .mockResolvedValueOnce({
                    mockId: 'first',
                    proxymanRuleId: 'RULE-1',
                    ruleName: 'mca:run-X:first',
                })
                .mockRejectedValueOnce(new Error('Proxyman MCP not enabled')),
        });
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    mocks: [
                        { id: 'first', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
                        { id: 'broken', matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
                    ],
                    setup: [{ flow: 'login' }],
                    actions: [{ tap: { id: 'x' } }],
                    assertions: [{ type: 'parallelism', matcher: {}, maxWindowMs: 1000, minExpectedCount: 1 }],
                    teardown: [{ flow: 'sign-out' }],
                },
            },
            deps,
        );

        expect(result.passed).toBe(false);
        expect(result.mocks.installed).toHaveLength(1); // first one succeeded
        expect(result.mocks.error).toContain('Failed to install mock "broken"');
        expect(result.error).toBe(result.mocks.error);

        // None of the post-mock phases run. Setup never logs in; running it
        // with broken mocks would corrupt the test signal.
        expect(deps.runFlow).not.toHaveBeenCalled();
        expect(deps.startRecording).not.toHaveBeenCalled();
        expect(deps.executeUIAction).not.toHaveBeenCalled();
        expect(result.assertions).toHaveLength(0);
        expect(deps.stopAndCompile).not.toHaveBeenCalled();
        expect(result.teardown.flows).toHaveLength(0);
    });

    it('cleans up partially-installed mocks on abort (finally block)', async () => {
        const deps = makeDeps({
            installRunnerMock: vi.fn()
                .mockResolvedValueOnce({
                    mockId: 'first',
                    proxymanRuleId: 'RULE-1',
                    ruleName: 'mca:run-X:first',
                })
                .mockRejectedValueOnce(new Error('boom')),
        });

        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    mocks: [
                        { id: 'first', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
                        { id: 'second', matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
                    ],
                    actions: [{ tap: { id: 'x' } }],
                },
            },
            deps,
        );

        // The first mock got installed before the second one failed → cleanup
        // must still delete it so we don't leak the rule in Proxyman.
        expect(deps.deleteRunnerMock).toHaveBeenCalledTimes(1);
        expect(deps.deleteRunnerMock).toHaveBeenCalledWith('RULE-1');
    });

    it('cleans up runner mocks on the success path too', async () => {
        const deps = makeDeps();
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    mocks: [
                        { id: 'a', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
                        { id: 'b', matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
                    ],
                    actions: [{ tap: { id: 'x' } }],
                },
            },
            deps,
        );
        expect(result.passed).toBe(true);
        expect(deps.deleteRunnerMock).toHaveBeenCalledTimes(2);
        expect(deps.deleteRunnerMock).toHaveBeenCalledWith('RULE-a');
        expect(deps.deleteRunnerMock).toHaveBeenCalledWith('RULE-b');
    });

    it('cleans up even when actions throw partway through', async () => {
        const deps = makeDeps({
            executeUIAction: vi.fn().mockRejectedValue(new Error('driver crashed')),
        });
        await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    mocks: [{ id: 'a', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } }],
                    actions: [{ tap: { id: 'x' } }],
                },
            },
            deps,
        );
        expect(deps.deleteRunnerMock).toHaveBeenCalledWith('RULE-a');
    });

    it('treats spec.mocks default ([]) as a no-op — existing behavior unchanged', async () => {
        const deps = makeDeps();
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    actions: [{ tap: { id: 'x' } }],
                },
            },
            deps,
        );
        expect(deps.installRunnerMock).not.toHaveBeenCalled();
        expect(deps.deleteRunnerMock).not.toHaveBeenCalled();
        expect(result.mocks.installed).toEqual([]);
        expect(result.passed).toBe(true);
    });

    it('continues if cleanup fails (non-fatal)', async () => {
        const deps = makeDeps({
            deleteRunnerMock: vi.fn().mockRejectedValue(new Error('Proxyman went away')),
        });
        const result = await runFeatureTest(
            {
                spec: {
                    ...MINIMAL_SPEC,
                    mocks: [{ id: 'a', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } }],
                    actions: [{ tap: { id: 'x' } }],
                },
            },
            deps,
        );
        // Test still reports success; cleanup-failure logs but doesn't override
        // the test outcome (the rule stays in Proxyman, but that's a leak the
        // user can clean up manually — vs. crashing here would mask the real
        // pass/fail signal).
        expect(result.passed).toBe(true);
    });
});

describe('runFeatureTest — CLI fallback (MCA_FEATURE_TEST_CLI_FALLBACK)', () => {
    const originalFlag = process.env['MCA_FEATURE_TEST_CLI_FALLBACK'];
    beforeEach(() => {
        delete process.env['MCA_FEATURE_TEST_CLI_FALLBACK'];
    });
    afterEach(() => {
        if (originalFlag === undefined) {
            delete process.env['MCA_FEATURE_TEST_CLI_FALLBACK'];
        } else {
            process.env['MCA_FEATURE_TEST_CLI_FALLBACK'] = originalFlag;
        }
    });

    it('flag unset, daemon healthy → daemon path, no CLI invoked', async () => {
        const cliSpy = vi.fn();
        const deps = makeDeps({ executeUIActionCli: cliSpy });
        const result = await runFeatureTest(
            { spec: { ...MINIMAL_SPEC, actions: [{ tap: { id: 'x' } }] } },
            deps,
        );
        expect(result.passed).toBe(true);
        expect(deps.executeUIAction).toHaveBeenCalledTimes(1);
        expect(cliSpy).not.toHaveBeenCalled();
        expect(result.actions.interactions[0].transport).toBe('daemon');
    });

    it('flag unset, daemon fails → bubbles error (current behavior preserved)', async () => {
        const cliSpy = vi.fn();
        const deps = makeDeps({
            executeUIAction: vi.fn().mockRejectedValue(new Error('daemon dead')),
            executeUIActionCli: cliSpy,
        });
        const result = await runFeatureTest(
            { spec: { ...MINIMAL_SPEC, actions: [{ tap: { id: 'x' } }] } },
            deps,
        );
        expect(result.passed).toBe(false);
        expect(result.error).toContain('daemon dead');
        expect(cliSpy).not.toHaveBeenCalled();
    });

    it('flag set, daemon healthy → daemon path, no CLI invoked', async () => {
        process.env['MCA_FEATURE_TEST_CLI_FALLBACK'] = '1';
        const cliSpy = vi.fn();
        const deps = makeDeps({ executeUIActionCli: cliSpy });
        const result = await runFeatureTest(
            { spec: { ...MINIMAL_SPEC, actions: [{ tap: { id: 'x' } }] } },
            deps,
        );
        expect(result.passed).toBe(true);
        expect(cliSpy).not.toHaveBeenCalled();
        expect(result.actions.interactions[0].transport).toBe('daemon');
    });

    it('flag set, daemon fails → CLI fallback runs and result reports transport=cli-fallback', async () => {
        process.env['MCA_FEATURE_TEST_CLI_FALLBACK'] = '1';
        const cliSpy = vi.fn().mockResolvedValue({ success: true, message: 'cli ok' });
        const deps = makeDeps({
            executeUIAction: vi.fn().mockRejectedValue(new Error('Failed to connect to /127.0.0.1:22087')),
            executeUIActionCli: cliSpy,
        });
        const result = await runFeatureTest(
            { spec: { ...MINIMAL_SPEC, actions: [{ tap: { id: 'x' } }] } },
            deps,
        );
        expect(result.passed).toBe(true);
        expect(cliSpy).toHaveBeenCalledTimes(1);
        expect(result.actions.interactions).toHaveLength(1);
        expect(result.actions.interactions[0].transport).toBe('cli-fallback');
    });

    it('flag set but no CLI dep wired → bubbles the daemon error (unchanged behavior)', async () => {
        process.env['MCA_FEATURE_TEST_CLI_FALLBACK'] = '1';
        const deps = makeDeps({
            executeUIAction: vi.fn().mockRejectedValue(new Error('daemon dead')),
            // executeUIActionCli intentionally omitted
        });
        const result = await runFeatureTest(
            { spec: { ...MINIMAL_SPEC, actions: [{ tap: { id: 'x' } }] } },
            deps,
        );
        expect(result.passed).toBe(false);
        expect(result.error).toContain('daemon dead');
    });

    it('flag set, both daemon AND CLI fail → bubbles the CLI error', async () => {
        process.env['MCA_FEATURE_TEST_CLI_FALLBACK'] = '1';
        const deps = makeDeps({
            executeUIAction: vi.fn().mockRejectedValue(new Error('daemon dead')),
            executeUIActionCli: vi.fn().mockRejectedValue(new Error('CLI also dead')),
        });
        const result = await runFeatureTest(
            { spec: { ...MINIMAL_SPEC, actions: [{ tap: { id: 'x' } }] } },
            deps,
        );
        expect(result.passed).toBe(false);
        expect(result.error).toContain('CLI also dead');
    });
});

describe('loadSpec — file parsing', () => {
    let tmpDir: string;
    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-test-runner-'));
    });

    it('parses a YAML file on disk', async () => {
        const yamlPath = path.join(tmpDir, 'sample.yaml');
        await fs.writeFile(
            yamlPath,
            [
                'name: from-yaml',
                'appBundleId: com.example.app',
                'setup:',
                '  - flow: login',
                'actions:',
                '  - tap: { id: home }',
                '  - wait: 1500',
                'assertions:',
                '  - type: parallelism',
                '    matcher: { pathContains: /graphql }',
                '    maxWindowMs: 2000',
                '    minExpectedCount: 6',
            ].join('\n'),
        );
        const spec = await loadSpec(yamlPath);
        expect(spec.name).toBe('from-yaml');
        expect(spec.setup).toEqual([{ flow: 'login' }]);
        expect(spec.actions).toHaveLength(2);
        expect(spec.assertions[0].type).toBe('parallelism');
    });

    it('parses a JSON file on disk', async () => {
        const jsonPath = path.join(tmpDir, 'sample.json');
        await fs.writeFile(
            jsonPath,
            JSON.stringify({
                name: 'from-json',
                appBundleId: 'com.example.app',
                actions: [{ tap: { id: 'x' } }],
                assertions: [],
            }),
        );
        const spec = await loadSpec(jsonPath);
        expect(spec.name).toBe('from-json');
    });

    it('rejects a malformed spec with a Zod error', async () => {
        const yamlPath = path.join(tmpDir, 'bad.yaml');
        await fs.writeFile(yamlPath, 'name: bad\nactions: not-an-array\nassertions: []');
        await expect(loadSpec(yamlPath)).rejects.toThrow();
    });
});
