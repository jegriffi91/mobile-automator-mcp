import { describe, it, expect } from 'vitest';
import { YamlGenerator } from './generator.js';
import type { CorrelatedStep, CorrelatedNetworkCapture } from './correlator.js';
import type { UIInteraction, NetworkEvent } from '../types.js';

function makeStep(overrides: {
    interaction?: Partial<UIInteraction>;
    networkEvents?: Partial<NetworkEvent>[];
    networkCaptures?: CorrelatedNetworkCapture[];
    index?: number;
} = {}): CorrelatedStep {
    return {
        index: overrides.index ?? 0,
        interaction: {
            sessionId: 'test-session',
            timestamp: '2024-01-01T00:00:00.000Z',
            actionType: 'tap',
            element: { id: 'btn1' },
            ...overrides.interaction,
        },
        networkEvents: (overrides.networkEvents ?? []).map((e) => ({
            sessionId: 'test-session',
            timestamp: '2024-01-01T00:00:01.000Z',
            method: 'GET',
            url: 'https://api.example.com/data',
            statusCode: 200,
            ...e,
        })),
        networkCaptures: overrides.networkCaptures ?? [],
    };
}

describe('YamlGenerator', () => {
    const gen = new YamlGenerator('com.example.MyApp');

    it('should emit valid YAML header with launchApp', () => {
        const yaml = gen.toYaml([]);
        expect(yaml).toContain('appId: com.example.MyApp');
        expect(yaml).toContain('---');
        expect(yaml).toContain('- launchApp');
    });

    it('should generate tapOn with id selector', () => {
        const yaml = gen.toYaml([makeStep()]);
        expect(yaml).toContain('- tapOn:');
        expect(yaml).toContain('id: "btn1"');
    });

    it('should generate tapOn with label selector for accessibilityLabel', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { element: { accessibilityLabel: 'Login' } } }),
        ]);
        expect(yaml).toContain('label: "Login"');
    });

    it('should generate tapOn with text selector fallback', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { element: { text: 'Submit' } } }),
        ]);
        expect(yaml).toContain('text: "Submit"');
    });

    it('should generate inputText for type action', () => {
        const yaml = gen.toYaml([
            makeStep({
                interaction: {
                    actionType: 'type',
                    element: { id: 'emailField' },
                    textInput: 'user@example.com',
                },
            }),
        ]);
        expect(yaml).toContain('- tapOn:');
        expect(yaml).toContain('id: "emailField"');
        expect(yaml).toContain('- inputText: "user@example.com"');
    });

    it('should generate scroll command', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { actionType: 'scroll', element: {} } }),
        ]);
        expect(yaml).toContain('- scroll');
    });

    it('should generate swipe command', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { actionType: 'swipe', element: {} } }),
        ]);
        expect(yaml).toContain('- swipe:');
        expect(yaml).toContain('direction: DOWN');
    });

    it('should generate back command', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { actionType: 'back', element: {} } }),
        ]);
        expect(yaml).toContain('- back');
    });

    it('should generate assertVisible command', () => {
        const yaml = gen.toYaml([
            makeStep({
                interaction: { actionType: 'assertVisible', element: { id: 'header' } },
            }),
        ]);
        expect(yaml).toContain('- assertVisible:');
        expect(yaml).toContain('id: "header"');
    });

    it('should emit network context comments for correlated captures', () => {
        const yaml = gen.toYaml([
            makeStep({
                networkCaptures: [
                    {
                        event: {
                            sessionId: 'test-session',
                            timestamp: '2024-01-01T00:00:01.000Z',
                            method: 'POST',
                            url: 'http://localhost:3030/api/login',
                            statusCode: 200,
                        },
                        requestPattern: { method: 'POST', pathPattern: '/api/login' },
                        fixtureId: 'post_api_login',
                    },
                ],
            }),
        ]);
        expect(yaml).toContain('POST /api/login → 200');
        expect(yaml).not.toContain('evalScript');
    });

    it('should append user conditions as YAML comments', () => {
        const yaml = gen.toYaml([], ['verify analytics event: page_view', 'check welcome screen shown']);
        expect(yaml).toContain('# TODO: verify analytics event: page_view');
        expect(yaml).toContain('# TODO: check welcome screen shown');
    });

    it('should escape special characters in selectors', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { element: { text: 'Say "Hello"' } } }),
        ]);
        expect(yaml).toContain('text: "Say \\"Hello\\""');
    });

    it('should emit env-var placeholder for secure text fields', () => {
        const yaml = gen.toYaml([
            makeStep({
                interaction: {
                    actionType: 'type',
                    element: { id: 'passwordField', isSecure: true },
                    textInput: 'secret123',
                },
            }),
        ]);
        expect(yaml).toContain('${SECURE_INPUT}');
        expect(yaml).not.toContain('secret123');
        expect(yaml).toContain('Secure field detected');
    });

    it('should emit regular text for non-secure type actions', () => {
        const yaml = gen.toYaml([
            makeStep({
                interaction: {
                    actionType: 'type',
                    element: { id: 'emailField' },
                    textInput: 'user@example.com',
                },
            }),
        ]);
        expect(yaml).toContain('user@example.com');
        expect(yaml).not.toContain('SECURE_INPUT');
    });

    it('should emit selector quality warnings as YAML comments', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { element: { text: '3' } } }),
        ]);
        expect(yaml).toContain('# ⚠️');
        expect(yaml).toContain('falling back to visible text');
    });

    it('should emit transient ID warning', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { element: { id: 'shimmer-row-1' } } }),
        ]);
        expect(yaml).toContain('# ⚠️');
        expect(yaml).toContain('transient');
    });

    it('should not emit warnings for well-identified elements', () => {
        const yaml = gen.toYaml([
            makeStep({ interaction: { element: { id: 'submit-button' } } }),
        ]);
        expect(yaml).not.toContain('⚠️');
    });
});

