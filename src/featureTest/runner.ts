/**
 * Composite feature-test runner.
 *
 * Orchestrates setup flows → recording session → UI actions → network assertions
 * → teardown as a single deterministic lifecycle. This exists so MCP clients can
 * execute a full cross-layer test in one tool call instead of spending 8–15
 * AI-mediated calls per run.
 *
 * The runner takes a `RunnerDeps` bag of handler functions so it stays decoupled
 * from handlers.ts at the module-graph level (no cyclic imports) and so tests can
 * supply pure mocks without touching the driver or session manager.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';

import {
    FeatureTestSpecSchema,
    type FeatureTestSpec,
    type RunFeatureTestInput,
    type RunFeatureTestOutput,
    type RunFlowInput,
    type RunFlowOutput,
    type StartRecordingInput,
    type StartRecordingOutput,
    type ExecuteUIActionInput,
    type ExecuteUIActionOutput,
    type StopAndCompileInput,
    type StopAndCompileOutput,
    type VerifyNetworkParallelismInput,
    type VerifyNetworkParallelismOutput,
    type VerifyNetworkOnScreenInput,
    type VerifyNetworkOnScreenOutput,
    type VerifyNetworkAbsentInput,
    type VerifyNetworkAbsentOutput,
    type VerifyNetworkSequenceInput,
    type VerifyNetworkSequenceOutput,
    type VerifyNetworkPerformanceInput,
    type VerifyNetworkPerformanceOutput,
    type VerifyNetworkPayloadInput,
    type VerifyNetworkPayloadOutput,
    type VerifyNetworkDeduplicationInput,
    type VerifyNetworkDeduplicationOutput,
    type VerifyNetworkErrorHandlingInput,
    type VerifyNetworkErrorHandlingOutput,
    type SetMockResponseInput,
} from '../schemas.js';

/**
 * Runner-driven mock installer. Bypasses session-scoped checks so spec.mocks
 * can be installed BEFORE setup flows run (the motivating bug: login flows
 * fire the API we want to mock during setup, missing post-recording mocks).
 * Rules tagged with a runner-controlled prefix; runner cleans them up itself
 * in a try/finally around the test body — they are NOT covered by
 * stop_and_compile_test's session-tag cleanup.
 */
export interface RunnerMockInstall {
    ruleNamePrefix: string;
    mock: SetMockResponseInput['mock'];
}
export interface RunnerMockInstalled {
    mockId: string;
    proxymanRuleId: string;
    ruleName: string;
}

export interface RunnerDeps {
    runFlow(input: RunFlowInput): Promise<RunFlowOutput>;
    startRecording(input: StartRecordingInput): Promise<StartRecordingOutput>;
    installRunnerMock(input: RunnerMockInstall): Promise<RunnerMockInstalled>;
    deleteRunnerMock(proxymanRuleId: string): Promise<void>;
    executeUIAction(input: ExecuteUIActionInput): Promise<ExecuteUIActionOutput>;
    stopAndCompile(input: StopAndCompileInput): Promise<StopAndCompileOutput>;
    verifyParallelism(input: VerifyNetworkParallelismInput): Promise<VerifyNetworkParallelismOutput>;
    verifyOnScreen(input: VerifyNetworkOnScreenInput): Promise<VerifyNetworkOnScreenOutput>;
    verifyAbsent(input: VerifyNetworkAbsentInput): Promise<VerifyNetworkAbsentOutput>;
    verifySequence(input: VerifyNetworkSequenceInput): Promise<VerifyNetworkSequenceOutput>;
    verifyPerformance(input: VerifyNetworkPerformanceInput): Promise<VerifyNetworkPerformanceOutput>;
    verifyPayload(input: VerifyNetworkPayloadInput): Promise<VerifyNetworkPayloadOutput>;
    verifyDeduplication(input: VerifyNetworkDeduplicationInput): Promise<VerifyNetworkDeduplicationOutput>;
    verifyErrorHandling(input: VerifyNetworkErrorHandlingInput): Promise<VerifyNetworkErrorHandlingOutput>;
    sleep(ms: number): Promise<void>;
}

