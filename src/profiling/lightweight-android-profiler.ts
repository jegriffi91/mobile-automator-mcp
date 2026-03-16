/**
 * LightweightAndroidProfiler — ProfilingDriver backed by `/proc` sampling via `adb shell`.
 *
 * Samples CPU ticks from `/proc/<pid>/stat` and RSS memory from
 * `/proc/<pid>/status` at a configurable interval (default: 1s).
 * Computes CPU% from tick deltas between consecutive samples.
 *
 * Mirrors the iOS LightweightIosProfiler approach, giving continuous
 * time-series data instead of the single `dumpsys` snapshot.
 *
 * Handles Maestro's `launchApp` (which kills + relaunches the app) by
 * re-resolving the PID on each sample via `pidof`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProfilingDriver, ProfilingConfig, ProfilingMetrics } from './profiler.js';
import { aggregateSamples, parseProcStat, parseProcStatus, type ProfileSample } from './metric-parser.js';

const execFileAsync = promisify(execFile);

/** Default sampling interval in milliseconds */
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;

/** Standard clock tick rate on Linux/Android (CONFIG_HZ) */
const CLOCK_TICKS_PER_SECOND = 100;

interface CpuTickSnapshot {
  utime: number;
  stime: number;
  timestampMs: number;
}

export class LightweightAndroidProfiler implements ProfilingDriver {
  private deviceId: string | null = null;
  private packageName: string | null = null;
  private config: ProfilingConfig | null = null;
  private startTime: number | null = null;
  private samples: ProfileSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private _isActive = false;
  private lastKnownPid: string | null = null;
  private lastCpuSnapshot: CpuTickSnapshot | null = null;

  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Resolve the PID for a running app on the emulator.
   * Returns null if the app isn't running.
   */
  private async resolvePid(deviceId: string, packageName: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('adb', [
        '-s', deviceId, 'shell', 'pidof', packageName,
      ], { timeout: 5_000 });

      const pid = stdout.trim().split(/\s+/)[0];
      if (pid && /^\d+$/.test(pid)) {
        return pid;
      }
    } catch {
      // pidof not available or process not found
    }
    return null;
  }

  /**
   * Read `/proc/<pid>/stat` and `/proc/<pid>/status` to collect a CPU+memory sample.
   * CPU% is computed from tick deltas between consecutive calls.
   * Returns null if the process is gone.
   */
  private async sampleProcess(deviceId: string, pid: string): Promise<ProfileSample | null> {
    try {
      // Read both proc files in a single adb shell invocation for efficiency
      const { stdout } = await execFileAsync('adb', [
        '-s', deviceId, 'shell',
        `cat /proc/${pid}/stat /proc/${pid}/status`,
      ], { timeout: 5_000 });

      if (!stdout.trim()) return null;

      // First line is /proc/stat, rest is /proc/status
      const lines = stdout.split('\n');
      const statLine = lines[0];
      const statusOutput = lines.slice(1).join('\n');

      // Parse CPU ticks
      const procStat = parseProcStat(statLine);
      if (!procStat) return null;

      // Parse memory
      const vmRssKb = parseProcStatus(statusOutput);
      if (vmRssKb === null) return null;

      const now = Date.now();
      const currentSnapshot: CpuTickSnapshot = {
        utime: procStat.utime,
        stime: procStat.stime,
        timestampMs: now,
      };

      let cpuPercent = 0;
      if (this.lastCpuSnapshot) {
        const ticksDelta =
          (currentSnapshot.utime + currentSnapshot.stime) -
          (this.lastCpuSnapshot.utime + this.lastCpuSnapshot.stime);
        const timeDeltaMs = currentSnapshot.timestampMs - this.lastCpuSnapshot.timestampMs;

        if (timeDeltaMs > 0 && ticksDelta >= 0) {
          // Convert ticks to seconds, divide by elapsed seconds, multiply by 100
          const tickSeconds = ticksDelta / CLOCK_TICKS_PER_SECOND;
          const elapsedSeconds = timeDeltaMs / 1000;
          cpuPercent = Math.round((tickSeconds / elapsedSeconds) * 100 * 100) / 100;
        }
      }

      this.lastCpuSnapshot = currentSnapshot;

      return {
        timestamp: now,
        cpuPercent,
        memoryRssKb: vmRssKb,
      };
    } catch {
      // Process is gone or adb failure
      return null;
    }
  }

  async start(
    deviceId: string,
    appBundleIdOrPid: string,
    config: ProfilingConfig,
  ): Promise<void> {
    if (this._isActive) {
      throw new Error('LightweightAndroidProfiler is already active. Call stop() first.');
    }

    this.deviceId = deviceId;
    this.packageName = appBundleIdOrPid;
    this.config = config;
    this.startTime = Date.now();
    this.samples = [];
    this.lastCpuSnapshot = null;
    this._isActive = true;

    // Try to resolve the initial PID
    if (/^\d+$/.test(appBundleIdOrPid)) {
      this.lastKnownPid = appBundleIdOrPid;
    } else {
      this.lastKnownPid = await this.resolvePid(deviceId, appBundleIdOrPid);
    }

    if (this.lastKnownPid) {
      console.error(
        `[LightweightAndroidProfiler] started — PID ${this.lastKnownPid}, sampling every ${DEFAULT_SAMPLE_INTERVAL_MS}ms`,
      );
    } else {
      console.error(
        `[LightweightAndroidProfiler] started — app not running yet, will resolve PID on first sample`,
      );
    }

    // Start the sampling loop
    this.timer = setInterval(() => {
      void this.collectSample();
    }, DEFAULT_SAMPLE_INTERVAL_MS);

    // Collect an immediate first sample (establishes the CPU tick baseline)
    await this.collectSample();
  }

  private async collectSample(): Promise<void> {
    if (!this._isActive || !this.deviceId || !this.packageName) return;

    // If we have a PID, try to sample it
    if (this.lastKnownPid) {
      const sample = await this.sampleProcess(this.deviceId, this.lastKnownPid);
      if (sample) {
        this.samples.push(sample);
        return;
      }
      // PID is gone — app was relaunched
      console.error(
        `[LightweightAndroidProfiler] PID ${this.lastKnownPid} gone, re-resolving...`,
      );
      this.lastCpuSnapshot = null; // Reset tick baseline
    }

    // Re-resolve PID (app was relaunched by Maestro, or first sample)
    this.lastKnownPid = await this.resolvePid(this.deviceId, this.packageName);
    if (this.lastKnownPid) {
      console.error(
        `[LightweightAndroidProfiler] re-resolved PID → ${this.lastKnownPid}`,
      );
      const sample = await this.sampleProcess(this.deviceId, this.lastKnownPid);
      if (sample) {
        this.samples.push(sample);
      }
    }
  }

  async stop(): Promise<ProfilingMetrics> {
    if (!this._isActive) {
      throw new Error('LightweightAndroidProfiler is not active. Call start() first.');
    }

    // Stop the sampling loop
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Collect a final sample
    await this.collectSample();

    const durationMs = this.startTime ? Date.now() - this.startTime : 0;
    this._isActive = false;

    console.error(
      `[LightweightAndroidProfiler] stopped — ${this.samples.length} samples over ${durationMs}ms`,
    );

    const aggregated = aggregateSamples(this.samples);

    const metrics: ProfilingMetrics = {
      platform: 'android',
      profilingDurationMs: durationMs,
      cpuUsagePercent: aggregated.avgCpuPercent,
      peakMemoryMb: aggregated.peakMemoryMb,
      memoryFootprintMb: aggregated.finalMemoryMb,
      sampleCount: this.samples.length,
      warnings: [
        'Emulator profiling values may not reflect physical device performance.',
      ],
    };

    if (aggregated.peakCpuPercent !== undefined) {
      metrics.peakCpuPercent = aggregated.peakCpuPercent;
    }

    if (this.samples.length === 0) {
      metrics.warnings.push(
        'No profiling samples collected — the app may not have been running during the test.',
      );
    }

    // Clear samples to free memory
    this.samples = [];

    return metrics;
  }
}