describe('YamlGenerator.buildSelector', () => {
    it('should prioritize id over label over text', () => {
        expect(YamlGenerator.buildSelector({ id: 'a', accessibilityLabel: 'b', text: 'c' }))
            .toBe('id: "a"');
    });

    it('should fall back to label when no id', () => {
        expect(YamlGenerator.buildSelector({ accessibilityLabel: 'b', text: 'c' }))
            .toBe('label: "b"');
    });

    it('should fall back to text when no id or label', () => {
        expect(YamlGenerator.buildSelector({ text: 'c' }))
            .toBe('text: "c"');
    });

    it('should fall back to point when only bounds', () => {
        expect(YamlGenerator.buildSelector({ bounds: { x: 100, y: 200, width: 50, height: 50 } }))
            .toBe('point: "100,200"');
    });

    it('should return text: "unknown" for empty element', () => {
        expect(YamlGenerator.buildSelector({})).toBe('text: "unknown"');
    });
});

// ── Phase 5: runFlow: emission ──

import type { RunFlowYamlBlock, FlowStep } from './flow-weaver.js';

function flowStep(seq: number, kind: string, opts: Partial<FlowStep> = {}): FlowStep {
    return {
        sequenceNumber: seq,
        timestamp: new Date(1746121231000 + seq * 100).toISOString(),
        kind,
        durationMs: 10,
        status: 'COMPLETED',
        raw: {},
        ...opts,
    };
}

describe('YamlGenerator.toYaml — flowBlocks (Phase 5)', () => {
    const gen = new YamlGenerator('com.example.MyApp');

    it('produces output identical to legacy when no flowBlocks supplied', () => {
        const before = gen.toYaml([makeStep()]);
        const after = gen.toYaml([makeStep()], undefined, {});
        expect(after).toBe(before);
    });

    it('emits a runFlow: line at the right chronological position with summary comments', () => {
        const flowBlock: RunFlowYamlBlock = {
            timestamp: '2024-01-01T00:00:00.500Z',
            endTimestamp: '2024-01-01T00:00:05.000Z',
            flowName: 'login',
            flowPath: '/abs/login.yaml',
            succeeded: true,
            steps: [flowStep(0, 'tapOnElement', { target: 'Login' }), flowStep(1, 'inputText', { target: 'u' })],
        };
        const yaml = gen.toYaml(
            [
                makeStep({ index: 0, interaction: { timestamp: '2024-01-01T00:00:00.000Z' } }),
                makeStep({ index: 1, interaction: { timestamp: '2024-01-01T00:00:10.000Z' } }),
            ],
            undefined,
            { flowBlocks: [flowBlock], outputDir: '/abs' },
        );
        expect(yaml).toContain('# Flow: login');
        expect(yaml).toContain('# Steps: tapOnElement → inputText');
        expect(yaml).toContain('- runFlow: login.yaml');
        // Position check: runFlow line should come after the first step but
        // before the second step.
        const idxFirstStep = yaml.indexOf('- tapOn:');
        const idxRunFlow = yaml.indexOf('- runFlow:');
        const idxSecondStep = yaml.lastIndexOf('- tapOn:');
        expect(idxFirstStep).toBeLessThan(idxRunFlow);
        expect(idxRunFlow).toBeLessThan(idxSecondStep);
    });

    it('emits a leading FAILED warning + error message for a failed flow', () => {
        const flowBlock: RunFlowYamlBlock = {
            timestamp: '2024-01-01T00:00:00.000Z',
            endTimestamp: '2024-01-01T00:00:05.000Z',
            flowName: 'login',
            flowPath: '/abs/login.yaml',
            succeeded: false,
            steps: [
                flowStep(0, 'assertVisible', { status: 'FAILED', error: 'Element not found' }),
            ],
        };
        const yaml = gen.toYaml([], undefined, { flowBlocks: [flowBlock], outputDir: '/abs' });
        expect(yaml).toContain('# ⚠ flow FAILED: login — Element not found');
        expect(yaml).toContain('assertVisible (FAILED: Element not found)');
    });

    it('emits a leading CANCELLED warning for a cancelled flow', () => {
        const flowBlock: RunFlowYamlBlock = {
            timestamp: '2024-01-01T00:00:00.000Z',
            endTimestamp: '2024-01-01T00:00:05.000Z',
            flowName: 'login',
            flowPath: '/abs/login.yaml',
            succeeded: false,
            cancelled: true,
            steps: [],
        };
        const yaml = gen.toYaml([], undefined, { flowBlocks: [flowBlock], outputDir: '/abs' });
        expect(yaml).toContain('# ⚠ flow CANCELLED: login');
    });
});
