# Profiling Module — `src/profiling/`

## Overview

Platform-specific performance profiling drivers for optional use in `run_test`.

## Architecture

| File | Purpose |
|---|---|
| `profiler.ts` | `ProfilingDriver` interface, `ProfilingConfig`/`ProfilingMetrics` types |
| `lightweight-ios-profiler.ts` | **Default iOS** → `ps` process sampling (CPU/memory at 1s intervals) |
| `lightweight-android-profiler.ts` | **Default Android** → `/proc` sampling via `adb shell` (CPU/memory at 1s intervals) |
| `app-launch-profiler.ts` | iOS app-launch → `xctrace --launch` for startup time measurement |
| `app-launch-android-profiler.ts` | Android app-launch → `am start -W` for startup time measurement |
| `ios-profiler.ts` | iOS deep profiling → `xctrace --attach` (not default, available for future use) |
| `android-profiler.ts` | Android legacy → `adb shell dumpsys meminfo/cpuinfo` snapshots (superseded) |
| `metric-parser.ts` | Pure-logic parsers for all CLI output formats (testable core) |
| `index.ts` | Barrel export + `createProfiler(platform, template)` factory |

## Template → Profiler Routing

### iOS

| Template | Profiler | Method |
|---|---|---|
| `time-profiler` | `LightweightIosProfiler` | `ps` sampling |
| `memory-snapshot` | `LightweightIosProfiler` | `ps` sampling |
| `allocations` | `LightweightIosProfiler` | `ps` sampling |
| `app-launch` | `AppLaunchIosProfiler` | `xctrace --launch` |

### Android

| Template | Profiler | Method |
|---|---|---|
| `time-profiler` | `LightweightAndroidProfiler` | `/proc` sampling via `adb shell` |
| `memory-snapshot` | `LightweightAndroidProfiler` | `/proc` sampling via `adb shell` |
| `allocations` | `LightweightAndroidProfiler` | `/proc` sampling via `adb shell` |
| `app-launch` | `AppLaunchAndroidProfiler` | `am start -W` |

## Key Design Decisions

- **Lightweight by default**: Both platforms use process sampling (~2ms overhead per sample) avoiding heavy traces
- **PID re-resolution**: Lightweight profilers handle Maestro's `launchApp` (kills + relaunches app)
- **App-launch runs first**: App-launch profilers launch the app and complete measurement before Maestro runs
- **Non-fatal everything**: All profiling failures are caught and reported as warnings, never blocking the test
- **Feature parity**: Both platforms support all 4 templates with continuous sampling and app-launch timing

## Rules

- All parsers go in `metric-parser.ts` (pure logic, no I/O)
- Tests go in `metric-parser.test.ts` (co-located)
- Never add profiling-related fields to `ProfilingMetrics` without updating `ProfilingMetricsSchema` in `schemas.ts`