const DEFAULTS = {
    setupTimeoutMs: 120_000,
    actionTimeoutMs: 30_000,
    settleMs: 5_000,
    driverCooldownMs: 5_000,
};

export const defaultSleep = (ms: number): Promise<void> =>
    ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Resolve `input.spec` into a validated FeatureTestSpec. Accepts an inline object
 * or a filesystem path to a .yaml / .yml / .json file.
 */
export async function loadSpec(spec: RunFeatureTestInput['spec']): Promise<FeatureTestSpec> {
    if (typeof spec !== 'string') {
        return FeatureTestSpecSchema.parse(spec);
    }

    const content = await fs.readFile(spec, 'utf-8');
    const ext = path.extname(spec).toLowerCase();
    const parsed = ext === '.json' ? JSON.parse(content) : yaml.load(content);
    return FeatureTestSpecSchema.parse(parsed);
}

export async function runFeatureTest(
    input: RunFeatureTestInput,
    deps: RunnerDeps,
): Promise<RunFeatureTestOutput> {
    const startedAt = Date.now();
    const spec = await loadSpec(input.spec);

    const setupTimeoutMs = input.setupTimeoutMs ?? DEFAULTS.setupTimeoutMs;
    const actionTimeoutMs = input.actionTimeoutMs ?? DEFAULTS.actionTimeoutMs;
    const settleMs = input.settleMs ?? DEFAULTS.settleMs;
    const driverCooldownMs = input.driverCooldownMs ?? DEFAULTS.driverCooldownMs;
    const platform = input.platform ?? 'ios';

    const result: RunFeatureTestOutput = {
        passed: false,
        name: spec.name,
        durationMs: 0,
        setup: { passed: true, flows: [] },
        mocks: { installed: [] },
        actions: { sessionId: '', interactions: [] },
        assertions: [],
        teardown: { flows: [] },
    };

    // Run-scoped mock identifier — used to tag rules so the runner can clean
    // them up in finally regardless of which path through the lifecycle we
    // take. Independent from the recording session's ID because mocks must
    // install BEFORE start_recording_session (the motivating fix).
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runMockTagPrefix = `mca:run-${runId}`;
    const installedRunMocks: string[] = []; // Proxyman rule IDs

    try {
    // ── Phase 0: Install spec.mocks BEFORE any phase that might fire matching
    //    network traffic. This was previously installed AFTER startRecording,
    //    which let setup-phase login flows miss the mock entirely. ──
    if (spec.mocks && spec.mocks.length > 0) {
        for (const mockSpec of spec.mocks) {
            try {
                const r = await deps.installRunnerMock({ ruleNamePrefix: runMockTagPrefix, mock: mockSpec });
                installedRunMocks.push(r.proxymanRuleId);
                result.mocks.installed.push({
                    mockId: r.mockId,
                    proxymanRuleId: r.proxymanRuleId,
                    ruleName: r.ruleName,
                });
            } catch (err) {
                result.mocks.error = `Failed to install mock${mockSpec.id ? ` "${mockSpec.id}"` : ''}: ${(err as Error).message}`;
                result.error = result.mocks.error;
                result.durationMs = Date.now() - startedAt;
                return result; // finally{} below cleans up partial installs
            }
        }
    }

    // ── Phase 1: Setup flows ──
    const setupStart = Date.now();
    for (let i = 0; i < spec.setup.length; i++) {
        const ref = spec.setup[i];
        const elapsed = Date.now() - setupStart;
        if (elapsed > setupTimeoutMs) {
            result.setup.passed = false;
            result.setup.flows.push({
                name: ref.flow,
                passed: false,
                durationMs: 0,
                error: `Setup timed out after ${elapsed}ms (budget: ${setupTimeoutMs}ms)`,
            });
            break;
        }

        const flowStart = Date.now();
        try {
            const flowResult = await deps.runFlow({
                name: ref.flow,
                flowsDir: input.flowsDir,
                params: { ...input.env, ...ref.params },
                platform,
                stubsDir: input.stubsDir,
                driverCooldownMs,
            });
            result.setup.flows.push({
                name: ref.flow,
                passed: flowResult.passed,
                durationMs: flowResult.durationMs,
                error: flowResult.passed ? undefined : flowResult.output.slice(-500),
            });
            if (!flowResult.passed) {
                result.setup.passed = false;
                break;
            }
        } catch (err) {
            result.setup.passed = false;
            result.setup.flows.push({
                name: ref.flow,
                passed: false,
                durationMs: Date.now() - flowStart,
                error: (err as Error).message,
            });
            break;
        }

        // Driver cooldown between consecutive flows (skip after the last one)
        if (i < spec.setup.length - 1) {
            await deps.sleep(driverCooldownMs);
        }
    }

    if (!result.setup.passed) {
        result.durationMs = Date.now() - startedAt;
        result.error = 'Setup phase failed';
        return result;
    }

    // ── Phase 2: Recording + actions ──
    let sessionId = '';
    try {
        const recording = await deps.startRecording({
            appBundleId: spec.appBundleId,
            platform,
            filterDomains: spec.filterDomains,
            captureMode: spec.captureMode,
            trackEventPaths: spec.trackEventPaths,
            timeouts: { driverCooldownMs },
        });
        sessionId = recording.sessionId;
        result.actions.sessionId = sessionId;
    } catch (err) {
        result.durationMs = Date.now() - startedAt;
        result.error = `start_recording_session failed: ${(err as Error).message}`;
        return result;
    }

    // (Mocks are installed in Phase 0 above, before setup. The runner cleans
    //  them up in the finally{} block at the end of this function regardless
    //  of which exit path we take.)

    let actionsPassed = true;
    const actionsStart = Date.now();
    try {
        for (const action of spec.actions) {
            const elapsed = Date.now() - actionsStart;
            if (elapsed > actionTimeoutMs) {
                actionsPassed = false;
                result.error = `Actions phase timed out after ${elapsed}ms (budget: ${actionTimeoutMs}ms)`;
                break;
            }

            if ('wait' in action) {
                const ms = action.wait;
                const waitStart = Date.now();
                await deps.sleep(ms);
                result.actions.interactions.push({
                    action: 'wait',
                    element: `${ms}ms`,
                    durationMs: Date.now() - waitStart,
                    waitMs: ms,
                });
                continue;
            }

            const uiInput = toExecuteActionInput(action, sessionId);
            const callStart = Date.now();
            await deps.executeUIAction(uiInput);
            result.actions.interactions.push({
                action: uiInput.action,
                element: describeElement(uiInput),
                durationMs: Date.now() - callStart,
            });
        }
    } catch (err) {
        actionsPassed = false;
        result.error = `execute_ui_action failed: ${(err as Error).message}`;
    }

    // Settle: let in-flight network traffic land before assertions.
    if (actionsPassed) {
        await deps.sleep(settleMs);
    }

    // ── Phase 3: Assertions (sequential — avoids concurrent HAR export bug) ──
    if (actionsPassed) {
        for (let i = 0; i < spec.assertions.length; i++) {
            const assertion = spec.assertions[i];
            result.assertions.push(
                await runAssertion(assertion, sessionId, spec.filterDomains, deps),
            );
        }
    }

    // ── Phase 4: Teardown — always run, failures are warnings ──
    let compiledYamlPath: string | undefined;
    try {
        const compileResult = await deps.stopAndCompile({ sessionId });
        compiledYamlPath = compileResult.yamlPath;
    } catch (err) {
        console.error('[run_feature_test] stop_and_compile failed (non-fatal)', err);
    }
    result.teardown.compiledYamlPath = compiledYamlPath;

    for (const ref of spec.teardown) {
        const flowStart = Date.now();
        try {
            const flowResult = await deps.runFlow({
                name: ref.flow,
                flowsDir: input.flowsDir,
                params: { ...input.env, ...ref.params },
                platform,
                stubsDir: input.stubsDir,
                driverCooldownMs,
            });
            result.teardown.flows.push({
                name: ref.flow,
                passed: flowResult.passed,
                durationMs: flowResult.durationMs,
                error: flowResult.passed ? undefined : flowResult.output.slice(-500),
            });
        } catch (err) {
            result.teardown.flows.push({
                name: ref.flow,
                passed: false,
                durationMs: Date.now() - flowStart,
                error: (err as Error).message,
            });
        }
    }

    const assertionsPassed =
        result.assertions.length === spec.assertions.length
        && result.assertions.every((a) => a.passed);

    result.passed = result.setup.passed && actionsPassed && assertionsPassed;
    result.durationMs = Date.now() - startedAt;
    return result;
    } finally {
        // Always clean up runner-installed mocks, regardless of which `return`
        // got us here (early aborts, normal success, exceptions). These rules
        // are tagged `mca:run-<runId>:*`, NOT `mca:<sessionId>:*`, so they are
        // outside stop_and_compile_test's session-scoped cleanup and would
        // otherwise leak in Proxyman's rule list.
        for (const proxymanRuleId of installedRunMocks) {
            try {
                await deps.deleteRunnerMock(proxymanRuleId);
            } catch (err) {
                console.error(
                    `[run_feature_test] cleanup failed for runner mock ${proxymanRuleId} (non-fatal)`,
                    err,
                );
            }
        }
    }
}

