/**
 * LightweightIosProfiler — ProfilingDriver backed by `ps` process sampling.
 *
 * Samples CPU% and RSS memory from the host Mac's process table at a
 * configurable interval (default: 1s). This avoids the heavy xctrace
 * Instruments traces that can grow to GB+ for production apps.
 *
 * Handles Maestro's `launchApp` (which kills + relaunches the app) by
 * re-resolving the PID on each sample via `simctl spawn ... launchctl list`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProfilingDriver, ProfilingConfig, ProfilingMetrics } from './profiler.js';
import { aggregateSamples, type ProfileSample } from './metric-parser.js';

const execFileAsync = promisify(execFile);

/** Default sampling interval in milliseconds */
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;

export class LightweightIosProfiler implements ProfilingDriver {
  private deviceId: string | null = null;
  private bundleId: string | null = null;
  private config: ProfilingConfig | null = null;
  private startTime: number | null = null;
  private samples: ProfileSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private _isActive = false;
  private lastKnownPid: string | null = null;

  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Resolve the PID for a running app on the simulator.
   * Returns null if the app isn't running (instead of throwing).
   */
  private async resolvePid(deviceId: string, bundleId: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('xcrun', [
        'simctl', 'spawn', deviceId, 'launchctl', 'list',
      ], { timeout: 5_000 });

      for (const line of stdout.split('\n')) {
        if (line.includes(bundleId)) {
          const pid = line.split('\t')[0]?.trim();
          if (pid && /^\d+$/.test(pid) && pid !== '-') {
            return pid;
          }
        }
      }
    } catch {
      // simctl not available or device not found
    }
    return null;
  }

  /**
   * Sample CPU% and RSS from `ps` for the given PID.
   * Returns null if the process is gone (will trigger re-resolution).
   */
  private async sampleProcess(pid: string): Promise<ProfileSample | null> {
    try {
      const { stdout } = await execFileAsync('ps', [
        '-p', pid, '-o', '%cpu=,rss=',
      ], { timeout: 3_000 });

      const trimmed = stdout.trim();
      if (!trimmed) return null;

      // Output format: " 12.3 123456" (cpu% and rss in KB)
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) return null;

      const cpu = parseFloat(parts[0]);
      const rssKb = parseInt(parts[1], 10);

      if (isNaN(cpu) || isNaN(rssKb)) return null;

      return {
        timestamp: Date.now(),
        cpuPercent: cpu,
        memoryRssKb: rssKb,
      };
    } catch {
      // Process is gone
      return null;
    }
  }

  async start(
    deviceId: string,
    appBundleIdOrPid: string,
    config: ProfilingConfig,
  ): Promise<void> {
    if (this._isActive) {
      throw new Error('LightweightIosProfiler is already active. Call stop() first.');
    }

    this.deviceId = deviceId;
    this.bundleId = appBundleIdOrPid;
    this.config = config;
    this.startTime = Date.now();
    this.samples = [];
    this._isActive = true;

    // Try to resolve the initial PID
    if (/^\d+$/.test(appBundleIdOrPid)) {
      this.lastKnownPid = appBundleIdOrPid;
    } else {
      this.lastKnownPid = await this.resolvePid(deviceId, appBundleIdOrPid);
    }

    if (this.lastKnownPid) {
      console.error(
        `[LightweightIosProfiler] started — PID ${this.lastKnownPid}, sampling every ${DEFAULT_SAMPLE_INTERVAL_MS}ms`,
      );
    } else {
      console.error(
        `[LightweightIosProfiler] started — app not running yet, will resolve PID on first sample`,
      );
    }

    // Start the sampling loop
    this.timer = setInterval(() => {
      void this.collectSample();
    }, DEFAULT_SAMPLE_INTERVAL_MS);

    // Collect an immediate first sample
    await this.collectSample();
  }

  private async collectSample(): Promise<void> {
    if (!this._isActive || !this.deviceId || !this.bundleId) return;

    // If we have a PID, try to sample it
    if (this.lastKnownPid) {
      const sample = await this.sampleProcess(this.lastKnownPid);
      if (sample) {
        this.samples.push(sample);
        return;
      }
      // PID is gone — app was relaunched
      console.error(
        `[LightweightIosProfiler] PID ${this.lastKnownPid} gone, re-resolving...`,
      );
    }

    // Re-resolve PID (app was relaunched by Maestro, or first sample)
    this.lastKnownPid = await this.resolvePid(this.deviceId, this.bundleId);
    if (this.lastKnownPid) {
      console.error(
        `[LightweightIosProfiler] re-resolved PID → ${this.lastKnownPid}`,
      );
      const sample = await this.sampleProcess(this.lastKnownPid);
      if (sample) {
        this.samples.push(sample);
      }
    }
  }

  async stop(): Promise<ProfilingMetrics> {
    if (!this._isActive) {
      throw new Error('LightweightIosProfiler is not active. Call start() first.');
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
      `[LightweightIosProfiler] stopped — ${this.samples.length} samples over ${durationMs}ms`,
    );

    const aggregated = aggregateSamples(this.samples);

    const metrics: ProfilingMetrics = {
      platform: 'ios',
      profilingDurationMs: durationMs,
      cpuUsagePercent: aggregated.avgCpuPercent,
      peakMemoryMb: aggregated.peakMemoryMb,
      memoryFootprintMb: aggregated.finalMemoryMb,
      sampleCount: this.samples.length,
      warnings: [
        'Simulator profiling values may deviate ~30% from physical device measurements.',
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
