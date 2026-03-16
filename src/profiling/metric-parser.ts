/**
 * Metric parser — Pure-logic module for extracting ProfilingMetrics from
 * platform-specific CLI output.
 *
 * This is the testable core of the profiling module. CLI wrappers delegate
 * raw output parsing here.
 */

import type { ProfilingMetrics } from './profiler.js';

/**
 * Parse `xcrun xctrace export` XML output to extract CPU profiling metrics.
 *
 * xctrace uses an id/ref deduplication pattern in its XML:
 *   - First occurrence:  `<weight id="9" fmt="1.00 ms">1000000</weight>`
 *   - Subsequent refs:   `<weight ref="9"/>`
 *
 * We build a lookup table from id → nanosecond value, count all occurrences
 * (both definitions and references), and sum to get total CPU weight.
 *
 * @param xml - Raw XML string from `xctrace export --xpath ...`
 * @returns Partial metrics with CPU-related fields populated
 */
export function parseXctraceTimeProfle(xml: string): Partial<ProfilingMetrics> {
  const metrics: Partial<ProfilingMetrics> = { platform: 'ios' };

  // Step 1: Build id → value lookup from definitions
  // Format: <weight id="9" fmt="1.00 ms">1000000</weight>
  const definitionRegex = /<weight\s+id="([^"]+)"[^>]*>(\d+)<\/weight>/g;
  const weightLookup = new Map<string, number>();
  let defMatch: RegExpExecArray | null;
  while ((defMatch = definitionRegex.exec(xml)) !== null) {
    weightLookup.set(defMatch[1], parseInt(defMatch[2], 10));
  }

  // Step 2: Count all weight occurrences (definitions + references)
  let totalWeightNs = 0;

  // Count definitions (each is also a sample)
  for (const value of weightLookup.values()) {
    totalWeightNs += value;
  }

  // Count references: <weight ref="9"/>
  const refRegex = /<weight\s+ref="([^"]+)"\/>/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refRegex.exec(xml)) !== null) {
    const value = weightLookup.get(refMatch[1]);
    if (value !== undefined) {
      totalWeightNs += value;
    }
  }

  // Also handle legacy inline format: <weight>12345</weight> (no id/ref)
  const inlineRegex = /<weight>(\d+)<\/weight>/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRegex.exec(xml)) !== null) {
    totalWeightNs += parseInt(inlineMatch[1], 10);
  }

  if (totalWeightNs > 0) {
    // Convert nanoseconds → microseconds for the caller's CPU % calculation
    // Caller computes: (weightMicros / (wallClockMs * 1000)) * 100
    metrics.cpuUsagePercent = Math.round(totalWeightNs / 1000);
  }

  return metrics;
}

/**
 * Parse `xcrun xctrace export` XML output to extract memory allocation metrics.
 *
 * @param xml - Raw XML string from `xctrace export --xpath ...` for allocations
 * @returns Partial metrics with memory-related fields populated
 */
export function parseXctraceAllocations(xml: string): Partial<ProfilingMetrics> {
  const metrics: Partial<ProfilingMetrics> = { platform: 'ios' };

  // Look for total-bytes or size attributes in the allocations schema
  // Format varies but typically: <total-bytes>12345678</total-bytes>
  const totalBytesMatch = xml.match(/<total-bytes>(\d+)<\/total-bytes>/);
  if (totalBytesMatch) {
    const bytes = parseInt(totalBytesMatch[1], 10);
    metrics.peakMemoryMb = Math.round((bytes / (1024 * 1024)) * 100) / 100;
  }

  // Alternative: look for size attributes
  const sizeMatches = xml.match(/<size>(\d+)<\/size>/g);
  if (sizeMatches && sizeMatches.length > 0 && !metrics.peakMemoryMb) {
    let maxSize = 0;
    for (const match of sizeMatches) {
      const value = match.match(/(\d+)/);
      if (value) {
        maxSize = Math.max(maxSize, parseInt(value[1], 10));
      }
    }
    if (maxSize > 0) {
      metrics.peakMemoryMb = Math.round((maxSize / (1024 * 1024)) * 100) / 100;
    }
  }

  return metrics;
}

/**
 * Parse `adb shell dumpsys meminfo -c <package>` compact output.
 *
 * Compact format outputs CSV-like rows:
 *   proc,<type>,<name>,<pid>
 *   <category>,<pss>,<private_dirty>,<private_clean>,<swapped_dirty>,<shared_dirty>,<shared_clean>,<rss>
 *   ...
 *   TOTAL,<total_pss>,<total_private_dirty>,<total_private_clean>,<total_swapped_dirty>,<total_shared_dirty>,<total_shared_clean>,<total_rss>
 *
 * @param output - Raw compact dumpsys meminfo output
 * @param _packageName - Package name (unused, kept for API consistency)
 * @returns Partial metrics with memory fields populated
 */
