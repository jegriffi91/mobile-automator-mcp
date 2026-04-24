/**
 * End-to-end tests for MockServer.
 *
 * These stand up a real local HTTP origin, a real MockServer in front of it,
 * and drive traffic via the global fetch() — the same path that the simulator
 * would take. This is expensive-ish (TCP sockets, process-level), but it's the
 * only way to validate the proxy + transform behavior in realistic conditions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { MockServer, type MockSpec } from './mock-manager.js';

interface Origin {
    server: http.Server;
    port: number;
    urlFor(path: string): string;
    calls: Array<{ method: string; url: string; body: string }>;
}

async function startOrigin(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Origin> {
    const calls: Origin['calls'] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            calls.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });
            handler(req, res, body);
        });
    });
    const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr !== 'string') resolve(addr.port);
        });
    });
    return {
        server,
        port,
        urlFor: (p) => `http://127.0.0.1:${port}${p}`,
        calls,
    };
}

async function stopOrigin(o: Origin): Promise<void> {
    await new Promise<void>((resolve) => o.server.close(() => resolve()));
}

describe('MockServer', () => {
    let mock: MockServer;
    let origin: Origin;

    afterEach(async () => {
        if (mock) await mock.stop();
        if (origin) await stopOrigin(origin);
    });

    it('serves a static JSON response when a matcher hits', async () => {
        mock = new MockServer();
        mock.setMock({
            id: 'login-override',
            matcher: { pathContains: '/api/login' },
            staticResponse: { status: 200, jsonBody: { loginStatus: 'OP2_INTERCEPT' } },
        });
        const port = await mock.start();

        const res = await fetch(`http://127.0.0.1:${port}/api/login`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ loginStatus: 'OP2_INTERCEPT' });
    });

    it('404s a matcher miss when no defaultPassthroughUrl is configured', async () => {
        mock = new MockServer();
        const port = await mock.start();

        const res = await fetch(`http://127.0.0.1:${port}/anything`);
        expect(res.status).toBe(404);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/No mock matched/);
    });

    it('proxies non-matched requests to defaultPassthroughUrl', async () => {
        origin = await startOrigin((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ origin: true }));
        });
        mock = new MockServer();
        mock.setDefaultPassthrough(origin.urlFor(''));
        const port = await mock.start();

        const res = await fetch(`http://127.0.0.1:${port}/something`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ origin: true });
        expect(origin.calls.length).toBe(1);
        expect(origin.calls[0].url).toBe('/something');
    });

    it('proxies a matched mock to its proxyBaseUrl and applies jsonPatch', async () => {
        origin = await startOrigin((_req, res, body) => {
            const parsed = body ? JSON.parse(body) : {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                data: {
                    customerStatusV3: { loginStatus: 'SUCCESS' },
                    echoedBody: parsed,
                },
            }));
        });
        mock = new MockServer();
        mock.setMock({
            id: 'status-override',
            matcher: { pathContains: '/graphql', method: 'POST' },
            proxyBaseUrl: origin.urlFor(''),
            responseTransform: {
                jsonPatch: [
                    { op: 'replace', path: '/data/customerStatusV3/loginStatus', value: 'OP2_INTERCEPT' },
                ],
            },
        });
        const port = await mock.start();

        const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'CustomerStatusAndCustomerAuthenticationQuery' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json() as { data: { customerStatusV3: { loginStatus: string }; echoedBody: unknown } };
        expect(body.data.customerStatusV3.loginStatus).toBe('OP2_INTERCEPT');
        // Request body passed through to origin untouched
        expect(body.data.echoedBody).toEqual({ query: 'CustomerStatusAndCustomerAuthenticationQuery' });
    });

    it('matches on requestBodyContains', async () => {
        origin = await startOrigin((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ flag: 'real' }));
        });
        mock = new MockServer();
        mock.setDefaultPassthrough(origin.urlFor(''));
        mock.setMock({
            id: 'query-override',
            matcher: { pathContains: '/graphql', requestBodyContains: 'TargetedQuery' },
            staticResponse: { status: 200, jsonBody: { flag: 'mocked' } },
        });
        const port = await mock.start();

        // Non-matching body → real backend
        const realRes = await fetch(`http://127.0.0.1:${port}/graphql`, {
            method: 'POST',
            body: 'OtherQuery',
        });
        expect(await realRes.json()).toEqual({ flag: 'real' });

        // Matching body → static mock
        const mockRes = await fetch(`http://127.0.0.1:${port}/graphql`, {
            method: 'POST',
            body: 'TargetedQuery',
        });
        expect(await mockRes.json()).toEqual({ flag: 'mocked' });
    });

    it('removes a mock by id and falls back to passthrough', async () => {
        origin = await startOrigin((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ origin: true }));
        });
        mock = new MockServer();
        mock.setDefaultPassthrough(origin.urlFor(''));
        mock.setMock({
            id: 'temp',
            matcher: { pathContains: '/api/x' },
            staticResponse: { status: 200, jsonBody: { mocked: true } },
        });
        const port = await mock.start();

        expect(await (await fetch(`http://127.0.0.1:${port}/api/x`)).json()).toEqual({ mocked: true });

        const removed = mock.removeMock('temp');
        expect(removed).toBe(true);

        expect(await (await fetch(`http://127.0.0.1:${port}/api/x`)).json()).toEqual({ origin: true });
    });

    it('later registrations win on overlapping matchers', async () => {
        mock = new MockServer();
        mock.setMock({
            id: 'first',
            matcher: { pathContains: '/api' },
            staticResponse: { status: 200, jsonBody: { who: 'first' } },
        });
        mock.setMock({
            id: 'second',
            matcher: { pathContains: '/api' },
            staticResponse: { status: 200, jsonBody: { who: 'second' } },
        });
        const port = await mock.start();

        expect(await (await fetch(`http://127.0.0.1:${port}/api/anything`)).json()).toEqual({ who: 'second' });
    });

    it('returns 502 when the proxied response is not JSON but jsonPatch is requested', async () => {
        origin = await startOrigin((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html>not json</html>');
        });
        mock = new MockServer();
        mock.setMock({
            id: 'bad-transform',
            matcher: { pathContains: '/weird' },
            proxyBaseUrl: origin.urlFor(''),
            responseTransform: { jsonPatch: [{ op: 'replace', path: '/x', value: 1 }] },
        });
        const port = await mock.start();

        const res = await fetch(`http://127.0.0.1:${port}/weird`);
        expect(res.status).toBe(502);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/responseTransform failed/);
    });

    it('rejects a mock with both staticResponse and proxyBaseUrl', () => {
        const m = new MockServer();
        const bad: MockSpec = {
            id: 'x',
            matcher: {},
            staticResponse: { status: 200 },
            proxyBaseUrl: 'http://localhost:1',
        };
        expect(() => m.setMock(bad)).toThrow(/mutually exclusive/);
    });

    it('rejects a mock with neither staticResponse nor proxyBaseUrl', () => {
        const m = new MockServer();
        expect(() => m.setMock({ id: 'x', matcher: {} })).toThrow(/must have either/);
    });

    it('rejects responseTransform without proxyBaseUrl', () => {
        const m = new MockServer();
        expect(() =>
            m.setMock({
                id: 'x',
                matcher: {},
                staticResponse: { status: 200 },
                responseTransform: { jsonPatch: [] },
            }),
        ).toThrow(/responseTransform requires proxyBaseUrl/);
    });

    it('start + stop is idempotent under double stop', async () => {
        mock = new MockServer();
        await mock.start();
        await mock.stop();
        await mock.stop();
        expect(mock.getPort()).toBeNull();
    });
});
