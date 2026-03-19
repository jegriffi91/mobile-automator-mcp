/**
 * ProxymanWrapper — Interface to Proxyman via `proxyman-cli` HAR export.
 *
 * Uses `proxyman-cli export-log` with domain filtering to avoid noisy traffic.
 * HAR entries are mapped to our unified NetworkEvent model.
 *
 * CLI resolution order:
 *   1. `PROXYMAN_CLI_PATH` env var (explicit override)
 *   2. Canonical app bundle: `/Applications/Proxyman.app/Contents/MacOS/proxyman-cli`
 *   3. `which proxyman-cli` (PATH lookup)
 *   4. `which proxyman` (common symlink name)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import type { NetworkEvent } from '../types.js';

const execFileAsync = promisify(execFile);

/** Canonical path inside the Proxyman.app bundle */
const CANONICAL_CLI_PATH = '/Applications/Proxyman.app/Contents/MacOS/proxyman-cli';

// ── CLI Resolution ──

/**
 * Cached resolved path:
 *   undefined = not yet resolved
 *   string = resolved successfully
 *   null = resolution failed (negative cache — all candidates exhausted)
 */
let resolvedCliPath: string | null | undefined;

/** Cached error message from failed resolution (used with negative cache) */
let resolvedCliError: string | undefined;

/**
 * Check whether a file exists and is executable.
 * Returns true if the path is valid and executable, false otherwise.
 */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `which <name>` and return the resolved path, or undefined if not found.
 */
async function whichBinary(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', [name]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Proxyman CLI binary path using a multi-step cascade.
 *
 * Resolution order:
 *   1. `PROXYMAN_CLI_PATH` env var
 *   2. Canonical app bundle path
 *   3. `which proxyman-cli`
 *   4. `which proxyman`
 *
 * Each candidate is verified as an executable file before being accepted.
 * The result is cached after first successful resolution.
 *
 * @throws Error with structured diagnostics listing all candidates tried
 */
export async function resolveCliPath(): Promise<string> {
  if (resolvedCliPath) return resolvedCliPath;
  if (resolvedCliPath === null) {
    throw new Error(resolvedCliError ?? 'Proxyman CLI not found (cached negative result)');
  }

  const candidates: Array<{ source: string; path: string | undefined; reason?: string }> = [];

  // 1. Env var override
  const envPath = process.env.PROXYMAN_CLI_PATH;
  if (envPath) {
    if (await isExecutable(envPath)) {
      resolvedCliPath = envPath;
      console.error(`[ProxymanWrapper] CLI resolved via PROXYMAN_CLI_PATH: ${envPath}`);
      return envPath;
    }
    const exists = await fs.access(envPath).then(() => true).catch(() => false);
    candidates.push({
      source: 'PROXYMAN_CLI_PATH env var',
      path: envPath,
      reason: exists ? 'exists but not executable' : 'file not found',
    });
  }

  // 2. Canonical app bundle path
  if (await isExecutable(CANONICAL_CLI_PATH)) {
    resolvedCliPath = CANONICAL_CLI_PATH;
    console.error(`[ProxymanWrapper] CLI resolved via canonical path: ${CANONICAL_CLI_PATH}`);
    return CANONICAL_CLI_PATH;
  }
  {
    const exists = await fs.access(CANONICAL_CLI_PATH).then(() => true).catch(() => false);
    candidates.push({
      source: 'canonical app bundle',
      path: CANONICAL_CLI_PATH,
      reason: exists ? 'exists but not executable' : 'file not found',
    });
  }

  // 3. which proxyman-cli
  const whichCli = await whichBinary('proxyman-cli');
  if (whichCli && (await isExecutable(whichCli))) {
    resolvedCliPath = whichCli;
    console.error(`[ProxymanWrapper] CLI resolved via PATH (proxyman-cli): ${whichCli}`);
    return whichCli;
  }
  candidates.push({
    source: 'which proxyman-cli',
    path: whichCli,
    reason: whichCli ? 'found but not executable' : 'not in PATH',
  });

  // 4. which proxyman (common symlink)
  const whichProxy = await whichBinary('proxyman');
  if (whichProxy && (await isExecutable(whichProxy))) {
    resolvedCliPath = whichProxy;
    console.error(`[ProxymanWrapper] CLI resolved via PATH (proxyman): ${whichProxy}`);
    return whichProxy;
  }
  candidates.push({
    source: 'which proxyman',
    path: whichProxy,
    reason: whichProxy ? 'found but not executable' : 'not in PATH',
  });

  // All candidates exhausted — cache the negative result
  const details = candidates
    .map((c) => `  • ${c.source}: ${c.path ?? '(none)'} — ${c.reason}`)
    .join('\n');
  resolvedCliError =
    `Proxyman CLI not found. Tried ${candidates.length} candidate(s):\n${details}\n\n` +
    'To fix: install Proxyman from https://proxyman.io or set PROXYMAN_CLI_PATH to the binary location.';
  resolvedCliPath = null;
  console.error(`[ProxymanWrapper] CLI resolution failed (cached). ${resolvedCliError}`);
  throw new Error(resolvedCliError);
}

/**
 * Reset the cached CLI path (for testing only).
 * @internal
 */
export function _resetResolvedCliPath(): void {
  resolvedCliPath = undefined;
  resolvedCliError = undefined;
}

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

// ── Error classification ──

/**
 * Classify a CLI exec error into a structured diagnostic message.
 */
function classifyCliError(error: unknown, cliBin: string): Error {
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException & { code?: string; stderr?: string };

    if (nodeError.code === 'ENOENT') {
      return new Error(
        `Proxyman CLI binary not found at resolved path '${cliBin}'. ` +
          'The file may have been moved or uninstalled since startup. ' +
          'Restart the MCP server to re-resolve, or set PROXYMAN_CLI_PATH.',
      );
    }
    if (nodeError.code === 'EACCES') {
      return new Error(
        `Proxyman CLI at '${cliBin}' is not executable (permission denied). ` +
          `Fix with: chmod +x '${cliBin}'`,
      );
    }
    if (nodeError.stderr) {
      return new Error(
        `Proxyman CLI at '${cliBin}' returned an error: ${nodeError.stderr.trim()}`,
      );
    }
    return new Error(`Proxyman CLI exec failed: ${error.message}`);
  }
  return new Error(`Proxyman CLI exec failed: ${String(error)}`);
}

