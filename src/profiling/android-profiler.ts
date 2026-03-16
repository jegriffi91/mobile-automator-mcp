/**
 * AndroidProfiler — ProfilingDriver backed by `adb shell dumpsys`.
 *
 * Takes before/after snapshots of `dumpsys meminfo` and `dumpsys cpuinfo`
 * around the test execution window. Lightweight, no extra tooling required
 * beyond the Android SDK (adb).
 *
 * Future enhancement: add `perfetto` support for richer trace data.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProfilingDriver, ProfilingConfig, ProfilingMetrics } from './profiler.js';
import { parseDumpsysMeminfo, parseDumpsysCpuinfo, parseDumpsysMeminfoStandard } from './metric-parser.js';

const execFileAsync = promisify(execFile);

export class AndroidProfiler implements ProfilingDriver {
  private deviceId: string | null = null;
  private packageName: string | null = null;
  private config: ProfilingConfig | null = null;
  private startTime: number | null = null;
  private _isActive = false;

  get isActive(): boolean {
    return this._isActive;
  }

  async start(
    deviceId: string,
    appBundleIdOrPid: string,
    config: ProfilingConfig,
  ): Promise<void> {
    if (this._isActive) {
      throw new Error('AndroidProfiler is already active. Call stop() first.');
    }

    this.deviceId = deviceId;
    this.packageName = appBundleIdOrPid;
    this.config = config;
    this.startTime = Date.now();
    this._isActive = true;

    console.error(
      `[AndroidProfiler] profiling started for ${appBundleIdOrPid} on ${deviceId} (template: ${config.template})`,
    );
  }

  async stop(): Promise<ProfilingMetrics> {
    if (!this._isActive) {
      throw new Error('AndroidProfiler is not active. Call start() first.');
    }

    const durationMs = this.startTime ? Date.now() - this.startTime : 0;
    const deviceId = this.deviceId!;
    const packageName = this.packageName!;

    const metrics: ProfilingMetrics = {
      platform: 'android',
      profilingDurationMs: durationMs,
      warnings: [
        'Emulator profiling values may not reflect physical device performance.',
      ],
    };

    // Capture memory snapshot
    try {
      const memMetrics = await this.captureMeminfo(deviceId, packageName);
      if (memMetrics.memoryFootprintMb !== undefined) {
        metrics.memoryFootprintMb = memMetrics.memoryFootprintMb;
      }
      if (memMetrics.peakMemoryMb !== undefined) {
        metrics.peakMemoryMb = memMetrics.peakMemoryMb;
      }
    } catch (err) {
      console.error('[AndroidProfiler] meminfo capture failed:', err);
      metrics.warnings.push(
        `Memory capture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Capture CPU snapshot
    try {
      const cpuMetrics = await this.captureCpuinfo(deviceId, packageName);
      if (cpuMetrics.cpuUsagePercent !== undefined) {
        metrics.cpuUsagePercent = cpuMetrics.cpuUsagePercent;
      }
    } catch (err) {
      console.error('[AndroidProfiler] cpuinfo capture failed:', err);
      metrics.warnings.push(
        `CPU capture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this._isActive = false;
    console.error(
      `[AndroidProfiler] profiling stopped. Memory: ${metrics.memoryFootprintMb ?? 'N/A'} MB, CPU: ${metrics.cpuUsagePercent ?? 'N/A'}%`,
    );

    return metrics;
  }

  private async captureMeminfo(
    deviceId: string,
    packageName: string,
  ): Promise<Partial<ProfilingMetrics>> {
    // Try compact format first (-c flag)
    try {
      const { stdout } = await execFileAsync('adb', [
        '-s', deviceId,
        'shell', 'dumpsys', 'meminfo', '-c', packageName,
      ], { timeout: 10_000 });

      const result = parseDumpsysMeminfo(stdout, packageName);
      if (result.memoryFootprintMb !== undefined) {
        return result;
      }
    } catch {
      console.error('[AndroidProfiler] compact meminfo failed, trying standard format');
    }

    // Fallback to standard format
    const { stdout } = await execFileAsync('adb', [
      '-s', deviceId,
      'shell', 'dumpsys', 'meminfo', packageName,
    ], { timeout: 10_000 });

    return parseDumpsysMeminfoStandard(stdout, packageName);
  }

  private async captureCpuinfo(
    deviceId: string,
    packageName: string,
  ): Promise<Partial<ProfilingMetrics>> {
    const { stdout } = await execFileAsync('adb', [
      '-s', deviceId,
      'shell', 'dumpsys', 'cpuinfo',
    ], { timeout: 10_000 });

    return parseDumpsysCpuinfo(stdout, packageName);
  }
}
