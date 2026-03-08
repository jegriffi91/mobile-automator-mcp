/**
 * ProxymanWrapper — Interface to Proxyman via `proxyman-cli` HAR export.
 *
 * Uses `proxyman-cli export-log` with domain filtering to avoid noisy traffic.
 * HAR entries are mapped to our unified NetworkEvent model.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { NetworkEvent } from '../types.js';

const execFileAsync = promisify(execFile);

const PROXYMAN_CLI = '/Applications/Proxyman.app/Contents/MacOS/proxyman-cli';

// ── Minimal HAR type definitions ──

interface HarEntry {
    startedDateTime: string;
    request: {
        method: string;
        url: string;
        postData?: { text?: string };
    };
    response: {
        status: number;
        content: {
            text?: string;
            mimeType?: string;
        };
    };
    time?: number;
}

interface HarLog {
    log: {
        entries: HarEntry[];
    };
}

export class ProxymanWrapper {
    private cliBin: string;

    constructor(cliBin = PROXYMAN_CLI) {
        this.cliBin = cliBin;
    }

    /**
     * Export current Proxyman traffic as a HAR file.
     * Supports domain filtering to reduce noise (e.g., only capture `api.myapp.com`).
     */
    async exportHar(outputPath: string, domains?: string[]): Promise<string> {
        const args = ['export-log'];

        if (domains && domains.length > 0) {
            args.push('-m', 'domains');
            for (const d of domains) {
                args.push('--domains', d);
            }
        } else {
            args.push('-m', 'all');
        }

        args.push('-f', 'har', '-o', outputPath);

        try {
            await execFileAsync(this.cliBin, args);
            return outputPath;
        } catch (error: any) {
            console.error('[ProxymanWrapper] exportHar failed:', error);
            throw new Error(`Failed to export HAR: ${error.message || String(error)}`);
        }
    }

    /**
     * Snapshot the current Proxyman traffic count.
     * Called at recording start so we can scope the HAR export later.
     */
    async snapshotBaseline(domains?: string[]): Promise<number> {
        const tmpFile = path.join(os.tmpdir(), `proxyman-baseline-${randomUUID()}.har`);
        try {
            await this.exportHar(tmpFile, domains);
            const raw = await fs.readFile(tmpFile, 'utf-8');
            const har: HarLog = JSON.parse(raw);
            const count = har.log.entries.length;
            console.error(`[ProxymanWrapper] snapshotBaseline: ${count} entries at baseline (domains: ${domains?.join(', ') ?? 'all'})`);
            return count;
        } catch {
            // Proxyman may not be running or session is empty — baseline is 0
            console.error('[ProxymanWrapper] snapshotBaseline: no existing traffic, baseline = 0');
            return 0;
        } finally {
            await fs.unlink(tmpFile).catch(() => { });
        }
    }

    /**
     * Export Proxyman traffic scoped to entries captured AFTER the baseline.
     * Slices the HAR to only include entries beyond the baseline count.
     */
    async exportHarScoped(
        outputPath: string,
        baselineCount: number,
        domains?: string[]
    ): Promise<string> {
        const tmpFile = path.join(os.tmpdir(), `proxyman-scoped-${randomUUID()}.har`);
        try {
            await this.exportHar(tmpFile, domains);
            const raw = await fs.readFile(tmpFile, 'utf-8');
            const har: HarLog = JSON.parse(raw);

            // Slice entries to only those after the baseline
            har.log.entries = har.log.entries.slice(baselineCount);

            await fs.writeFile(outputPath, JSON.stringify(har, null, 2), 'utf-8');
            console.error(
                `[ProxymanWrapper] exportHarScoped: ${har.log.entries.length} new entries (baseline was ${baselineCount})`
            );
            return outputPath;
        } catch (error: any) {
            console.error('[ProxymanWrapper] exportHarScoped failed:', error);
            throw new Error(`Failed to export scoped HAR: ${error.message || String(error)}`);
        } finally {
            await fs.unlink(tmpFile).catch(() => { });
        }
    }

    /**
     * Retrieve recent HTTP transactions from Proxyman, mapped to NetworkEvent[].
     *
     * @param sessionId - The session ID to tag events with
     * @param filterPath - Optional URL substring to post-filter results (e.g., "/api/sdui")
     * @param limit - Max entries to return (default 50)
     * @param domains - Optional domain list passed to proxyman-cli for pre-filtering
     */
    async getTransactions(
        sessionId: string,
        filterPath?: string,
        limit = 50,
        domains?: string[]
    ): Promise<NetworkEvent[]> {
        const tmpFile = path.join(os.tmpdir(), `proxyman-har-${randomUUID()}.har`);

        try {
            await this.exportHar(tmpFile, domains);
            const raw = await fs.readFile(tmpFile, 'utf-8');
            const har: HarLog = JSON.parse(raw);

            let events: NetworkEvent[] = har.log.entries.map((entry) => ({
                sessionId,
                timestamp: entry.startedDateTime,
                method: entry.request.method,
                url: entry.request.url,
                statusCode: entry.response.status,
                requestBody: entry.request.postData?.text,
                responseBody: entry.response.content?.text,
                durationMs: entry.time ? Math.round(entry.time) : undefined,
            }));

            // Post-filter by URL path substring
            if (filterPath) {
                events = events.filter((e) => e.url.includes(filterPath));
            }

            return events.slice(0, limit);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new Error(
                    `Proxyman CLI not found at '${this.cliBin}'. Please ensure Proxyman is installed.`
                );
            }
            console.error('[ProxymanWrapper] getTransactions failed:', error);
            throw error;
        } finally {
            await fs.unlink(tmpFile).catch(() => { });
        }
    }

    /**
     * Fetch the parsed response body for a specific URL from recent Proxyman traffic.
     *
     * @param url - The exact or partial URL to match
     * @param domains - Optional domain list for pre-filtering
     */
    async getPayload(url: string, domains?: string[]): Promise<Record<string, unknown> | null> {
        const tmpFile = path.join(os.tmpdir(), `proxyman-har-${randomUUID()}.har`);

        try {
            await this.exportHar(tmpFile, domains);
            const raw = await fs.readFile(tmpFile, 'utf-8');
            const har: HarLog = JSON.parse(raw);

            // Find the most recent matching entry (last match wins)
            const match = har.log.entries
                .filter((e) => e.request.url.includes(url))
                .pop();

            if (!match || !match.response.content?.text) {
                return null;
            }

            return JSON.parse(match.response.content.text);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new Error(
                    `Proxyman CLI not found at '${this.cliBin}'. Please ensure Proxyman is installed.`
                );
            }
            console.error(`[ProxymanWrapper] getPayload(${url}) failed:`, error);
            return null;
        } finally {
            await fs.unlink(tmpFile).catch(() => { });
        }
    }
}
