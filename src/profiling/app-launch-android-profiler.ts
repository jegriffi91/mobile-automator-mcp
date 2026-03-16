/**
 * AppLaunchAndroidProfiler — ProfilingDriver that measures app launch time
 * using `adb shell am start -W`.
 *
 * The `-W` flag makes Activity Manager wait for the launch to complete and
 * report timing data (TotalTime, WaitTime, LaunchState). This is the
 * Android equivalent of iOS's `xctrace --launch` template.
 *
 * Like the iOS AppLaunchIosProfiler, this profiler launches the app itself
 * and completes measurement during start(). Maestro then reuses the
 * already-running app.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProfilingDriver, ProfilingConfig, ProfilingMetrics } from './profiler.js';
import { parseAmStartOutput } from './metric-parser.js';

const execFileAsync = promisify(execFile);

export class AppLaunchAndroidProfiler implements ProfilingDriver {
  private config: ProfilingConfig | null = null;
  private startTime: number | null = null;
  private _isActive = false;
  private launchMetrics: ProfilingMetrics | null = null;

  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Force-stop the app, then launch with `am start -W` to measure startup.
   *
   * This method:
   * 1. Force-stops the app to ensure a cold launch
   * 2. Launches with `am start -W` to measure from start to first frame
   * 3. Parses TotalTime from the output
   *
   * Like the iOS variant, start() does the measurement and stop() returns results.
   */
  async start(
    deviceId: string,
    appPackageName: string,
    config: ProfilingConfig,
  ): Promise<void> {
    if (this._isActive) {
      throw new Error('AppLaunchAndroidProfiler is already active. Call stop() first.');
    }

    this.config = config;
    this.startTime = Date.now();
    this._isActive = true;

    console.error(`[AppLaunchAndroidProfiler] measuring app launch for ${appPackageName}...`);

    try {
      // Force-stop the app first for a clean cold launch
      try {
        await execFileAsync('adb', [
          '-s', deviceId, 'shell', 'am', 'force-stop', appPackageName,
        ], { timeout: 10_000 });
        console.error('[AppLaunchAndroidProfiler] force-stopped app for cold launch');
      } catch {
        console.error('[AppLaunchAndroidProfiler] force-stop failed (non-fatal, app may not be running)');
      }

      // Small delay to let the system settle after force-stop
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Resolve the launch activity — use monkey to find the launcher activity
      let launchIntent: string;
      try {
        const { stdout: intentStdout } = await execFileAsync('adb', [
          '-s', deviceId, 'shell',
          'cmd', 'package', 'resolve-activity', '--brief', appPackageName,
        ], { timeout: 10_000 });

        // Output format: "priority=0 preferredOrder=0 match=0x00108000 ...\ncom.example.app/.MainActivity"
        const lines = intentStdout.trim().split('\n');
        const activityLine = lines[lines.length - 1].trim();
        if (activityLine.includes('/')) {
          launchIntent = activityLine;
        } else {
          throw new Error('Could not resolve launch activity');
        }
      } catch {
        // Fallback: use monkey to launch (less precise but more compatible)
        launchIntent = `${appPackageName}/.MainActivity`;
        console.error(`[AppLaunchAndroidProfiler] using fallback activity: ${launchIntent}`);
      }

      // Launch with -W (wait for launch complete) and -S (force stop first)
      const timeoutMs = ((config.timeLimitSeconds ?? 30) + 10) * 1000;
      const { stdout } = await execFileAsync('adb', [
        '-s', deviceId, 'shell',
        'am', 'start', '-W', '-n', launchIntent,
      ], { timeout: timeoutMs });

      console.error(`[AppLaunchAndroidProfiler] am start output:\n${stdout}`);

      const durationMs = Date.now() - this.startTime;
      const launchTimeMs = parseAmStartOutput(stdout);

      this.launchMetrics = {
        platform: 'android',
        profilingDurationMs: durationMs,
        launchTimeMs,
        warnings: [
          'Emulator profiling values may not reflect physical device performance.',
        ],
      };

      if (stdout.includes('COLD')) {
        console.error(`[AppLaunchAndroidProfiler] cold launch: ${launchTimeMs ?? 'N/A'}ms`);
      } else if (stdout.includes('WARM')) {
        this.launchMetrics.warnings.push('Warm launch detected — times may be faster than cold launch.');
        console.error(`[AppLaunchAndroidProfiler] warm launch: ${launchTimeMs ?? 'N/A'}ms`);
      } else if (stdout.includes('HOT')) {
        this.launchMetrics.warnings.push('Hot launch detected — times may be faster than cold launch.');
        console.error(`[AppLaunchAndroidProfiler] hot launch: ${launchTimeMs ?? 'N/A'}ms`);
      }
    } catch (err) {
      console.error('[AppLaunchAndroidProfiler] failed:', err);
      this.launchMetrics = {
        platform: 'android',
        profilingDurationMs: Date.now() - this.startTime,
        warnings: [
          'Emulator profiling values may not reflect physical device performance.',
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
      throw new Error('AppLaunchAndroidProfiler is not active. Call start() first.');
    }

    this._isActive = false;
    return this.launchMetrics!;
  }
}
