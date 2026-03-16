/**
 * IosProfiler — ProfilingDriver backed by `xcrun xctrace`.
 *
 * Spawns xctrace as a background child process that runs in parallel with
 * the Maestro test. On stop(), sends SIGINT for graceful shutdown, then
 * exports and parses metrics from the resulting .trace file.
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import type { ProfilingDriver, ProfilingConfig, ProfilingMetrics } from './profiler.js';
import { parseXctraceTimeProfle, parseXctraceAllocations } from './metric-parser.js';

const execFileAsync = promisify(execFile);

/** Map our template names to Instruments template names */
const TEMPLATE_MAP: Record<string, string> = {
  'time-profiler': 'Time Profiler',
  'allocations': 'Allocations',
  'app-launch': 'App Launch',
  'memory-snapshot': 'Allocations', // Allocations is the closest built-in template
};

export class IosProfiler implements ProfilingDriver {
  private process: ReturnType<typeof spawn> | null = null;
  private tracePath: string | null = null;
  private config: ProfilingConfig | null = null;
  private startTime: number | null = null;
  private _isActive = false;

  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Resolve the PID for a running app on the simulator.
   * Uses `xcrun simctl spawn <deviceId> launchctl list` and looks for
   * a UIKitApplication entry matching the bundle ID.
   */
  private async resolvePid(deviceId: string, bundleId: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('xcrun', [
        'simctl', 'spawn', deviceId, 'launchctl', 'list',
      ], { timeout: 10_000 });

      // Lines look like: "16823\t0\tUIKitApplication:io.appcision.project-doombot[389e][rb-legacy]"
      for (const line of stdout.split('\n')) {
        if (line.includes(bundleId)) {
          const pid = line.split('\t')[0]?.trim();
          if (pid && /^\d+$/.test(pid) && pid !== '-') {
            console.error(`[IosProfiler] resolved bundle ID '${bundleId}' → PID ${pid}`);
            return pid;
          }
        }
      }
      throw new Error(`No running process found for bundle ID: ${bundleId}`);
    } catch (err) {
      throw new Error(
        `Failed to resolve PID for '${bundleId}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async start(
    deviceId: string,
    appBundleIdOrPid: string,
    config: ProfilingConfig,
  ): Promise<void> {
    if (this._isActive) {
      throw new Error('IosProfiler is already active. Call stop() first.');
    }

    this.config = config;
    const outputDir = config.outputDir ?? os.tmpdir();
    this.tracePath = path.join(outputDir, `profiling-${randomUUID()}.trace`);

    // xctrace --attach requires a numeric PID, not a bundle ID.
    // If the caller passed a bundle ID, resolve it to a PID.
    let attachTarget = appBundleIdOrPid;
    if (!/^\d+$/.test(appBundleIdOrPid)) {
      attachTarget = await this.resolvePid(deviceId, appBundleIdOrPid);
    }

    const template = TEMPLATE_MAP[config.template] ?? 'Time Profiler';
    const args: string[] = [
      'xctrace', 'record',
      '--template', template,
      '--device', deviceId,
      '--attach', attachTarget,
      '--output', this.tracePath,
    ];

    if (config.timeLimitSeconds) {
      args.push('--time-limit', `${config.timeLimitSeconds}s`);
    }

    console.error(`[IosProfiler] starting: xcrun ${args.join(' ')}`);
    this.startTime = Date.now();

    this.process = spawn('xcrun', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detach so it doesn't block Node from exiting if cleanup fails
      detached: false,
    });

    // Log stderr for debugging
    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[IosProfiler] xctrace stderr: ${data.toString().trim()}`);
    });

    // Wait briefly for xctrace to start (it outputs "Recording started" to stderr)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // xctrace takes a few seconds to initialize — resolve after 3s
        resolve();
      }, 3000);

      this.process!.on('error', (err) => {
        clearTimeout(timeout);
        this._isActive = false;
        reject(new Error(`Failed to start xctrace: ${err.message}`));
      });

      // If it exits immediately, something went wrong
      this.process!.on('exit', (code) => {
        if (!this._isActive && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`xctrace exited immediately with code ${code}`));
        }
      });

      this._isActive = true;
      // Don't clear timeout — let it resolve naturally
    });

    console.error(`[IosProfiler] profiling active (template: ${template})`);
  }

  async stop(): Promise<ProfilingMetrics> {
    if (!this._isActive || !this.process) {
      throw new Error('IosProfiler is not active. Call start() first.');
    }

    const durationMs = this.startTime ? Date.now() - this.startTime : 0;
    const config = this.config!;
    const tracePath = this.tracePath!;

    // Send SIGINT for graceful xctrace shutdown
    console.error('[IosProfiler] sending SIGINT to xctrace...');
    this.process.kill('SIGINT');

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if it doesn't exit within 10s
        console.error('[IosProfiler] xctrace did not exit gracefully, sending SIGKILL');
        this.process?.kill('SIGKILL');
        resolve();
      }, 10_000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this._isActive = false;
    this.process = null;

    // Extract metrics from the trace file
    const metrics = await this.extractMetrics(tracePath, config, durationMs);

    // Cleanup trace file if requested
    if (config.cleanupTrace !== false) {
      try {
        await fs.rm(tracePath, { recursive: true, force: true });
        console.error(`[IosProfiler] cleaned up trace: ${tracePath}`);
      } catch {
        console.error(`[IosProfiler] failed to clean up trace: ${tracePath}`);
      }
      metrics.rawTracePath = undefined;
    } else {
      metrics.rawTracePath = tracePath;
    }

    return metrics;
  }

  private async extractMetrics(
    tracePath: string,
    config: ProfilingConfig,
    durationMs: number,
  ): Promise<ProfilingMetrics> {
    const metrics: ProfilingMetrics = {
      platform: 'ios',
      profilingDurationMs: durationMs,
      warnings: [
        'Simulator profiling values may deviate ~30% from physical device measurements.',
      ],
    };

    try {
      // Check if trace file exists
      await fs.access(tracePath);
    } catch {
      metrics.warnings.push('Trace file not found — xctrace may not have recorded successfully.');
      return metrics;
    }

    try {
      // Export table of contents to discover available schemas
      const { stdout: toc } = await execFileAsync('xcrun', [
        'xctrace', 'export',
        '--input', tracePath,
        '--toc',
      ], { timeout: 30_000 });

      console.error(`[IosProfiler] trace TOC: ${toc.substring(0, 500)}`);

      // Extract metrics based on template
      if (config.template === 'time-profiler' || config.template === 'app-launch') {
        const parsed = await this.exportAndParseSchema(tracePath, 'time-profile', toc);
        if (parsed) {
          const cpuTimeMicros = parsed.cpuUsagePercent; // reused field for raw weight
          if (cpuTimeMicros && durationMs > 0) {
            // Convert: CPU microseconds / (wall-clock ms * 1000) * 100 = CPU %
            metrics.cpuUsagePercent =
              Math.round((cpuTimeMicros / (durationMs * 1000)) * 100 * 100) / 100;
            // Cap at 100% (multi-core can exceed but we normalize)
            metrics.cpuUsagePercent = Math.min(metrics.cpuUsagePercent, 100);
          }
        }
      }

      if (config.template === 'allocations' || config.template === 'memory-snapshot') {
        const parsed = await this.exportAndParseSchema(tracePath, 'allocations', toc);
        if (parsed) {
          metrics.peakMemoryMb = parsed.peakMemoryMb;
          metrics.memoryFootprintMb = parsed.memoryFootprintMb;
        }
      }
    } catch (err) {
      console.error('[IosProfiler] metric extraction failed:', err);
      metrics.warnings.push(
        `Metric extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return metrics;
  }

  /**
   * Export a specific schema from the trace and parse it.
   * Returns null if the schema is not available in the trace.
   */
  private async exportAndParseSchema(
    tracePath: string,
    schemaName: string,
    toc: string,
  ): Promise<Partial<ProfilingMetrics> | null> {
    // Check if schema is in the TOC
    if (!toc.includes(schemaName)) {
      console.error(`[IosProfiler] schema '${schemaName}' not found in trace TOC`);
      return null;
    }

    try {
      const xpath = `/trace-toc/run[@number="1"]/data/table[@schema="${schemaName}"]`;
      const { stdout } = await execFileAsync('xcrun', [
        'xctrace', 'export',
        '--input', tracePath,
        '--xpath', xpath,
      ], { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 }); // 50MB buffer for large traces

      if (schemaName === 'time-profile') {
        return parseXctraceTimeProfle(stdout);
      } else if (schemaName === 'allocations') {
        return parseXctraceAllocations(stdout);
      }
    } catch (err) {
      console.error(`[IosProfiler] failed to export schema '${schemaName}':`, err);
    }

    return null;
  }
}