function toExecuteActionInput(
    action: Exclude<FeatureTestSpec['actions'][number], { wait: number }>,
    sessionId: string,
): ExecuteUIActionInput {
    if ('tap' in action) {
        return { sessionId, action: 'tap', element: action.tap };
    }
    if ('type' in action) {
        const { text, ...element } = action.type;
        return { sessionId, action: 'type', element, textInput: text };
    }
    if ('assertVisible' in action) {
        return { sessionId, action: 'assertVisible', element: action.assertVisible };
    }
    // scroll — direction is informational; the underlying driver issues a single
    // `- scroll` command. Preserved in the spec for future directional support.
    return { sessionId, action: 'scroll', element: {} };
}

function describeElement(input: ExecuteUIActionInput): string {
    const e = input.element;
    if (e.id) return e.id;
    if (e.accessibilityLabel) return e.accessibilityLabel;
    if (e.text) return `"${e.text}"`;
    if (e.point) return `point(${e.point.x},${e.point.y})`;
    return input.action;
}

async function runAssertion(
    assertion: FeatureTestSpec['assertions'][number],
    sessionId: string,
    filterDomains: string[] | undefined,
    deps: RunnerDeps,
): Promise<RunFeatureTestOutput['assertions'][number]> {
    const base = { sessionId, filterDomains };
    try {
        switch (assertion.type) {
            case 'parallelism': {
                const { type, ...rest } = assertion;
                const r = await deps.verifyParallelism({ ...base, ...rest });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
            case 'on_screen': {
                const { type, afterAction, ...rest } = assertion;
                const r = await deps.verifyOnScreen({
                    ...base,
                    ...rest,
                    afterAction: afterAction ?? { kind: 'index', value: 0 },
                });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
            case 'absent': {
                const { type, afterAction, ...rest } = assertion;
                const r = await deps.verifyAbsent({
                    ...base,
                    ...rest,
                    afterAction: afterAction ?? { kind: 'index', value: 0 },
                });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
            case 'sequence': {
                const { type, ...rest } = assertion;
                const r = await deps.verifySequence({ ...base, ...rest });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
            case 'performance': {
                const { type, ...rest } = assertion;
                const r = await deps.verifyPerformance({ ...base, ...rest });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
            case 'payload': {
                const { type, ...rest } = assertion;
                const r = await deps.verifyPayload({ ...base, ...rest });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
            case 'deduplication': {
                const { type, ...rest } = assertion;
                const r = await deps.verifyDeduplication({ ...base, ...rest });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
            case 'error_handling': {
                const { type, ...rest } = assertion;
                const r = await deps.verifyErrorHandling({ ...base, ...rest });
                return { type, passed: r.passed, verdict: r.verdict, details: r };
            }
        }
    } catch (err) {
        return {
            type: assertion.type,
            passed: false,
            verdict: `Assertion threw: ${(err as Error).message}`,
            details: {},
            error: (err as Error).message,
        };
    }
}
