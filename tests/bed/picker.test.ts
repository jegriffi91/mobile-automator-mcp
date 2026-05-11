import { describe, it, expect } from 'vitest';
import { extractChosenId, parseEnvelope, buildPrompt } from './picker.js';

describe('extractChosenId', () => {
    it('parses a clean JSON object', () => {
        expect(extractChosenId('{"id": "settings.gear"}')).toBe('settings.gear');
    });

    it('parses a JSON object with surrounding whitespace', () => {
        expect(extractChosenId('\n  {"id": "x"}  \n')).toBe('x');
    });

    it('extracts the first JSON block from a noisy reply', () => {
        expect(extractChosenId('Here you go: {"id": "btn.login"} done')).toBe('btn.login');
    });

    it('handles a JSON object inside a markdown fence', () => {
        expect(extractChosenId('```json\n{"id": "abc"}\n```')).toBe('abc');
    });

    it('returns undefined when no id field is present', () => {
        expect(extractChosenId('{"name": "foo"}')).toBeUndefined();
    });

    it('returns undefined when the reply is not parseable', () => {
        expect(extractChosenId('I cannot help with that')).toBeUndefined();
    });

    it('returns undefined when the id is not a string', () => {
        expect(extractChosenId('{"id": 42}')).toBeUndefined();
    });
});

describe('parseEnvelope', () => {
    it('extracts chosenId and usage when present', () => {
        const env = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: '{"id": "settings.gear"}',
            usage: { input_tokens: 1234, output_tokens: 12 },
        });
        const out = parseEnvelope(env, 100);
        expect(out.chosenId).toBe('settings.gear');
        expect(out.inputTokens).toBe(1234);
        expect(out.outputTokens).toBe(12);
        expect(out.latencyMs).toBe(100);
    });

    it('reports non-json-envelope when stdout is not JSON', () => {
        const out = parseEnvelope('not json', 50);
        expect(out.error).toBe('non-json-envelope');
        expect(out.raw).toBe('not json');
    });

    it('reports non-json-output when the result field has no id', () => {
        const env = JSON.stringify({
            type: 'result',
            result: 'sorry, I cannot',
            usage: { input_tokens: 100 },
        });
        const out = parseEnvelope(env, 50);
        expect(out.error).toBe('non-json-output');
        expect(out.inputTokens).toBe(100);
    });

    it('tolerates a missing usage field', () => {
        const env = JSON.stringify({ result: '{"id": "x"}' });
        const out = parseEnvelope(env, 0);
        expect(out.chosenId).toBe('x');
        expect(out.inputTokens).toBeUndefined();
    });
});

describe('buildPrompt', () => {
    it('includes the rendered screen and the goal verbatim', () => {
        const p = buildPrompt({
            compactedScreen: '[tr] Button id="settings.gear"',
            goal: 'Tap Settings',
        });
        expect(p).toContain('[tr] Button id="settings.gear"');
        expect(p).toContain('Goal: Tap Settings');
        expect(p).toContain('"id"');
    });
});
