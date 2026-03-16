/**
 * Profiling module — barrel export.
 *
 * Provides platform-specific performance profiling drivers:
 *   • LightweightIosProfiler       — ps-based CPU/memory sampling (default for iOS)
 *   • AppLaunchIosProfiler          — xctrace --launch for app startup measurement
 *   • IosProfiler                   — xctrace attach mode (available for deep profiling)
 *   • LightweightAndroidProfiler    — /proc-based CPU/memory sampling (default for Android)
 *   • AppLaunchAndroidProfiler      — am start -W for app startup measurement
 *   • AndroidProfiler               — adb dumpsys snapshots (legacy fallback)
 */

export type { ProfilingDriver, ProfilingConfig, ProfilingMetrics, ProfilingTemplate } from './profiler.js';
export { IosProfiler } from './ios-profiler.js';
export { AndroidProfiler } from './android-profiler.js';
export { LightweightIosProfiler } from './lightweight-ios-profiler.js';
export { LightweightAndroidProfiler } from './lightweight-android-profiler.js';
export { AppLaunchIosProfiler } from './app-launch-profiler.js';
export { AppLaunchAndroidProfiler } from './app-launch-android-profiler.js';

import type { MobilePlatform } from '../types.js';
import type { ProfilingDriver, ProfilingTemplate } from './profiler.js';
import { LightweightIosProfiler } from './lightweight-ios-profiler.js';
import { AppLaunchIosProfiler } from './app-launch-profiler.js';
import { LightweightAndroidProfiler } from './lightweight-android-profiler.js';
import { AppLaunchAndroidProfiler } from './app-launch-android-profiler.js';

/**
 * Create a platform-appropriate profiling driver for the given template.
 *
 * Routing:
 *   iOS     + time-profiler/memory-snapshot/allocations → LightweightIosProfiler (ps sampling)
 *   iOS     + app-launch                                → AppLaunchIosProfiler (xctrace --launch)
 *   Android + time-profiler/memory-snapshot/allocations → LightweightAndroidProfiler (/proc sampling)
 *   Android + app-launch                                → AppLaunchAndroidProfiler (am start -W)
 *
 * @param platform - Target platform ('ios' or 'android')
 * @param template - Profiling template (defaults to 'time-profiler')
 * @returns A ProfilingDriver implementation
 */
export function createProfiler(platform: MobilePlatform, template?: ProfilingTemplate): ProfilingDriver {
  if (platform === 'ios') {
    if (template === 'app-launch') {
      return new AppLaunchIosProfiler();
    }
    return new LightweightIosProfiler();
  }
  if (template === 'app-launch') {
    return new AppLaunchAndroidProfiler();
  }
  return new LightweightAndroidProfiler();
}