export class ProxymanWrapper {
  private cliBinOverride?: string;

  /**
   * @param cliBin - Optional explicit CLI path. If omitted, uses the
   *   multi-step resolution cascade (env var → canonical path → PATH lookup).
   */
  constructor(cliBin?: string) {
    this.cliBinOverride = cliBin;
  }

  /**
   * Get the resolved CLI binary path.
   * Uses the override if provided, otherwise resolves via the cascade.
   */
  private async getCliBin(): Promise<string> {
    if (this.cliBinOverride) return this.cliBinOverride;
    return resolveCliPath();
  }

  /**
   * Export current Proxyman traffic as a HAR file.
   * Supports domain filtering to reduce noise (e.g., only capture `api.myapp.com`).
   */
  async exportHar(outputPath: string, domains?: string[]): Promise<string> {
    const cliBin = await this.getCliBin();
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
      await execFileAsync(cliBin, args);
      return outputPath;
    } catch (error: unknown) {
      throw classifyCliError(error, cliBin);
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
      console.error(
        `[ProxymanWrapper] snapshotBaseline: ${count} entries at baseline (domains: ${domains?.join(', ') ?? 'all'})`,
      );
      return count;
    } catch {
      // Proxyman may not be running or session is empty — baseline is 0
      console.error('[ProxymanWrapper] snapshotBaseline: no existing traffic, baseline = 0');
      return 0;
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Export Proxyman traffic scoped to entries captured AFTER the baseline.
   *
   * Preferred: pass `afterTimestamp` to filter by entry time (Proxyman does
   * not guarantee chronological ordering in the HAR array, so index-based
   * slicing is unreliable).  Falls back to `entries.slice(baselineCount)` if
   * no timestamp is given (legacy path).
   */
  async exportHarScoped(
    outputPath: string,
    baselineCount: number,
    domains?: string[],
    afterTimestamp?: string,
  ): Promise<string> {
    const har = await this.exportHarScopedParsed(baselineCount, domains, afterTimestamp);
    await fs.writeFile(outputPath, JSON.stringify(har, null, 2), 'utf-8');
    return outputPath;
  }

  /**
   * Export scoped Proxyman traffic and return the parsed HAR directly.
   * Avoids the write-then-read-then-delete roundtrip of `exportHarScoped`.
   */
  async exportHarScopedParsed(
    baselineCount: number,
    domains?: string[],
    afterTimestamp?: string,
  ): Promise<HarLog> {
    const tmpFile = path.join(os.tmpdir(), `proxyman-scoped-${randomUUID()}.har`);
    try {
      await this.exportHar(tmpFile, domains);
      const raw = await fs.readFile(tmpFile, 'utf-8');
      const har: HarLog = JSON.parse(raw);

      if (afterTimestamp) {
        const cutoff = new Date(afterTimestamp).getTime();
        har.log.entries = har.log.entries.filter(
          (e) => new Date(e.startedDateTime).getTime() >= cutoff,
        );
        console.error(
          `[ProxymanWrapper] exportHarScopedParsed: ${har.log.entries.length} entries after ${afterTimestamp}`,
        );
      } else {
        har.log.entries = har.log.entries.slice(baselineCount);
        console.error(
          `[ProxymanWrapper] exportHarScopedParsed: ${har.log.entries.length} new entries (baseline was ${baselineCount})`,
        );
      }

      return har;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[ProxymanWrapper] exportHarScopedParsed failed:', error);
      throw new Error(`Failed to export scoped HAR: ${msg}`);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
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
    domains?: string[],
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
    } catch (error: unknown) {
      // exportHar already classifies CLI errors — re-throw as-is
      console.error('[ProxymanWrapper] getTransactions failed:', error);
      throw error;
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
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
      const match = har.log.entries.filter((e) => e.request.url.includes(url)).pop();

      if (!match || !match.response.content?.text) {
        return null;
      }

      return JSON.parse(match.response.content.text);
    } catch (error: unknown) {
      // exportHar already classifies CLI errors — re-throw as-is
      console.error(`[ProxymanWrapper] getPayload(${url}) failed:`, error);
      return null;
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}

// ── Eager resolution at module load ──
// Fire-and-forget: pre-cache the CLI path so the first real call is instant.
// Errors are swallowed because the resolution result (positive or negative) is cached.
resolveCliPath().catch(() => {});
