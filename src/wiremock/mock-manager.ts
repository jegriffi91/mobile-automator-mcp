/**
 * MockServer — Runtime HTTP mock/proxy server for the MCP's live-mocking tools.
 *
 * Separate from StubServer (which is purpose-built for file-based record/replay)
 * because the programmatic shape and behavior are different:
 *   - Mocks are registered/removed by ID at runtime via set_mock_response
 *   - Non-matched requests are proxied to a real backend (not 404'd)
 *   - Matched proxy-mode mocks can transform the backend's response via JSON Patch
 *
 * One MockServer instance per recording session. Lifecycle is driven by the
 * MCP tools set_mock_response / clear_mock_responses and the session teardown
 * path in stop_and_compile_test.
 */

import * as http from 'http';
import * as net from 'net';
import { applyPatch, type JsonPatchOp, JsonPatchError } from './json-patch.js';

export interface MockMatcher {
    pathContains?: string;
    urlPathEquals?: string;
    method?: string;
    requestBodyContains?: string;
}

export interface MockStaticResponse {
    status?: number;
    jsonBody?: unknown;
    body?: string;
    headers?: Record<string, string>;
}

export interface MockResponseTransform {
    jsonPatch: readonly JsonPatchOp[];
}

export interface MockSpec {
    id: string;
    matcher: MockMatcher;
    /** If set, matched requests are proxied here (and optionally transformed). */
    proxyBaseUrl?: string;
    /** Applied to the proxied response body (requires proxyBaseUrl). */
    responseTransform?: MockResponseTransform;
    /** Used when proxyBaseUrl is absent — return this directly. */
    staticResponse?: MockStaticResponse;
}

export class MockServer {
    private server: http.Server | null = null;
    private mocks: MockSpec[] = [];
    private defaultPassthroughUrl: string | null = null;
    private listeningPort: number | null = null;

    /** Default backend URL used for requests that no mock matched. */
    setDefaultPassthrough(url: string | null): void {
        this.defaultPassthroughUrl = url;
    }

    getDefaultPassthrough(): string | null {
        return this.defaultPassthroughUrl;
    }

    getPort(): number | null {
        return this.listeningPort;
    }

    listMocks(): readonly MockSpec[] {
        return this.mocks;
    }

    /** Register or replace a mock by ID. Later registrations take precedence at match time. */
    setMock(mock: MockSpec): void {
        validateMock(mock);
        const existingIdx = this.mocks.findIndex((m) => m.id === mock.id);
        if (existingIdx >= 0) {
            this.mocks[existingIdx] = mock;
        } else {
            this.mocks.push(mock);
        }
    }

    /** Remove a mock by ID. Returns true if a mock was removed. */
    removeMock(id: string): boolean {
        const idx = this.mocks.findIndex((m) => m.id === id);
        if (idx < 0) return false;
        this.mocks.splice(idx, 1);
        return true;
    }

    clearMocks(): void {
        this.mocks = [];
    }

    async start(port = 0): Promise<number> {
        if (this.server) throw new Error('MockServer already running');
        const actualPort = port === 0 ? await findAvailablePort() : port;

        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res).catch((err) => {
                    console.error('[MockServer] request handler crashed', err);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `MockServer error: ${(err as Error).message}` }));
                    }
                });
            });
            this.server.on('error', reject);
            this.server.listen(actualPort, '0.0.0.0', () => {
                this.listeningPort = actualPort;
                console.error(`[MockServer] listening on port ${actualPort}`);
                resolve(actualPort);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => {
            this.server!.close(() => {
                this.server = null;
                this.listeningPort = null;
                console.error('[MockServer] stopped');
                resolve();
            });
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? 'GET';
        const url = req.url ?? '/';
        const bodyBuf = await readBody(req);

        const matched = this.findMatch(method, url, bodyBuf);

        if (matched) {
            if (matched.staticResponse) {
                await serveStatic(matched, res);
                console.error(`[MockServer] ${method} ${url} → static (mock ${matched.id})`);
                return;
            }
            if (matched.proxyBaseUrl) {
                await this.proxyAndMaybeTransform(matched, req, bodyBuf, res);
                console.error(`[MockServer] ${method} ${url} → proxied+transformed (mock ${matched.id})`);
                return;
            }
            // Mock is malformed (neither static nor proxy). Fall through to default behavior.
        }

        if (this.defaultPassthroughUrl) {
            await proxyPassthrough(this.defaultPassthroughUrl, req, bodyBuf, res);
            console.error(`[MockServer] ${method} ${url} → passthrough`);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No mock matched and no defaultPassthroughUrl configured', method, url }));
    }

    private findMatch(method: string, url: string, body: Buffer): MockSpec | undefined {
        // Iterate in reverse so later-registered mocks win on ties.
        for (let i = this.mocks.length - 1; i >= 0; i--) {
            if (matchesRequest(this.mocks[i], method, url, body)) return this.mocks[i];
        }
        return undefined;
    }

    private async proxyAndMaybeTransform(
        mock: MockSpec,
        req: http.IncomingMessage,
        body: Buffer,
        res: http.ServerResponse,
    ): Promise<void> {
        const upstream = await fetchUpstream(mock.proxyBaseUrl!, req, body);

        if (!mock.responseTransform) {
            res.writeHead(upstream.status, upstream.headers);
            res.end(upstream.body);
            return;
        }

        // Transform: parse, apply patch, re-serialize. Hop-by-hop headers stripped below.
        try {
            const parsed = JSON.parse(upstream.body.toString('utf8')) as unknown;
            const patched = applyPatch(parsed, mock.responseTransform.jsonPatch);
            const patchedBody = JSON.stringify(patched);
            const headers = { ...upstream.headers };
            delete headers['content-length'];
            delete headers['content-encoding']; // we re-serialized, don't claim any prior encoding
            headers['content-type'] = headers['content-type'] ?? 'application/json';
            res.writeHead(upstream.status, headers);
            res.end(patchedBody);
        } catch (err) {
            const detail = err instanceof JsonPatchError ? err.message : (err as Error).message;
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'responseTransform failed', detail }));
        }
    }
}

