/**
 * Smoke Test Runner for mobile-automator-mcp
 *
 * Runs curated Maestro YAML smoke tests against a booted simulator to verify
 * the MCP tool stack works end-to-end. This is the tool "testing itself."
 *
 * Usage:
 *   npx tsx tests/smoke/run-smoke.ts [--platform ios|android] [--app-id <id>] [--category a|b|c|d|e|f]
 *
 * Requirements:
 *   - A booted iOS simulator (or Android emulator with --platform android)
 *   - The target app installed on the simulator
 *   - Maestro CLI installed and in PATH
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = one or more tests failed
 *   2 = environment setup error (no simulator, no Maestro, etc.)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { getExecEnv, resolveMaestroBin as resolveMaestroBinCore } from '../../src/maestro/env.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──

interface SmokeTestConfig {
  platform: 'ios' | 'android';
  appId: string;
  category?: string; // Filter by test category prefix (a, b, c, d, e, f)
}

interface SmokeTestResult {
  name: string;
  yamlPath: string;
  passed: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

// ── CLI argument parsing ──

function parseArgs(): SmokeTestConfig {
  const args = process.argv.slice(2);
  let platform: 'ios' | 'android' = 'ios';
  let appId = 'io.appcision.project-doombot';
  let category: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) {
      platform = args[i + 1] as 'ios' | 'android';
      i++;
    }
    if (args[i] === '--app-id' && args[i + 1]) {
      appId = args[i + 1];
      i++;
    }
    if (args[i] === '--category' && args[i + 1]) {
      category = args[i + 1].toLowerCase();
      i++;
    }
  }

  return { platform, appId, category };
}

// ── Environment checks ──

async function checkSimulator(platform: string): Promise<{ booted: boolean; deviceId?: string }> {
  if (platform === 'ios') {
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
      const data = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; state: string }>> };
      for (const runtime in data.devices) {
        for (const device of data.devices[runtime]) {
          if (device.state === 'Booted') {
            return { booted: true, deviceId: device.udid };
          }
        }
      }
    } catch {
      // xcrun not available
    }
    return { booted: false };
  }

  // Android
  try {
    const { stdout } = await execFileAsync('adb', ['devices']);
    const lines = stdout.split('\n');
    for (const line of lines.slice(1)) {
      if (line.includes('\tdevice')) {
        return { booted: true, deviceId: line.split('\t')[0] };
      }
    }
  } catch {
    // adb not available
  }
  return { booted: false };
}

/**
 * Resolve the Maestro binary path. Delegates to the core env.ts resolver
 * which checks: MAESTRO_CLI_PATH env → ~/.maestro/bin/ → /usr/local/bin → PATH.
 */
async function resolveMaestroBin(): Promise<string | null> {
  const bin = resolveMaestroBinCore();
  // The core resolver always returns something (falls back to bare 'maestro').
  // Verify the resolved binary actually exists (unless it's a bare name).
  if (bin === 'maestro') {
    // Bare name — check if it's in PATH using the enriched env
    try {
      await execFileAsync(bin, ['--version'], { env: getExecEnv(), timeout: 5000 });
      return bin;
    } catch {
      return null;
    }
  }
  try {
    await fs.access(bin);
    return bin;
  } catch {
    return null;
  }
}

// ── Test execution ──

async function runSmokeTest(
  yamlPath: string,
  config: SmokeTestConfig,
  maestroBin: string,
  deviceId?: string,
): Promise<SmokeTestResult> {
  const name = path.basename(yamlPath, '.yaml');
  const start = Date.now();

  try {
    const args = ['test', yamlPath, '-e', `APP_ID=${config.appId}`];
    if (deviceId) {
      args.unshift('--udid', deviceId);
    }

    const { stdout, stderr } = await execFileAsync(maestroBin, args, {
      timeout: 180_000, // 3 minute timeout per test (accounts for latency variability tests)
      env: getExecEnv(),
    });

    const durationMs = Date.now() - start;
    const output = stdout + stderr;
    const passed = !output.toLowerCase().includes('failed');

    return { name, yamlPath, passed, durationMs, output };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    const errObj = err && typeof err === 'object' ? err as Record<string, unknown> : {};
    const output =
      'stdout' in errObj
        ? String(errObj.stdout ?? '') + String(errObj.stderr ?? '')
        : '';

    return { name, yamlPath, passed: false, durationMs, output, error };
  }
}

