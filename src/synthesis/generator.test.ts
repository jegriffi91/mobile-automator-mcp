import { describe, it, expect } from 'vitest';
import { YamlGenerator } from './generator.js';
import type { CorrelatedStep } from './correlator.js';
import type { UIInteraction, NetworkEvent } from '../types.js';

function makeStep(overrides: {
    interaction?: Partial<UIInteraction>;
    networkEvents?: Partial<NetworkEvent>[];
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

    it('should emit evalScript for correlated network events', () => {
        const yaml = gen.toYaml([
            makeStep({
                networkEvents: [{ statusCode: 200, method: 'POST', url: '/api/login' }],
            }),
        ]);
        expect(yaml).toContain('- evalScript: |');
        expect(yaml).toContain('assertTrue');
        expect(yaml).toContain('POST /api/login');
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
