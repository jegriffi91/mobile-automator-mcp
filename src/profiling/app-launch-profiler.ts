/**
 * AppLaunchIosProfiler — ProfilingDriver that measures app launch time
 * using `xcrun xctrace record --template "App Launch" --launch`.
 *
 * Unlike the regular IosProfiler (attach mode), this profiler LAUNCHES
 * the app itself, measuring the time from process start to first frame.
 * It runs BEFORE Maestro, and Maestro reuses the already-running app.
 *
 * The resulting trace is small (a few MB) and the launch duration is
 * extracted from the trace TOC XML's <duration> field — no need for
 * full schema export.
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import type { ProfilingDriver, ProfilingConfig, ProfilingMetrics } from './profiler.js';
import { parseXctraceLaunchTime } from './metric-parser.js';

const execFileAsync = promisify(execFile);

export class AppLaunchIosProfiler implements ProfilingDriver {
  private tracePath: string | null = null;
  private config: ProfilingConfig | null = null;
  private startTime: number | null = null;
  private _isActive = false;
  private launchMetrics: ProfilingMetrics | null = null;

  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Run xctrace with --launch to measure app startup.
   *
   * This method:
   * 1. Opens the app via xctrace (--launch using simctl)
   * 2. Waits for xctrace to exit (recording ends when app is interactive)
   * 3. Extracts launch time from the trace TOC
   *
   * Unlike the attach-mode profiler, this completes synchronously —
   * start() does the measurement and stop() just returns the results.
   */
  async start(
    deviceId: string,
    appBundleId: string,
    config: ProfilingConfig,
  ): Promise<void> {
    if (this._isActive) {
      throw new Error('AppLaunchIosProfiler is already active. Call stop() first.');
    }

    this.config = config;
    this.startTime = Date.now();
    this._isActive = true;

    const outputDir = config.outputDir ?? os.tmpdir();
    this.tracePath = path.join(outputDir, `app-launch-${randomUUID()}.trace`);

    console.error(`[AppLaunchIosProfiler] measuring app launch for ${appBundleId}...`);

    try {
      // Use xctrace record --template "App Launch" --launch -- simctl launch
      // xctrace --launch runs the command and instruments from first instruction
      const args = [
        'xctrace', 'record',
        '--template', 'App Launch',
        '--device', deviceId,
        '--output', this.tracePath,
        '--time-limit', `${config.timeLimitSeconds ?? 30}s`,
        '--no-prompt',
        '--launch', '--',
        'xcrun', 'simctl', 'launch', '--terminate-running-process',
        deviceId, appBundleId,
      ];

      console.error(`[AppLaunchIosProfiler] xcrun ${args.join(' ')}`);

      // Use spawn with a timeout — app launch should complete within the time limit
      const timeoutMs = ((config.timeLimitSeconds ?? 30) + 10) * 1000;

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('xcrun', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });

        let stderr = '';
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill('SIGINT');
          setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`xctrace app-launch timed out after ${timeoutMs}ms`));
          }, 5000);
        }, timeoutMs);

        proc.on('exit', (code) => {
          clearTimeout(timeout);
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`xctrace app-launch exited with code ${code}: ${stderr.substring(0, 500)}`));
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Extract launch time from the trace TOC
      const durationMs = Date.now() - this.startTime;
      this.launchMetrics = await this.extractLaunchMetrics(durationMs);

      console.error(
        `[AppLaunchIosProfiler] launch time: ${this.launchMetrics.launchTimeMs ?? 'N/A'}ms`,
      );
    } catch (err) {
      console.error('[AppLaunchIosProfiler] failed:', err);
      // Still mark as active so stop() can return partial metrics
      this.launchMetrics = {
        platform: 'ios',
        profilingDurationMs: Date.now() - this.startTime,
        warnings: [
          'Simulator profiling values may deviate ~30% from physical device measurements.',
          `App launch measurement failed: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  }

  /**
   * Return the metrics collected during start().
   * For app-launch, the measurement happens in start().
   */
  async stop(): Promise<ProfilingMetrics> {
    if (!this._isActive) {
      throw new Error('AppLaunchIosProfiler is not active. Call start() first.');
    }

    this._isActive = false;
    const metrics = this.launchMetrics!;

    // Cleanup trace file if requested
    if (this.config?.cleanupTrace !== false && this.tracePath) {
      try {
        await fs.rm(this.tracePath, { recursive: true, force: true });
        console.error(`[AppLaunchIosProfiler] cleaned up trace: ${this.tracePath}`);
      } catch {
        // Best-effort cleanup
      }
      metrics.rawTracePath = undefined;
    } else if (this.tracePath) {
      metrics.rawTracePath = this.tracePath;
    }

    return metrics;
  }

  private async extractLaunchMetrics(durationMs: number): Promise<ProfilingMetrics> {
    const metrics: ProfilingMetrics = {
      platform: 'ios',
      profilingDurationMs: durationMs,
      warnings: [
        'Simulator profiling values may deviate ~30% from physical device measurements.',
      ],
    };

    if (!this.tracePath) return metrics;

    try {
      await fs.access(this.tracePath);

      // Export just the TOC (small XML) to get the recording duration
      const { stdout: toc } = await execFileAsync('xcrun', [
        'xctrace', 'export',
        '--input', this.tracePath,
        '--toc',
      ], { timeout: 15_000 });

      const launchTime = parseXctraceLaunchTime(toc);
      if (launchTime !== undefined) {
        metrics.launchTimeMs = launchTime;
      }
    } catch (err) {
      metrics.warnings.push(
        `Launch time extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return metrics;
  }
}
