/**
 * Tests for buildActionYaml — the pure YAML generator behind executeAction.
 *
 * Covers the P2 fix (inputText as a distinct action that bypasses the
 * tapOn+inputText pattern that fails on iOS secure text fields) and the
 * escaping fix (textInput now goes through yamlString / JSON.stringify so
 * passwords with quotes, backslashes, or newlines no longer corrupt the YAML).
 */

import { describe, it, expect } from 'vitest';
import { buildActionYaml } from './wrapper.js';

describe('buildActionYaml — inputText (P2 fix)', () => {
    it('emits a bare inputText command with no preceding tapOn', () => {
        const r = buildActionYaml('inputText', {}, 'hunter2');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.commandStr).toBe('- inputText: "hunter2"');
            // No tapOn anywhere — that was the source of the secure-field bug
            expect(r.commandStr).not.toContain('tapOn');
        }
    });

    it('does NOT require a selector — types into the focused field', () => {
        const r = buildActionYaml('inputText', {}, 'pw');
        expect(r.ok).toBe(true);
    });

    it('ignores any selector fields if accidentally provided', () => {
        // The handler validates this case but the YAML generator should be
        // resilient: we still emit a bare inputText, not tapOn+inputText.
        const r = buildActionYaml('inputText', { id: 'should-be-ignored' }, 'pw');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.commandStr).toBe('- inputText: "pw"');
            expect(r.commandStr).not.toContain('should-be-ignored');
        }
    });

    it('escapes quotes/backslashes/newlines in the input via JSON.stringify', () => {
        const r = buildActionYaml('inputText', {}, 'a"b\\c\nd');
        expect(r.ok).toBe(true);
        if (r.ok) {
            // JSON.stringify produces "a\"b\\c\nd" with proper escapes
            expect(r.commandStr).toBe('- inputText: "a\\"b\\\\c\\nd"');
        }
    });

    it('handles empty string input', () => {
        const r = buildActionYaml('inputText', {}, '');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.commandStr).toBe('- inputText: ""');
    });
});

describe('buildActionYaml — type (existing tap+inputText path, with escaping fix)', () => {
    it('emits tapOn followed by inputText', () => {
        const r = buildActionYaml('type', { id: 'username' }, 'alice');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.commandStr).toBe('- tapOn:\n    id: "username"\n- inputText: "alice"');
        }
    });

    it('escapes special characters in textInput (regression: passwords with quotes)', () => {
        const r = buildActionYaml('type', { id: 'pwd' }, 'p"a\\ss');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.commandStr).toContain('- inputText: "p\\"a\\\\ss"');
        }
    });

    it('escapes special characters in element.id', () => {
        const r = buildActionYaml('tap', { id: 'btn"with-quote' }, undefined);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.commandStr).toBe('- tapOn:\n    id: "btn\\"with-quote"');
        }
    });

    it('rejects type when no selector is provided', () => {
        const r = buildActionYaml('type', {}, 'alice');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/No valid selector/);
    });
});

describe('buildActionYaml — selector priority preserved', () => {
    it('point overrides everything else', () => {
        const r = buildActionYaml('tap', { id: 'a', point: { x: 100, y: 200 } }, undefined);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.commandStr).toContain('point: 100,200');
    });

    it('id beats label and text', () => {
        const r = buildActionYaml('tap', { id: 'a', accessibilityLabel: 'b', text: 'c' }, undefined);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.commandStr).toContain('id: "a"');
    });

    it('label beats text', () => {
        const r = buildActionYaml('tap', { accessibilityLabel: 'b', text: 'c' }, undefined);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.commandStr).toContain('label: "b"');
    });

    it('falls back to bounds as a point selector', () => {
        const r = buildActionYaml('tap', { bounds: { x: 50, y: 60, width: 10, height: 10 } }, undefined);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.commandStr).toContain('point: 50,60');
    });
});

describe('buildActionYaml — full YAML envelope', () => {
    it('wraps the command with appId and a document separator', () => {
        const r = buildActionYaml('inputText', {}, 'x');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.yaml).toBe('appId: ""\n---\n- inputText: "x"\n');
        }
    });
});

describe('buildActionYaml — non-text actions (regression)', () => {
    it.each([
        ['tap', { id: 'go' }, undefined, '- tapOn:\n    id: "go"'],
        ['scroll', {}, undefined, '- scroll'],
        ['back', {}, undefined, '- back'],
        ['assertVisible', { id: 'banner' }, undefined, '- assertVisible:\n    id: "banner"'],
    ] as const)('action %s emits expected commandStr', (action, element, textInput, expected) => {
        const r = buildActionYaml(action, element, textInput);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.commandStr).toBe(expected);
    });
});
