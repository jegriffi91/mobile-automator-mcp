/**
 * LoupeClient — wraps the `loupe` CLI and the in-process `LoupeServer` HTTP API.
 *
 * Loupe (heoblitz/Loupe) injects a dylib into the iOS Simulator app process at
 * `loupe start --bundle-id ...` time; the injected `LoupeServer` then exposes
 * an HTTP API on a loopback port for that UDID. This client resolves the
 * `udid → port` mapping (via `~/.loupe/runtimes` or `loupe current`) and talks
 * plain JSON over `fetch` for hierarchy/observation queries, plus the CLI for
 * HID-style actions (tap/swipe/type/back).
 *
 * Conservative defaults:
 *   • `execFile` (never `exec`) for CLI calls.
 *   • All HTTP calls timeout via AbortController (default 5s).
 *   • Missing / malformed runtime metadata is treated as "not injected" — never
 *     throws on read; the driver decides whether to fall back to Maestro.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { LoupeAccessibilityTree } from './hierarchy.js';

const execFileAsync = promisify(execFile);

/**
 * Compact observation payload returned by `GET /observation` — the cheap path
 * used for settle detection. Already filtered to visible/interactive elements,
 * capped server-side, and sorted in visual order.
 */
export interface LoupeCompactObservation {
    snapshotID?: string;
    screen?: string;
    visibleTexts?: string[];
    interactive?: Array<{
        ref: string;
        typeName?: string;
        className?: string;
        role?: string;
        text?: string;
        testID?: string;
        frame?: { x: number; y: number; width: number; height: number };
        enabled?: boolean;
    }>;
}

interface RuntimeEntry {
    bundleId: string;
    port: number;
    host?: string;
}

/**
 * Resolve the `loupe` binary path. Mirrors `resolveMaestroBin` shape — checks
 * Homebrew install locations, then falls back to bare `loupe` (PATH lookup).
 */
export function resolveLoupeBin(overridePath?: string): string {
    if (overridePath) return overridePath;
    const home = os.homedir();
    const candidates = [
        '/opt/homebrew/bin/loupe',
        '/usr/local/bin/loupe',
        path.join(home, '.loupe', 'bin', 'loupe'),
        'loupe',
    ];
    for (const candidate of candidates) {
        try {
            fsSync.accessSync(candidate, fsSync.constants.X_OK);
            return candidate;
        } catch {
            /* continue */
        }
    }
    return candidates[candidates.length - 1];
}

export interface LoupeClientOptions {
    binaryPath?: string;
    httpTimeoutMs?: number;
    cliTimeoutMs?: number;
}

export class LoupeClient {
    private readonly bin: string;
    private readonly httpTimeoutMs: number;
    private readonly cliTimeoutMs: number;
    private udid?: string;
    private bundleId?: string;
    private host = '127.0.0.1';
    private port?: number;

    constructor(opts: LoupeClientOptions = {}) {
        this.bin = resolveLoupeBin(opts.binaryPath);
        this.httpTimeoutMs = opts.httpTimeoutMs ?? 5_000;
        this.cliTimeoutMs = opts.cliTimeoutMs ?? 30_000;
    }

    get isInjected(): boolean {
        return this.port != null && this.udid != null;
    }

    get currentBundleId(): string | undefined {
        return this.bundleId;
    }

