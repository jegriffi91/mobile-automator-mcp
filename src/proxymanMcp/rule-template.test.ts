/**
 * Tests for rule-template — the JS code generator that translates our mock
 * spec into Proxyman scripting rules.
 *
 * Strategy: generate the JS, then EXECUTE IT inside this test process via
 * `new Function(...)`. We can simulate Proxyman's runtime contract (`onResponse`
 * gets `(context, url, request, response)` and must return `response`) and
 * verify the script produces the expected mutation. This is the closest we can
 * get to "did Proxyman actually run it correctly" without round-tripping
 * through the real Proxyman MCP, and it catches generator bugs (escape errors,
 * missing guards, broken JSON Patch ops) deterministically.
 */

import { describe, it, expect } from 'vitest';
import {
    buildScriptContent,
    buildProxymanUrlPattern,
    buildRuleName,
    isOurRuleForSession,
    isOurRule,
    type BuildScriptInput,
} from './rule-template.js';

interface FakeRequest {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
}
interface FakeResponse {
    statusCode?: number;
    body?: unknown;
    headers?: Record<string, string>;
}

/** Compile a generated script and run its onResponse with the given inputs. */
async function runScript(
    script: string,
    url: string,
    request: FakeRequest,
    response: FakeResponse,
): Promise<FakeResponse> {
    // The generated body declares `async function onResponse(...)`. Wrap with a
    // factory that returns the function so we can call it.
    const factory = new Function(`${script}\nreturn onResponse;`);
    const onResponse = factory() as (
        context: { log: (m: string) => void },
        url: string,
        req: FakeRequest,
        res: FakeResponse,
    ) => Promise<FakeResponse>;
    const ctx = { log: () => {} };
    return await onResponse(ctx, url, request, response);
}

describe('buildProxymanUrlPattern', () => {
    it('wraps pathContains in wildcards so the rule fires on path-bearing URLs', () => {
        expect(buildProxymanUrlPattern({ pathContains: '/graphql' })).toBe('*/graphql*');
    });

    it('prefixes urlPathEquals with a host wildcard', () => {
        expect(buildProxymanUrlPattern({ urlPathEquals: '/api/login' })).toBe('*/api/login');
    });

    it('falls back to a match-all wildcard when no URL hint is given', () => {
        expect(buildProxymanUrlPattern({ method: 'POST' })).toBe('*');
    });
});

describe('buildScriptContent — staticResponse', () => {
    it('replaces statusCode and jsonBody and sets Content-Type', async () => {
        const input: BuildScriptInput = {
            matcher: { pathContains: '/api/flags' },
            staticResponse: {
                status: 200,
                jsonBody: { newLogin: false },
            },
        };
        const script = buildScriptContent(input);
        const result = await runScript(
            script,
            'http://example.com/api/flags?ts=1',
            { method: 'GET' },
            { statusCode: 500, body: { ignored: true }, headers: {} },
        );
        expect(result.statusCode).toBe(200);
        expect(result.body).toEqual({ newLogin: false });
        expect(result.headers?.['Content-Type']).toBe('application/json');
    });

    it('does not overwrite a pre-existing Content-Type', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/x' },
            staticResponse: { status: 200, jsonBody: { ok: 1 } },
        });
        const result = await runScript(script, 'http://example.com/x', {}, {
            headers: { 'content-type': 'application/vnd.api+json' },
        });
        expect(result.headers?.['content-type']).toBe('application/vnd.api+json');
    });

    it('passes the response through unchanged when the matcher does not hit', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/api/specific' },
            staticResponse: { status: 418, jsonBody: { teapot: true } },
        });
        const original = { statusCode: 200, body: { real: 'data' }, headers: {} };
        const result = await runScript(script, 'http://example.com/something/else', {}, original);
        expect(result).toBe(original);
        expect(result.statusCode).toBe(200);
    });

    it('appends arbitrary headers from staticResponse', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/x' },
            staticResponse: {
                status: 200,
                body: 'hello',
                headers: { 'X-Custom': 'yes', 'X-Count': '7' },
            },
        });
        const result = await runScript(script, 'http://example.com/x', {}, { headers: {} });
        expect(result.headers?.['X-Custom']).toBe('yes');
        expect(result.headers?.['X-Count']).toBe('7');
    });
});

