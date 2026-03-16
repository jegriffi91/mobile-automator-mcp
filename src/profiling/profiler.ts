/**
 * ProfilingDriver — Platform abstraction for simulator/emulator performance profiling.
 *
 * Implementations:
 *   • IosProfiler  — wraps `xcrun xctrace` for CPU/memory/launch profiling
 *   • AndroidProfiler — wraps `adb shell dumpsys` for memory/CPU snapshots
 *
 * Designed for use in `run_test` (Option C), but the interface supports
 * future integration into recording sessions (Option A) without changes.
 */

import type { MobilePlatform } from '../types.js';

// ── Profiling templates ──

export type ProfilingTemplate = 'time-profiler' | 'allocations' | 'app-launch' | 'memory-snapshot';

// ── Configuration ──

export interface ProfilingConfig {
  /** Which metrics to collect */
  template: ProfilingTemplate;
  /** Max profiling duration in seconds. Defaults to duration of the test. */
  timeLimitSeconds?: number;
  /** Directory for raw trace files. Defaults to os.tmpdir(). */
  outputDir?: string;
  /** Delete raw trace after extracting metrics (default: true) */
  cleanupTrace?: boolean;
}

// ── Metrics output ──

export interface ProfilingMetrics {
  platform: MobilePlatform;
  /** CPU usage percentage (0-100) during the profiling window */
  cpuUsagePercent?: number;
  /** Peak memory usage in MB */
  peakMemoryMb?: number;
  /** Total memory footprint in MB */
  memoryFootprintMb?: number;
  /** App launch time in ms (app-launch template only) */
  launchTimeMs?: number;
  /** Peak CPU usage percentage during profiling (0-100) */
  peakCpuPercent?: number;
  /** Number of profiling samples collected (lightweight mode) */
  sampleCount?: number;
  /** Total profiling duration in ms */
  profilingDurationMs: number;
  /** Path to the raw trace file for manual inspection */
  rawTracePath?: string;
  /** Informational warnings (e.g., simulator accuracy caveats) */
  warnings: string[];
}

// ── Driver interface ──

export interface ProfilingDriver {
  /** Start profiling in the background. Returns when profiling is active. */
  start(
    deviceId: string,
    appBundleIdOrPid: string,
    config: ProfilingConfig,
  ): Promise<void>;

  /** Stop profiling and return parsed metrics. */
  stop(): Promise<ProfilingMetrics>;

  /** Whether profiling is currently active */
  readonly isActive: boolean;
}
