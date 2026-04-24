/**
 * Tests for ProxymanMcpClient — focus on the plain-text parsers and the
 * connection-state machine. The actual stdio transport is exercised by the
 * spike (one-off, requires a running Proxyman); here we cover the parsing
 * surface that's brittle to Proxyman's output format.
 */

import { describe, it, expect } from 'vitest';
import { parseRuleId, parseRuleList } from './client.js';

describe('parseRuleId', () => {
    it('extracts the ID from a successful create response', () => {
        expect(parseRuleId('Scripting rule created successfully\nRule ID: AC5CFB7B')).toBe('AC5CFB7B');
    });

    it('handles lowercase prefix variations', () => {
        expect(parseRuleId('rule id: ABCD-1234')).toBe('ABCD-1234');
    });

    it('returns null when no ID is present', () => {
        expect(parseRuleId('something went wrong')).toBeNull();
    });

    it('returns null on empty input', () => {
        expect(parseRuleId('')).toBeNull();
    });
});

describe('parseRuleList', () => {
    it('parses a single enabled rule', () => {
        const text = `Total Rules: 1\n\n1. [✓] [SCRIPTING] my-rule\n   ID: ABCDEF12\n   URL: example.com`;
        const rules = parseRuleList(text);
        expect(rules).toEqual([
            { id: 'ABCDEF12', name: 'my-rule', url: 'example.com', enabled: true, ruleType: 'scripting' },
        ]);
    });

    it('parses multiple rules and preserves order', () => {
        const text = [
            'Total Rules: 3',
            '',
            '1. [✓] [SCRIPTING] mca:sess-1:m1',
            '   ID: AAAA0001',
            '   URL: */graphql*',
            '2. [✓] [SCRIPTING] AScriptTest',
            '   ID: 30C78750',
            '   URL: example.com',
            '3. [✓] [BREAKPOINT] my-breakpoint',
            '   ID: BB000002',
            '   URL: api.example.com',
        ].join('\n');
        const rules = parseRuleList(text);
        expect(rules).toHaveLength(3);
        expect(rules[0].name).toBe('mca:sess-1:m1');
        expect(rules[0].ruleType).toBe('scripting');
        expect(rules[1].name).toBe('AScriptTest');
        expect(rules[2].ruleType).toBe('breakpoint');
    });

    it('returns an empty list when the response says no rules', () => {
        expect(parseRuleList('Total Rules: 0\n')).toEqual([]);
        expect(parseRuleList('')).toEqual([]);
    });

    it('handles names with colons (our session-tag format)', () => {
        const text = `1. [✓] [SCRIPTING] mca:abc-def-123:mock-deadbeef\n   ID: ZZZ\n   URL: *`;
        const rules = parseRuleList(text);
        expect(rules).toHaveLength(1);
        expect(rules[0].name).toBe('mca:abc-def-123:mock-deadbeef');
    });
});
