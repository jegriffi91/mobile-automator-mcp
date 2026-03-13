/**
 * StubWriter — Generates WireMock-compatible JSON stubs and response fixtures
 * from correlated recording session data.
 *
 * Supports three mocking modes:
 *   - 'full': all captured APIs get stubs, no proxy fallback
 *   - 'include': only specified routes are stubbed, rest proxied to real server
 *   - 'exclude': all routes stubbed EXCEPT specified ones, which are proxied
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CorrelatedStep, CorrelatedNetworkCapture } from './correlator.js';

// ── Public types ──

export interface MockingConfig {
    /** Mocking mode: full (default), include (mock only listed), exclude (mock all except listed) */
    mode: 'full' | 'include' | 'exclude';
    /** Route path patterns to include or exclude (e.g., ["/api/login", "/api/lore/detail"]) */
    routes?: string[];
    /** Real server URL for proxy passthrough on non-mocked routes */
    proxyBaseUrl?: string;
}

export interface StubRoute {
    method: string;
    path: string;
    fixtureFile: string;
    statusCode: number;
    contentType: string;
}

export interface StubManifest {
    /** Session metadata */
    sessionId: string;
    createdAt: string;
    mockingConfig: MockingConfig;
    /** All recorded routes with their fixture files */
    routes: StubRoute[];
}

// ── StubWriter ──

export class StubWriter {
    /**
     * Write WireMock stubs and response fixtures from correlated steps.
     *
     * Output structure:
     *   outputDir/
     *     manifest.json
     *     wiremock/
     *       mappings/        ← WireMock stub JSON files
     *       __files/         ← Response body fixtures
     */
    async writeStubs(
        sessionId: string,
        steps: CorrelatedStep[],
        outputDir: string,
        config: MockingConfig = { mode: 'full' }
    ): Promise<StubManifest> {
        const mappingsDir = path.join(outputDir, 'wiremock', 'mappings');
        const filesDir = path.join(outputDir, 'wiremock', '__files');
        await fs.mkdir(mappingsDir, { recursive: true });
        await fs.mkdir(filesDir, { recursive: true });

        // Collect all unique network captures across all steps
        const allCaptures = this.collectCaptures(steps);

        // Deduplicate by fixture ID (same endpoint may be hit multiple times)
        const uniqueCaptures = this.deduplicateCaptures(allCaptures);

        // Filter based on mocking config
        const filteredCaptures = this.filterCaptures(uniqueCaptures, config);

        // Write fixture files and WireMock mappings in parallel
        const routeEntries = await Promise.all(
            filteredCaptures.map(async (capture) => {
                const fixtureFileName = `${capture.fixtureId}_response.json`;
                const mappingFileName = `${capture.fixtureId}.json`;

                // Write response body fixture
                const responseBody = capture.event.responseBody || '{}';
                const contentType = this.inferContentType(responseBody);
                const mapping = this.buildMapping(capture, fixtureFileName, contentType);

                // Parallel write of fixture + mapping
                await Promise.all([
                    fs.writeFile(path.join(filesDir, fixtureFileName), responseBody, 'utf-8'),
                    fs.writeFile(
                        path.join(mappingsDir, mappingFileName),
                        JSON.stringify(mapping, null, 2),
                        'utf-8',
                    ),
                ]);

                return {
                    method: capture.requestPattern.method,
                    path: capture.requestPattern.pathPattern,
                    fixtureFile: fixtureFileName,
                    statusCode: capture.event.statusCode,
                    contentType,
                } as StubRoute;
            })
        );

        const routes: StubRoute[] = routeEntries;

        // Write catch-all proxy mapping for include/exclude modes
        if (config.mode !== 'full' && config.proxyBaseUrl) {
            const proxyMapping = this.buildProxyMapping(config.proxyBaseUrl);
            await fs.writeFile(
                path.join(mappingsDir, '_proxy_fallback.json'),
                JSON.stringify(proxyMapping, null, 2),
                'utf-8'
            );
        }

        // Write manifest
        const manifest: StubManifest = {
            sessionId,
            createdAt: new Date().toISOString(),
            mockingConfig: config,
            routes,
        };
        await fs.writeFile(
            path.join(outputDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf-8'
        );

        console.error(
            `[StubWriter] wrote ${routes.length} stubs + fixtures to ${outputDir}` +
            (config.mode !== 'full' ? ` (mode=${config.mode}, proxy=${config.proxyBaseUrl})` : '')
        );

        return manifest;
    }

    /**
     * Collect all CorrelatedNetworkCaptures from correlated steps.
     */
    private collectCaptures(steps: CorrelatedStep[]): CorrelatedNetworkCapture[] {
        const captures: CorrelatedNetworkCapture[] = [];
        for (const step of steps) {
            captures.push(...step.networkCaptures);
        }
        return captures;
    }

    /**
     * Deduplicate captures by fixture ID (keep last occurrence for freshest data).
     */
    private deduplicateCaptures(
        captures: CorrelatedNetworkCapture[]
    ): CorrelatedNetworkCapture[] {
        const seen = new Map<string, CorrelatedNetworkCapture>();
        for (const capture of captures) {
            seen.set(capture.fixtureId, capture); // last wins
        }
        return Array.from(seen.values());
    }

    /**
     * Filter captures based on mocking config mode.
     */
    private filterCaptures(
        captures: CorrelatedNetworkCapture[],
        config: MockingConfig
    ): CorrelatedNetworkCapture[] {
        if (config.mode === 'full' || !config.routes || config.routes.length === 0) {
            return captures;
        }

        if (config.mode === 'include') {
            // Only keep captures whose path matches one of the included routes
            return captures.filter((c) =>
                config.routes!.some((r) => c.requestPattern.pathPattern.startsWith(r))
            );
        }

        if (config.mode === 'exclude') {
            // Keep all captures EXCEPT those matching excluded routes
            return captures.filter((c) =>
                !config.routes!.some((r) => c.requestPattern.pathPattern.startsWith(r))
            );
        }

        return captures;
    }

    /**
     * Build a WireMock mapping JSON object from a network capture.
     */
    private buildMapping(
        capture: CorrelatedNetworkCapture,
        fixtureFileName: string,
        contentType: string
    ): Record<string, unknown> {
        return {
            priority: 1,
            request: {
                method: capture.requestPattern.method,
                urlPathPattern: capture.requestPattern.pathPattern,
            },
            response: {
                status: capture.event.statusCode,
                bodyFileName: fixtureFileName,
                headers: {
                    'Content-Type': contentType,
                },
            },
        };
    }

    /**
     * Build a low-priority catch-all proxy mapping for passthrough mode.
     */
    private buildProxyMapping(proxyBaseUrl: string): Record<string, unknown> {
        return {
            priority: 99,
            request: {
                urlPattern: '.*',
            },
            response: {
                proxyBaseUrl,
            },
        };
    }

    /**
     * Infer content type from response body.
     */
    private inferContentType(body: string): string {
        try {
            JSON.parse(body);
            return 'application/json';
        } catch {
            return 'text/plain';
        }
    }
}
