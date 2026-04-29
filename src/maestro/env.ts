/**
 * Shared environment utilities for Maestro CLI invocations.
 *
 * Extracted from MaestroWrapper so that both the one-shot CLI wrapper
 * and the long-running MaestroDaemon can resolve the Maestro binary
 * and construct a correct exec environment (JAVA_HOME, PATH).
 */

import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Minimum Maestro CLI version supported by this project.
 *
 * Bumped to 2.5.0 (released 2026-04-27) after observing repeat XCTest driver
 * crashes against 2.3.0 in NTVP-558. We do NOT force a runtime upgrade —
 * older versions log a warning via `checkMaestroVersion` and the user is
 * pointed at the upgrade command.
 */
export const MIN_MAESTRO_VERSION = '2.5.0';

/**
 * Compare two semver-ish version strings (major.minor.patch). Pre-release
 * suffixes are ignored (e.g. "2.5.0-rc1" → "2.5.0"). Returns:
 *   -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
    const parse = (s: string): number[] =>
        s.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
    const av = parse(a);
    const bv = parse(b);
    const len = Math.max(av.length, bv.length, 3);
    for (let i = 0; i < len; i++) {
        const ai = av[i] ?? 0;
        const bi = bv[i] ?? 0;
        if (ai < bi) return -1;
        if (ai > bi) return 1;
    }
    return 0;
}

/**
 * Extract the version string from a `maestro --version` invocation. Output
 * varies across releases ("1.40.3", "Maestro CLI 2.5.0", "cli-2.5.0") so
 * the regex tolerates a leading prefix.
 */
export function parseMaestroVersion(stdout: string): string | null {
    const m = stdout.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
}

/**
 * Soft version check. Logs a warning (NOT an error) when the installed
 * Maestro is older than `MIN_MAESTRO_VERSION`. Pure function over the raw
 * `--version` stdout so callers can pipe in either the live result or a
 * cached probe.
 */
export function checkMaestroVersion(versionStdout: string): {
    version: string | null;
    ok: boolean;
    warning?: string;
} {
    const version = parseMaestroVersion(versionStdout);
    if (!version) {
        return {
            version: null,
            ok: false,
            warning:
                `Could not parse Maestro version from \`maestro --version\` output. ` +
                `This project recommends Maestro >= ${MIN_MAESTRO_VERSION}. ` +
                `Upgrade with: curl -Ls "https://get.maestro.mobile.dev" | bash`,
        };
    }
    if (compareVersions(version, MIN_MAESTRO_VERSION) < 0) {
        return {
            version,
            ok: false,
            warning:
                `Maestro ${version} detected; this project recommends >= ${MIN_MAESTRO_VERSION}. ` +
                `Older versions exhibit XCTest driver flakiness on iOS (port 22087). ` +
                `Upgrade with: curl -Ls "https://get.maestro.mobile.dev" | bash`,
        };
    }
    return { version, ok: true };
}

/**
 * Resolve the Maestro binary path from common install locations.
 * Returns the first executable candidate, or falls back to bare 'maestro' (PATH lookup).
 */
export function resolveMaestroBin(overridePath?: string): string {
  if (overridePath) return overridePath;

  const home = os.homedir();
  const candidates = [
    path.join(home, '.maestro', 'bin', 'maestro'),
    '/usr/local/bin/maestro',
    '/opt/homebrew/bin/maestro',
    'maestro', // fallback to PATH
  ];

  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      /* continue */
    }
  }

  return candidates[candidates.length - 1]; // bare 'maestro'
}

/**
 * Build an environment map that ensures Java and Maestro are on the PATH.
 *
 * Resolution order for JAVA_HOME:
 *   1. process.env.JAVA_HOME (set by user or MCP client config)
 *   2. Homebrew openjdk@17
 *   3. Homebrew openjdk (latest)
 */
export function getExecEnv(): Record<string, string> {
  const home = os.homedir();
  const extraPaths = [
    '/opt/homebrew/opt/openjdk@17/bin',
    '/opt/homebrew/opt/openjdk/bin',
    path.join(home, '.maestro', 'bin'),
    '/opt/homebrew/bin',
  ];
  const currentPath = process.env['PATH'] || '/usr/bin:/bin';

  // Resolve JAVA_HOME: prefer env var, then probe installed openjdk versions
  let javaHome = process.env['JAVA_HOME'] || '';
  if (!javaHome) {
    const candidates = [
      '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
      '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    ];
    for (const c of candidates) {
      try {
        fsSync.accessSync(c);
        javaHome = c;
        break;
      } catch {
        /* continue */
      }
    }
  }

  // Resolve ANDROID_HOME for adb access
  const androidHome = process.env['ANDROID_HOME'] ||
    `${os.homedir()}/Library/Android/sdk`;

  return {
    ...(process.env as Record<string, string>),
    PATH: [...extraPaths, `${androidHome}/platform-tools`, currentPath].join(':'),
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    // Give the XCTest / Android driver enough time to install after uninstallDriver()
    MAESTRO_DRIVER_STARTUP_TIMEOUT: process.env['MAESTRO_DRIVER_STARTUP_TIMEOUT'] || '120000',
  };
}
