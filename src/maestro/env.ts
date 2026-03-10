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

  return {
    ...(process.env as Record<string, string>),
    PATH: [...extraPaths, currentPath].join(':'),
    JAVA_HOME: javaHome,
  };
}