describe('buildScriptContent — responseTransform.jsonPatch', () => {
    it('applies a replace op to the response body', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/graphql' },
            responseTransform: {
                jsonPatch: [
                    { op: 'replace', path: '/data/customerStatusV3/loginStatus', value: 'OP2_INTERCEPT' },
                ],
            },
        });
        const result = await runScript(
            script,
            'https://api.example.com/api/federated/graphql',
            { method: 'POST', body: '{}' },
            {
                statusCode: 200,
                body: {
                    data: { customerStatusV3: { loginStatus: 'SUCCESS' } },
                },
            },
        );
        const body = result.body as { data: { customerStatusV3: { loginStatus: string } } };
        expect(body.data.customerStatusV3.loginStatus).toBe('OP2_INTERCEPT');
    });

    it('applies multiple ops in sequence', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/x' },
            responseTransform: {
                jsonPatch: [
                    { op: 'replace', path: '/a', value: 99 },
                    { op: 'add', path: '/c', value: 3 },
                    { op: 'remove', path: '/b' },
                ],
            },
        });
        const result = await runScript(
            script, 'http://example.com/x', {},
            { body: { a: 1, b: 2 }, statusCode: 200 },
        );
        expect(result.body).toEqual({ a: 99, c: 3 });
    });

    it('appends to an array via the "-" pointer', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/list' },
            responseTransform: {
                jsonPatch: [{ op: 'add', path: '/items/-', value: 'new' }],
            },
        });
        const result = await runScript(
            script, 'http://example.com/list', {},
            { body: { items: ['a', 'b'] }, statusCode: 200 },
        );
        expect((result.body as { items: string[] }).items).toEqual(['a', 'b', 'new']);
    });

    it('passes through unchanged when the body is not an object', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/x' },
            responseTransform: { jsonPatch: [{ op: 'replace', path: '/anything', value: 1 }] },
        });
        const result = await runScript(
            script, 'http://example.com/x', {},
            { body: 'plain text', statusCode: 200 },
        );
        expect(result.body).toBe('plain text');
    });
});

describe('buildScriptContent — matcher guards', () => {
    it('rejects requests where method does not match', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/api', method: 'POST' },
            staticResponse: { status: 200, jsonBody: { mocked: true } },
        });
        const result = await runScript(
            script, 'http://example.com/api/x',
            { method: 'GET' },
            { statusCode: 500, body: 'real' },
        );
        expect(result.body).toBe('real');
        expect(result.statusCode).toBe(500);
    });

    it('rejects requests whose body does not contain the matcher substring', async () => {
        const script = buildScriptContent({
            matcher: {
                pathContains: '/graphql',
                requestBodyContains: 'CustomerStatusAndCustomerAuthenticationQuery',
            },
            responseTransform: {
                jsonPatch: [{ op: 'replace', path: '/loginStatus', value: 'OP2_INTERCEPT' }],
            },
        });

        // request body lacks the operation name → no transform
        const passthrough = await runScript(
            script, 'https://api.example.com/api/federated/graphql',
            { method: 'POST', body: '{"query":"OtherQuery"}' },
            { body: { loginStatus: 'SUCCESS' }, statusCode: 200 },
        );
        expect((passthrough.body as { loginStatus: string }).loginStatus).toBe('SUCCESS');

        // request body contains the operation → transform fires
        const mocked = await runScript(
            script, 'https://api.example.com/api/federated/graphql',
            { method: 'POST', body: '{"query":"CustomerStatusAndCustomerAuthenticationQuery"}' },
            { body: { loginStatus: 'SUCCESS' }, statusCode: 200 },
        );
        expect((mocked.body as { loginStatus: string }).loginStatus).toBe('OP2_INTERCEPT');
    });

    it('handles request bodies that come pre-parsed as objects (not strings)', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '/x', requestBodyContains: 'foo' },
            staticResponse: { status: 200, jsonBody: { mocked: true } },
        });
        const result = await runScript(
            script, 'http://example.com/x',
            { method: 'POST', body: { foo: 'bar' } },
            { body: 'real', statusCode: 200 },
        );
        expect(result.body).toEqual({ mocked: true });
    });

    it('escapes special characters in matcher values to prevent injection', async () => {
        const script = buildScriptContent({
            matcher: { pathContains: '"; alert(1); //' },
            staticResponse: { status: 200, jsonBody: { ok: true } },
        });
        // If the special characters weren't escaped, the script would fail to
        // compile. Surviving runScript() proves the escape is correct.
        const result = await runScript(
            script,
            'http://example.com/anything',
            {},
            { body: 'real' },
        );
        expect(result.body).toBe('real');
    });
});

describe('rule-name tagging helpers', () => {
    it('builds a stable, parseable rule name', () => {
        expect(buildRuleName('sess-1', 'mock-abcd')).toBe('mca:sess-1:mock-abcd');
    });

    it('isOurRuleForSession matches only the right session', () => {
        expect(isOurRuleForSession('mca:sess-1:m1', 'sess-1')).toBe(true);
        expect(isOurRuleForSession('mca:sess-2:m1', 'sess-1')).toBe(false);
        expect(isOurRuleForSession('OtherRule', 'sess-1')).toBe(false);
    });

    it('isOurRule matches any mca-prefixed rule', () => {
        expect(isOurRule('mca:foo:bar')).toBe(true);
        expect(isOurRule('user-rule')).toBe(false);
    });
});