    /**
     * Spawn `loupe start --bundle-id <id> --udid <udid>` and wait for the
     * injected server to come up. Returns when GET /runtime responds 200, or
     * throws on timeout.
     */
    async start(udid: string, bundleId: string, timeoutMs = 15_000): Promise<void> {
        await this.runLoupe(['start', '--bundle-id', bundleId, '--udid', udid]);
        this.udid = udid;
        this.bundleId = bundleId;

        const deadline = Date.now() + timeoutMs;
        let lastErr: unknown;
        while (Date.now() < deadline) {
            try {
                const entry = await this.resolveRuntime(udid);
                if (entry) {
                    this.port = entry.port;
                    this.host = entry.host ?? '127.0.0.1';
                    const ok = await this.probeHealth();
                    if (ok) return;
                }
            } catch (err) {
                lastErr = err;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        this.port = undefined;
        const detail = lastErr instanceof Error ? `: ${lastErr.message}` : '';
        throw new Error(`Loupe runtime did not become healthy within ${timeoutMs}ms${detail}`);
    }

    /** Best-effort stop. Swallows errors — the driver may already be in teardown. */
    async stop(): Promise<void> {
        if (!this.udid) return;
        try {
            await this.runLoupe(['stop', '--udid', this.udid]);
        } catch {
            /* ignore */
        }
        this.udid = undefined;
        this.bundleId = undefined;
        this.port = undefined;
    }

    // ── HTTP API (against the injected server) ──

    async getAccessibility(): Promise<LoupeAccessibilityTree> {
        return this.getJson<LoupeAccessibilityTree>('/accessibility');
    }

    async getObservation(): Promise<LoupeCompactObservation> {
        return this.getJson<LoupeCompactObservation>('/observation');
    }

    async probeHealth(): Promise<boolean> {
        try {
            const res = await this.fetchWithTimeout(this.url('/runtime'));
            return res.ok;
        } catch {
            return false;
        }
    }

    // ── CLI actions ──

    async tapByTestId(testId: string): Promise<void> {
        this.requireInjected();
        await this.runLoupe(['tap', '--udid', this.udid!, '--test-id', testId]);
    }

    async tapByRef(ref: string): Promise<void> {
        this.requireInjected();
        await this.runLoupe(['tap', '--udid', this.udid!, '--ref', ref]);
    }

    async tapAtPoint(x: number, y: number): Promise<void> {
        this.requireInjected();
        await this.runLoupe(['tap', '--udid', this.udid!, '--x', String(Math.round(x)), '--y', String(Math.round(y))]);
    }

    async typeText(text: string): Promise<void> {
        this.requireInjected();
        await this.runLoupe(['type', '--udid', this.udid!, text]);
    }

    // ── Internals ──

    private url(path: string): string {
        if (!this.port) throw new Error('Loupe client is not injected — no port');
        return `http://${this.host}:${this.port}${path}`;
    }

    private async getJson<T>(path: string): Promise<T> {
        const res = await this.fetchWithTimeout(this.url(path));
        if (!res.ok) {
            throw new Error(`Loupe ${path} returned ${res.status}`);
        }
        return (await res.json()) as T;
    }

    private async fetchWithTimeout(url: string): Promise<Response> {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.httpTimeoutMs);
        try {
            return await fetch(url, { signal: ctrl.signal });
        } finally {
            clearTimeout(t);
        }
    }

    private requireInjected(): void {
        if (!this.isInjected) {
            throw new Error('Loupe client is not injected — call start(udid, bundleId) first');
        }
    }

    private async runLoupe(args: string[]): Promise<{ stdout: string; stderr: string }> {
        return execFileAsync(this.bin, args, { timeout: this.cliTimeoutMs });
    }

    /**
     * Resolve the host:port the injected server is listening on for the given
     * UDID. Tries `~/.loupe/runtimes` (documented JSON map) first, falls back
     * to parsing `loupe current --udid <udid>` stdout.
     */
    private async resolveRuntime(udid: string): Promise<RuntimeEntry | null> {
        const fromFile = this.readRuntimesFile(udid);
        if (fromFile) return fromFile;
        return this.readRuntimeFromCli(udid);
    }

    private readRuntimesFile(udid: string): RuntimeEntry | null {
        const file = path.join(os.homedir(), '.loupe', 'runtimes');
        let raw: string;
        try {
            raw = fsSync.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
        if (!parsed || typeof parsed !== 'object') return null;
        const entry = (parsed as Record<string, unknown>)[udid];
        if (!entry || typeof entry !== 'object') return null;
        const obj = entry as Record<string, unknown>;
        const port = typeof obj.port === 'number' ? obj.port : undefined;
        const bundleId = typeof obj.bundleId === 'string' ? obj.bundleId : '';
        const host = typeof obj.host === 'string' ? obj.host : undefined;
        if (!port) return null;
        return { port, bundleId, host };
    }

    private async readRuntimeFromCli(udid: string): Promise<RuntimeEntry | null> {
        let stdout: string;
        try {
            const res = await this.runLoupe(['current', '--udid', udid]);
            stdout = res.stdout;
        } catch {
            return null;
        }
        // Match either JSON-style ("port": 51234) or KV-style (port: 51234 / port=51234).
        const portMatch = stdout.match(/"?port"?\s*[:=]\s*(\d+)/i);
        const bundleMatch = stdout.match(/"?bundleId"?\s*[:=]\s*"?([^"\s,}]+)"?/i);
        const hostMatch = stdout.match(/"?host"?\s*[:=]\s*"?([^"\s,}]+)"?/i);
        if (!portMatch) return null;
        return {
            port: parseInt(portMatch[1], 10),
            bundleId: bundleMatch?.[1] ?? '',
            host: hostMatch?.[1],
        };
    }
}
