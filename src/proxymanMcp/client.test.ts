/**
 * Tests for ProxymanMcpClient — focus on the plain-text parsers and the
 * connection-state machine. The actual stdio transport is exercised by the
 * spike (one-off, requires a running Proxyman); here we cover the parsing
 * surface that's brittle to Proxyman's output format.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseRuleId, parseRuleList, ProxymanMcpClient, type ProxymanRuleSummary } from './client.js';

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

describe('listRulesByTagPrefix / deleteRulesByTagPrefix / healthCheck', () => {
    function makeClient(rules: ProxymanRuleSummary[], opts: {
        listThrows?: Error;
        deleteThrowsForId?: string;
    } = {}) {
        const client = new ProxymanMcpClient('/dev/null');
        const listSpy = vi.spyOn(client, 'listRules').mockImplementation(async () => {
            if (opts.listThrows) throw opts.listThrows;
            return rules;
        });
        const deleteSpy = vi.spyOn(client, 'deleteRule').mockImplementation(async (id: string) => {
            if (opts.deleteThrowsForId === id) throw new Error(`delete-${id}-failed`);
        });
        return { client, listSpy, deleteSpy };
    }

    it('listRulesByTagPrefix filters by name prefix', async () => {
        const { client } = makeClient([
            { id: '1', name: 'mca:abc:m1', url: '*', enabled: true, ruleType: 'scripting' },
            { id: '2', name: 'mca:xyz:m1', url: '*', enabled: true, ruleType: 'scripting' },
            { id: '3', name: 'unrelated', url: '*', enabled: true, ruleType: 'scripting' },
        ]);
        const out = await client.listRulesByTagPrefix('mca:abc:');
        expect(out.map((r) => r.id)).toEqual(['1']);
    });

    it('deleteRulesByTagPrefix returns deleted/failed structured result', async () => {
        const { client } = makeClient(
            [
                { id: '1', name: 'mca:abc:m1', url: '*', enabled: true, ruleType: 'scripting' },
                { id: '2', name: 'mca:abc:m2', url: '*', enabled: true, ruleType: 'scripting' },
            ],
            { deleteThrowsForId: '2' },
        );
        const result = await client.deleteRulesByTagPrefix('mca:abc:');
        expect(result.deleted).toEqual(['1']);
        expect(result.failed).toEqual([{ id: '2', error: expect.stringContaining('delete-2-failed') }]);
    });

    it('deleteRulesByTagPrefix surfaces list_rules failure as *list* entry', async () => {
        const { client } = makeClient([], { listThrows: new Error('list-broken') });
        const result = await client.deleteRulesByTagPrefix('mca:abc:');
        expect(result.deleted).toEqual([]);
        expect(result.failed).toEqual([{ id: '*list*', error: 'list-broken' }]);
    });

    it('healthCheck returns true when getProxyStatus resolves', async () => {
        const client = new ProxymanMcpClient('/dev/null');
        vi.spyOn(client, 'getProxyStatus').mockResolvedValue('Recording: Active');
        await expect(client.healthCheck(50)).resolves.toBe(true);
    });

    it('healthCheck returns false when getProxyStatus rejects', async () => {
        const client = new ProxymanMcpClient('/dev/null');
        vi.spyOn(client, 'getProxyStatus').mockRejectedValue(new Error('not running'));
        await expect(client.healthCheck(50)).resolves.toBe(false);
    });

    it('healthCheck returns false when getProxyStatus exceeds timeout', async () => {
        const client = new ProxymanMcpClient('/dev/null');
        vi.spyOn(client, 'getProxyStatus').mockImplementation(
            () => new Promise(() => {}), // hangs forever
        );
        await expect(client.healthCheck(20)).resolves.toBe(false);
    });
});