export function parseDumpsysMeminfo(
  output: string,
  _packageName: string,
): Partial<ProfilingMetrics> {
  const metrics: Partial<ProfilingMetrics> = { platform: 'android' };

  const lines = output.split('\n');

  for (const line of lines) {
    const parts = line.trim().split(',');

    // TOTAL line in compact format: TOTAL,<pss>,<private_dirty>,<private_clean>,...
    if (parts[0] === 'TOTAL' && parts.length >= 2) {
      const totalPssKb = parseInt(parts[1], 10);
      if (!isNaN(totalPssKb) && totalPssKb > 0) {
        metrics.memoryFootprintMb = Math.round((totalPssKb / 1024) * 100) / 100;
      }
      break;
    }
  }

  // Extract Native Heap and Dalvik Heap for peak memory approximation
  let nativeHeapKb = 0;
  let dalvikHeapKb = 0;

  for (const line of lines) {
    const parts = line.trim().split(',');
    if (parts[0] === 'Native Heap' && parts.length >= 2) {
      const pss = parseInt(parts[1], 10);
      if (!isNaN(pss)) nativeHeapKb = pss;
    }
    if (parts[0] === 'Dalvik Heap' && parts.length >= 2) {
      const pss = parseInt(parts[1], 10);
      if (!isNaN(pss)) dalvikHeapKb = pss;
    }
  }

  if (nativeHeapKb + dalvikHeapKb > 0) {
    metrics.peakMemoryMb =
      Math.round(((nativeHeapKb + dalvikHeapKb) / 1024) * 100) / 100;
  }

  return metrics;
}

/**
 * Parse `adb shell dumpsys cpuinfo` output to extract CPU usage for a package.
 *
 * Output format (one line per process):
 *   12.3% 12345/com.example.app: 8.1% user + 4.2% kernel
 *
 * @param output - Raw dumpsys cpuinfo output
 * @param packageName - Package name to search for
 * @returns Partial metrics with CPU usage populated
 */
export function parseDumpsysCpuinfo(
  output: string,
  packageName: string,
): Partial<ProfilingMetrics> {
  const metrics: Partial<ProfilingMetrics> = { platform: 'android' };

  const lines = output.split('\n');
  for (const line of lines) {
    if (line.includes(packageName)) {
      // Match pattern: "12.3% 12345/com.example.app: ..."
      const cpuMatch = line.match(/^\s*([\d.]+)%/);
      if (cpuMatch) {
        metrics.cpuUsagePercent = parseFloat(cpuMatch[1]);
      }
      break;
    }
  }

  return metrics;
}

/**
 * Parse non-compact `dumpsys meminfo` output (fallback when -c flag isn't supported).
 *
 * Standard format has a TOTAL row:
 *   TOTAL:    123456         ...
 *   or
 *   TOTAL    123456    12345    1234    ...
 *
 * @param output - Raw standard-format dumpsys meminfo output
 * @param _packageName - Package name (unused)
 * @returns Partial metrics with memory fields populated
 */
export function parseDumpsysMeminfoStandard(
  output: string,
  _packageName: string,
): Partial<ProfilingMetrics> {
  const metrics: Partial<ProfilingMetrics> = { platform: 'android' };

  const lines = output.split('\n');
  for (const line of lines) {
    // Match "TOTAL:" or "TOTAL " followed by whitespace and a number
    const totalMatch = line.match(/^\s*TOTAL:?\s+(\d+)/);
    if (totalMatch) {
      const totalPssKb = parseInt(totalMatch[1], 10);
      if (!isNaN(totalPssKb) && totalPssKb > 0) {
        metrics.memoryFootprintMb = Math.round((totalPssKb / 1024) * 100) / 100;
      }
      break;
    }
  }

  return metrics;
}

// ── Lightweight profiling ──

/**
 * A single CPU/memory sample from `ps` process sampling.
 */
export interface ProfileSample {
  timestamp: number;
  cpuPercent: number;
  memoryRssKb: number;
}

/**
 * Aggregated result from processing an array of ProfileSamples.
 */
export interface AggregatedMetrics {
  avgCpuPercent?: number;
  peakCpuPercent?: number;
  peakMemoryMb?: number;
  finalMemoryMb?: number;
}

/**
 * Aggregate an array of ProfileSamples into summary metrics.
 *
 * Computes average/peak CPU% and peak/final memory from the raw samples.
 * Returns empty metrics for an empty array (caller should add a warning).
 *
 * @param samples - Array of CPU/memory snapshots from `ps`
 * @returns Aggregated metrics
 */