// ── Reporting ──

function printResults(results: SmokeTestResult[]): void {
  console.log('\n' + '═'.repeat(70));
  console.log('  SMOKE TEST RESULTS');
  console.log('═'.repeat(70));

  const maxNameLen = Math.max(...results.map((r) => r.name.length), 10);

  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`  ${status}  ${r.name.padEnd(maxNameLen + 2)} ${duration}`);
    if (r.error) {
      console.log(`         └─ ${r.error.substring(0, 120)}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log('─'.repeat(70));
  console.log(
    `  Total: ${results.length}  |  Passed: ${passed}  |  Failed: ${failed}  |  Time: ${(totalMs / 1000).toFixed(1)}s`,
  );
  console.log('═'.repeat(70) + '\n');
}

// ── Main ──

async function main(): Promise<void> {
  const config = parseArgs();

  console.log(`\n🔥 mobile-automator-mcp Smoke Test Runner`);
  console.log(`   Platform: ${config.platform}`);
  console.log(`   App ID:   ${config.appId}`);
  if (config.category) {
    console.log(`   Category: ${config.category.toUpperCase()}`);
  }
  console.log();

  // Environment checks
  console.log('🔍 Checking environment...');

  const maestroBin = await resolveMaestroBin();
  if (!maestroBin) {
    console.error('❌ Maestro CLI not found. Install: curl -Ls "https://get.maestro.mobile.dev" | bash');
    process.exit(2);
  }
  console.log(`   ✅ Maestro CLI available (${maestroBin})`);

  const sim = await checkSimulator(config.platform);
  if (!sim.booted) {
    console.error(`❌ No booted ${config.platform} simulator found. Boot a device first.`);
    process.exit(2);
  }
  console.log(`   ✅ ${config.platform} simulator booted (${sim.deviceId})`);

  // Discover smoke test YAML files
  const smokeDir = path.join(__dirname);
  const files = await fs.readdir(smokeDir);
  const yamlFiles = files
    .filter((f) => f.endsWith('-smoke.yaml'))
    .filter((f) => !config.category || f.startsWith(config.category))
    .sort()
    .map((f) => path.join(smokeDir, f));

  if (yamlFiles.length === 0) {
    console.error('❌ No smoke test YAML files found in tests/smoke/');
    process.exit(2);
  }

  console.log(`\n🧪 Running ${yamlFiles.length} smoke test(s)...\n`);

  // Run tests sequentially (simulators don't support parallel Maestro runs)
  const results: SmokeTestResult[] = [];
  for (const yamlPath of yamlFiles) {
    const name = path.basename(yamlPath, '.yaml');
    console.log(`  ▶ ${name}...`);
    const result = await runSmokeTest(yamlPath, config, maestroBin, sim.deviceId);
    results.push(result);
    console.log(`  ${result.passed ? '✅' : '❌'} ${name} (${(result.durationMs / 1000).toFixed(1)}s)`);
  }

  // Print summary
  printResults(results);

  // Write JSON report for CI consumption
  const reportPath = path.join(smokeDir, 'smoke-results.json');
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        platform: config.platform,
        appId: config.appId,
        deviceId: sim.deviceId,
        results: results.map((r) => ({
          name: r.name,
          passed: r.passed,
          durationMs: r.durationMs,
          error: r.error,
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`📄 Report written to ${reportPath}`);

  // Exit code
  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('💥 Smoke runner crashed:', err);
  process.exit(2);
});
