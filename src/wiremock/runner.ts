/**
 * StubServer — Lightweight in-process HTTP stub server.
 *
 * Serves WireMock-compatible stubs (mappings/ + __files/) using Node's
 * built-in http module. Zero external dependencies — no WireMock JAR needed.
 *
 * Designed for test execution: start before Maestro, stop after.
 */

import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';

// ── Types ──

interface StubMapping {
    priority: number;
    request: {
        method?: string;
        urlPathPattern?: string;
        urlPattern?: string;
    };
    response: {
        status?: number;
        body?: string;
        jsonBody?: unknown;
        bodyFileName?: string;
        proxyBaseUrl?: string;
        headers?: Record<string, string>;
    };
}

export class StubServer {
    private server: http.Server | null = null;
    private mappings: StubMapping[] = [];
    private filesDir: string = '';
    private fixtureCache: Map<string, string> = new Map();

    /**
     * Clear all loaded mappings and cached fixtures to isolate tests.
     */
    clearStubs(): void {
        this.mappings = [];
        this.fixtureCache.clear();
    }

    /**
     * Load WireMock-compatible mappings and __files from a stubs directory.
     *
     * Expected structure:
     *   stubsDir/
     *     mappings/*.json
     *     __files/*_response.json
     */
    async loadStubs(stubsDir: string, append = false): Promise<number> {
        // Normalize: if caller passed the mappings/ subdirectory directly, go up one level
        const normalizedDir = path.basename(stubsDir) === 'mappings'
            ? path.dirname(stubsDir)
            : stubsDir;
        const mappingsDir = path.join(normalizedDir, 'mappings');
        this.filesDir = path.join(normalizedDir, '__files');

        try {
            const files = await fs.readdir(mappingsDir);
            const jsonFiles = files.filter((f) => f.endsWith('.json'));

            // Read all mapping files in parallel
            const rawMappings = await Promise.all(
                jsonFiles.map(async (file) => {
                    const raw = await fs.readFile(path.join(mappingsDir, file), 'utf-8');
                    return JSON.parse(raw) as StubMapping;
                })
            );
            if (append) {
                this.mappings.unshift(...rawMappings);
            } else {
                this.mappings = rawMappings;
            }

            // Sort by priority (lower = higher priority)
            this.mappings.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

            // Pre-load all fixture files into memory to eliminate per-request I/O
            if (!append) {
                this.fixtureCache.clear();
            }
            try {
                const fixtureFiles = await fs.readdir(this.filesDir);
                const fixtureContents = await Promise.all(
                    fixtureFiles.map(async (f) => ({
                        name: f,
                        content: await fs.readFile(path.join(this.filesDir, f), 'utf-8'),
                    }))
                );
                for (const { name, content } of fixtureContents) {
                    this.fixtureCache.set(name, content);
                }
                console.error(`[StubServer] pre-loaded ${fixtureContents.length} new fixture(s) into memory (total: ${this.fixtureCache.size})`);
            } catch {
                // __files dir may not exist if no fixtures — that's fine
            }

            console.error(`[StubServer] loaded ${rawMappings.length} mappings from ${mappingsDir} (total: ${this.mappings.length})`);
            return this.mappings.length;
        } catch (error: any) {
            throw new Error(`Failed to load stubs from ${stubsDir}: ${error.message}`);
        }
    }

    /**
     * Start the stub server on the given port.
     * If port is 0, an available port is auto-selected.
     */
    async start(port = 0): Promise<number> {
        if (this.server) {
            throw new Error('StubServer is already running');
        }

        const actualPort = port === 0 ? await StubServer.findAvailablePort() : port;

        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                await this.handleRequest(req, res);
            });

            this.server.on('error', reject);
            this.server.listen(actualPort, '0.0.0.0', () => {
                console.error(`[StubServer] listening on port ${actualPort}`);
                resolve(actualPort);
            });
        });
    }

    /**
     * Stop the stub server.
     */
    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close(() => {
                console.error('[StubServer] stopped');
                this.server = null;
                resolve();
            });
        });
    }

    /**
     * Find an available port.
     */
    static findAvailablePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, () => {
                const addr = srv.address();
                if (addr && typeof addr !== 'string') {
                    const port = addr.port;
                    srv.close(() => resolve(port));
                } else {
                    srv.close(() => reject(new Error('Could not determine port')));
                }
            });
        });
    }

    /**
     * Match an incoming request to a loaded mapping and serve the response.
     */
    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? 'GET';
        const url = req.url ?? '/';

        // Try to match against loaded mappings
        for (const mapping of this.mappings) {
            if (this.matchesRequest(mapping, method, url)) {
                await this.serveMapping(mapping, res);
                console.error(`[StubServer] ${method} ${url} → matched (status ${mapping.response.status ?? 200})`);
                return;
            }
        }

        // No match — 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No stub mapping matched', method, url }));
        console.error(`[StubServer] ${method} ${url} → 404 (no match)`);
    }

    /**
     * Check if a request matches a mapping's request pattern.
     */
    private matchesRequest(mapping: StubMapping, method: string, url: string): boolean {
        // Check method (if specified)
        if (mapping.request.method && mapping.request.method !== method) {
            return false;
        }

        // Check URL path pattern (exact prefix match)
        if (mapping.request.urlPathPattern) {
            const reqPath = url.split('?')[0];
            if (reqPath !== mapping.request.urlPathPattern) {
                return false;
            }
            return true;
        }

        // Check URL regex pattern (e.g., ".*" for catch-all proxy)
        if (mapping.request.urlPattern) {
            try {
                const regex = new RegExp(mapping.request.urlPattern);
                return regex.test(url);
            } catch {
                return false;
            }
        }

        return false;
    }

    /**
     * Serve a matched mapping's response.
     */
    private async serveMapping(mapping: StubMapping, res: http.ServerResponse): Promise<void> {
        const status = mapping.response.status ?? 200;
        const headers = mapping.response.headers ?? {};

        // If bodyFileName is specified, serve from in-memory cache
        if (mapping.response.bodyFileName) {
            const body = this.fixtureCache.get(mapping.response.bodyFileName);
            if (body !== undefined) {
                res.writeHead(status, headers);
                res.end(body);
                return;
            }
            // Cache miss — fixture wasn't pre-loaded
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Fixture not found: ${mapping.response.bodyFileName}` }));
            return;
        }

        // If inline body string
        if (mapping.response.body) {
            res.writeHead(status, headers);
            res.end(mapping.response.body);
            return;
        }

        // If inline json object
        if (mapping.response.jsonBody !== undefined) {
            res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mapping.response.jsonBody));
            return;
        }

        // Empty response
        res.writeHead(status, headers);
        res.end();
    }
}