export function aggregateSamples(samples: ProfileSample[]): AggregatedMetrics {
  if (samples.length === 0) {
    return {};
  }

  let totalCpu = 0;
  let peakCpu = 0;
  let peakRssKb = 0;

  for (const sample of samples) {
    totalCpu += sample.cpuPercent;
    peakCpu = Math.max(peakCpu, sample.cpuPercent);
    peakRssKb = Math.max(peakRssKb, sample.memoryRssKb);
  }

  const lastSample = samples[samples.length - 1];
  const avgCpu = Math.round((totalCpu / samples.length) * 100) / 100;

  return {
    avgCpuPercent: avgCpu,
    peakCpuPercent: Math.round(peakCpu * 100) / 100,
    peakMemoryMb: Math.round((peakRssKb / 1024) * 100) / 100,
    finalMemoryMb: Math.round((lastSample.memoryRssKb / 1024) * 100) / 100,
  };
}

// ── App Launch ──

/**
 * Parse the xctrace TOC XML to extract the recording duration.
 *
 * The TOC contains a `<duration>` element with the recording time in seconds:
 *   `<duration>2.345678</duration>`
 *
 * For App Launch template, this represents the time from process start
 * to the app becoming interactive.
 *
 * @param tocXml - Raw XML string from `xctrace export --toc`
 * @returns Launch time in milliseconds, or undefined if not found
 */
export function parseXctraceLaunchTime(tocXml: string): number | undefined {
  const match = tocXml.match(/<duration>([\d.]+)<\/duration>/);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  }
  return undefined;
}

// ── Android /proc Parsers ──

/**
 * Parsed result from `/proc/<pid>/stat`.
 */
export interface ProcStatResult {
  pid: number;
  /** User-mode CPU ticks (field 14, 1-indexed) */
  utime: number;
  /** Kernel-mode CPU ticks (field 15, 1-indexed) */
  stime: number;
}

/**
 * Parse a single line from `/proc/<pid>/stat` to extract CPU tick counters.
 *
 * The stat file has a tricky format because the comm field (field 2) is
 * enclosed in parentheses and may contain spaces. We find the last `)` to
 * skip past the comm field, then parse the remaining space-separated fields.
 *
 * Fields after comm (0-indexed from the token after `)`):
 *   0=state, 1=ppid, ..., 11=utime, 12=stime
 *
 * @param statLine - Single line from `/proc/<pid>/stat`
 * @returns Parsed PID, utime, stime, or null if unparseable
 */
export function parseProcStat(statLine: string): ProcStatResult | null {
  const trimmed = statLine.trim();
  if (!trimmed) return null;

  // Find the last ')' to skip the comm field (which may contain spaces)
  const closeParen = trimmed.lastIndexOf(')');
  if (closeParen === -1) return null;

  // Extract PID from before the first '('
  const openParen = trimmed.indexOf('(');
  if (openParen === -1) return null;
  const pid = parseInt(trimmed.substring(0, openParen).trim(), 10);
  if (isNaN(pid)) return null;

  // Fields after ')': state ppid pgrp session tty_nr tpgid flags
  //   minflt cminflt majflt cmajflt utime stime ...
  // Indices:         0     1    2       3       4     5      6
  //   7      8       9      10      11    12
  const afterComm = trimmed.substring(closeParen + 1).trim();
  const fields = afterComm.split(/\s+/);

  // We need fields[11] (utime) and fields[12] (stime)
  if (fields.length < 13) return null;

  const utime = parseInt(fields[11], 10);
  const stime = parseInt(fields[12], 10);

  if (isNaN(utime) || isNaN(stime)) return null;

  return { pid, utime, stime };
}

/**
 * Parse `/proc/<pid>/status` output to extract VmRSS (resident set size).
 *
 * The status file contains key-value pairs like:
 *   VmRSS:    12345 kB
 *
 * @param statusOutput - Full content of `/proc/<pid>/status`
 * @returns VmRSS in KB, or null if not found
 */
export function parseProcStatus(statusOutput: string): number | null {
  for (const line of statusOutput.split('\n')) {
    const match = line.match(/^VmRSS:\s+(\d+)\s+kB/i);
    if (match) {
      const kb = parseInt(match[1], 10);
      return isNaN(kb) ? null : kb;
    }
  }
  return null;
}

/**
 * Parse `adb shell am start -W` output to extract app launch time.
 *
 * Output format:
 *   Starting: Intent { ... }
 *   Status: ok
 *   LaunchState: COLD
 *   Activity: com.example.app/.MainActivity
 *   TotalTime: 1234
 *   WaitTime: 1256
 *   Complete
 *
 * @param output - Raw output from `am start -W`
 * @returns Launch time in milliseconds, or undefined if not found
 */
export function parseAmStartOutput(output: string): number | undefined {
  const match = output.match(/TotalTime:\s*(\d+)/);
  if (match) {
    const ms = parseInt(match[1], 10);
    return isNaN(ms) ? undefined : ms;
  }
  return undefined;
}
