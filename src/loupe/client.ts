/**
 * LoupeClient — wraps the `loupe` CLI and the in-process `LoupeServer` HTTP API.
 *
 * Loupe (heoblitz/Loupe) injects a dylib into the iOS Simulator app process at
 * `loupe start --bundle-id ... --device <udid>` time; the injected `LoupeServer`
 * then exposes an HTTP API on a loopback port for that UDID. This client
 * resolves the `udid → port` mapping (via `loupe runtimes` / `loupe current` /
 * `~/.loupe/runtimes`) and talks plain JSON over `fetch` for hierarchy /
 * observation queries, plus the CLI for HID-style actions (tap/swipe/type).
 *
 * CLI flag conventions match upstream Loupe (verified against the README):
 *   • `loupe start --bundle-id <id> --device <udid>`
 *   • `loupe tap --udid <udid> { --test-id <id> | --ref <ref> | --x <n> --y <n> }`
 *   • `loupe swipe --udid <udid> --from <x>,<y> --to <x>,<y>`
 *   • `loupe type <text> --udid <udid>`
 *   • `loupe runtimes`, `loupe current` (no args)
 *
 * Loupe has no `stop`, `scroll`, or `back` subcommand — those are composed
 * upstream by the LoupeDriver from swipes.
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
     * Spawn `loupe start --bundle-id <id> --device <udid>` and wait for the
     * injected server to come up. Returns when GET /runtime responds 200, or
     * throws on timeout.
     */
    async start(udid: string, bundleId: string, timeoutMs = 15_000): Promise<void> {
        await this.runLoupe(['start', '--bundle-id', bundleId, '--device', udid]);
        this.udid = udid;
        this.bundleId = bundleId;

        const deadline = Date.now() + timeoutMs;
        let lastErr: unknown;
        while (Date.now() < deadline) {
            try {
                const entry = await this.resolveRuntime(udid, bundleId);
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

    /**
     * Clear local injection state. Loupe has no `stop` subcommand — the
     * injected runtime lives with the simulator app process; killing the app
     * (via `xcrun simctl` or a fresh `loupe start` for a different bundle)
     * is the de-facto teardown. This method only resets what the client knows.
     */
    async stop(): Promise<void> {
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
        await this.runLoupe([
            'tap',
            '--udid', this.udid!,
            '--x', String(Math.round(x)),
            '--y', String(Math.round(y)),
        ]);
    }

    async typeText(text: string): Promise<void> {
        this.requireInjected();
        // `loupe type <text> --udid <udid>` — positional text argument.
        await this.runLoupe(['type', text, '--udid', this.udid!]);
    }

    /**
     * Coordinate-based swipe gesture. Loupe accepts `--from x,y --to x,y` —
     * a single comma-separated string per endpoint.
     */
    async swipe(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
        this.requireInjected();
        const from = `${Math.round(fromX)},${Math.round(fromY)}`;
        const to = `${Math.round(toX)},${Math.round(toY)}`;
        await this.runLoupe(['swipe', '--udid', this.udid!, '--from', from, '--to', to]);
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
     * UDID. Tries (in order):
     *   1. `loupe runtimes` — lists all injected runtimes
     *   2. `loupe current` — the most recently started runtime
     *   3. `~/.loupe/runtimes` — undocumented JSON map (defensive fallback)
     */
    private async resolveRuntime(udid: string, bundleId: string): Promise<RuntimeEntry | null> {
        const fromList = await this.readRuntimeFromList(udid, bundleId);
        if (fromList) return fromList;
        const fromCurrent = await this.readRuntimeFromCurrent(bundleId);
        if (fromCurrent) return fromCurrent;
        return this.readRuntimesFile(udid);
    }

    private async readRuntimeFromList(udid: string, bundleId: string): Promise<RuntimeEntry | null> {
        let stdout: string;
        try {
            const res = await this.runLoupe(['runtimes']);
            stdout = res.stdout;
        } catch {
            return null;
        }
        return findRuntimeInText(stdout, udid, bundleId);
    }

    private async readRuntimeFromCurrent(bundleId: string): Promise<RuntimeEntry | null> {
        let stdout: string;
        try {
            const res = await this.runLoupe(['current']);
            stdout = res.stdout;
        } catch {
            return null;
        }
        // `loupe current` shows only the active runtime, so it's enough to
        // confirm the bundle id matches and extract the port.
        return findRuntimeInText(stdout, undefined, bundleId);
    }

    private readRuntimesFile(udid: string): RuntimeEntry | null {
        const file = path.join(os.homedir(), '.loupe', 'runtimes');
        let raw: string;
        try {
            raw = fsSync.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                const entry = (parsed as Record<string, unknown>)[udid];
                if (entry && typeof entry === 'object') {
                    const obj = entry as Record<string, unknown>;
                    const port = typeof obj.port === 'number' ? obj.port : undefined;
                    const bundleId = typeof obj.bundleId === 'string' ? obj.bundleId : '';
                    const host = typeof obj.host === 'string' ? obj.host : undefined;
                    if (port) return { port, bundleId, host };
                }
            }
        } catch {
            /* not JSON — try regex */
        }
        return findRuntimeInText(raw, udid, undefined);
    }
}

/**
 * Best-effort runtime extraction from arbitrary text output. Handles both
 * JSON-style ("port": 51234) and KV-style (port: 51234 / port=51234). When
 * `udid` is provided, scans line-by-line and only matches a port that appears
 * near the udid; otherwise returns the first port found.
 */
function findRuntimeInText(
    text: string,
    udid: string | undefined,
    bundleId: string | undefined,
): RuntimeEntry | null {
    const lines = text.split(/\r?\n/);
    if (udid) {
        // Look for the udid, then take port/bundleId from a small window of
        // nearby lines (handles multi-line tabular and JSON-ish output).
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].includes(udid)) continue;
            const window = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join('\n');
            const entry = extractEntry(window);
            if (entry) return entry;
        }
        return null;
    }
    if (bundleId) {
        // Try to find a window matching the bundle id.
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].includes(bundleId)) continue;
            const window = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join('\n');
            const entry = extractEntry(window);
            if (entry) return entry;
        }
    }
    return extractEntry(text);
}

function extractEntry(text: string): RuntimeEntry | null {
    const portMatch = text.match(/"?port"?\s*[:=]\s*(\d+)/i);
    if (!portMatch) return null;
    const bundleMatch = text.match(/"?bundle[-_]?id"?\s*[:=]\s*"?([^"\s,}]+)"?/i);
    const hostMatch = text.match(/"?host"?\s*[:=]\s*"?([^"\s,}]+)"?/i);
    return {
        port: parseInt(portMatch[1], 10),
        bundleId: bundleMatch?.[1] ?? '',
        host: hostMatch?.[1],
    };
}