function validateMock(mock: MockSpec): void {
    if (!mock.id) throw new Error('MockSpec.id is required');
    if (!mock.matcher) throw new Error('MockSpec.matcher is required');

    const hasStatic = mock.staticResponse !== undefined;
    const hasProxy = mock.proxyBaseUrl !== undefined;
    if (!hasStatic && !hasProxy) {
        throw new Error(`MockSpec ${mock.id}: must have either staticResponse or proxyBaseUrl`);
    }
    if (hasStatic && hasProxy) {
        throw new Error(`MockSpec ${mock.id}: staticResponse and proxyBaseUrl are mutually exclusive`);
    }
    if (mock.responseTransform && !hasProxy) {
        throw new Error(`MockSpec ${mock.id}: responseTransform requires proxyBaseUrl`);
    }
}

function matchesRequest(mock: MockSpec, method: string, url: string, body: Buffer): boolean {
    const m = mock.matcher;
    if (m.method && m.method.toUpperCase() !== method.toUpperCase()) return false;
    if (m.pathContains && !url.includes(m.pathContains)) return false;
    if (m.urlPathEquals) {
        const reqPath = url.split('?')[0];
        if (reqPath !== m.urlPathEquals) return false;
    }
    if (m.requestBodyContains) {
        if (!body.toString('utf8').includes(m.requestBodyContains)) return false;
    }
    return true;
}

async function serveStatic(mock: MockSpec, res: http.ServerResponse): Promise<void> {
    const r = mock.staticResponse!;
    const status = r.status ?? 200;
    const headers = { ...(r.headers ?? {}) };

    if (r.jsonBody !== undefined) {
        if (!headers['content-type'] && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        res.writeHead(status, headers);
        res.end(JSON.stringify(r.jsonBody));
        return;
    }
    if (r.body !== undefined) {
        res.writeHead(status, headers);
        res.end(r.body);
        return;
    }
    res.writeHead(status, headers);
    res.end();
}

interface UpstreamResponse {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

async function fetchUpstream(
    baseUrl: string,
    req: http.IncomingMessage,
    body: Buffer,
): Promise<UpstreamResponse> {
    const target = joinUrl(baseUrl, req.url ?? '/');
    const outgoingHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        const key = k.toLowerCase();
        // Strip hop-by-hop / connection-specific headers; rewrite host.
        if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) continue;
        outgoingHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    const response = await fetch(target, {
        method: req.method ?? 'GET',
        headers: outgoingHeaders,
        body: body.length > 0 ? body : undefined,
    });

    const responseBody = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    return { status: response.status, headers, body: responseBody };
}

async function proxyPassthrough(
    baseUrl: string,
    req: http.IncomingMessage,
    body: Buffer,
    res: http.ServerResponse,
): Promise<void> {
    const upstream = await fetchUpstream(baseUrl, req, body);
    res.writeHead(upstream.status, upstream.headers);
    res.end(upstream.body);
}

function joinUrl(base: string, pathWithQuery: string): string {
    const baseNoSlash = base.endsWith('/') ? base.slice(0, -1) : base;
    const pathWithSlash = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
    return baseNoSlash + pathWithSlash;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const addr = srv.address();
            if (addr && typeof addr !== 'string') {
                const p = addr.port;
                srv.close(() => resolve(p));
            } else {
                srv.close(() => reject(new Error('Could not determine port')));
            }
        });
    });
}
