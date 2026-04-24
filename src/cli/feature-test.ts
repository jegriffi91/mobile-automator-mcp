#!/usr/bin/env node
/**
 * CLI entry point for run_feature_test.
 *
 * Exposes the same composite test runner that MCP clients use, but as a plain
 * executable so CI/CD pipelines can invoke it without an LLM in the loop.
 *
 *   mobile-automator-feature-test ./features/sdui-parallelism.yaml \
 *       --platform ios --flows-dir ./flows
 *
 * Output contract:
 *   - stdout: final JSON FeatureTestResult (always, so CI can pipe/parse it)
 *   - stderr: human-readable progress + summary (suppress with --quiet)
 *
 * Exit codes:
 *   0 = test passed
 *   1 = test failed (setup / actions / any assertion)
 *   2 = invalid arguments or spec load/parse error
 */

import { handleRunFeatureTest } from '../handlers.js';
import { sessionManager } from '../session/index.js';
import type { RunFeatureTestInput, RunFeatureTestOutput } from '../schemas.js';

const USAGE = `Usage: mobile-automator-feature-test <spec-path> [flags]
   or: mobile-automator-feature-test --spec <path> [flags]

A single-call composite test runner. Executes setup flows → records a session →
dispatches UI actions → runs network assertions → compiles the Maestro YAML →
runs teardown flows, all from a declarative spec.

Flags:
  --spec <path>               Path to a .yaml/.json feature test spec
                              (positional argument accepted as well)
  --platform <ios|android>    Target platform (default: ios)
  --flows-dir <path>          Directory containing Maestro flow YAML files
  --stubs-dir <path>          Optional WireMock stubs root for setup/teardown
  --env KEY=VALUE             Env var forwarded to every flow (repeatable)
  --setup-timeout-ms <n>      Max wall-clock for all setup flows (default 120000)
  --action-timeout-ms <n>     Max wall-clock for actions phase (default 30000)
  --settle-ms <n>             Wait after actions before assertions (default 5000)
  --driver-cooldown-ms <n>    Pause between consecutive setup flows (default 5000)
  --quiet, -q                 Suppress progress output on stderr
  --help, -h                  Show this help

Exit codes:
  0 = passed, 1 = failed, 2 = invalid args / spec parse error
`;

export interface ParsedArgs {
    specPath: string;
    env: Record<string, string>;
    platform?: 'ios' | 'android';
    flowsDir?: string;
    stubsDir?: string;
    setupTimeoutMs?: number;
    actionTimeoutMs?: number;
    settleMs?: number;
    driverCooldownMs?: number;
    quiet: boolean;
}

export class ArgParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ArgParseError';
    }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
    const args: ParsedArgs = {
        specPath: '',
        env: {},
        quiet: false,
    };
    let positional: string | undefined;

    const requireValue = (flag: string, next: string | undefined): string => {
        if (next === undefined) throw new ArgParseError(`${flag} requires a value`);
        return next;
    };

    const toPositiveInt = (flag: string, raw: string): number => {
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
            throw new ArgParseError(`${flag} expects a non-negative integer, got "${raw}"`);
        }
        return n;
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--spec':
                args.specPath = requireValue('--spec', argv[++i]);
                break;
            case '--platform': {
                const v = requireValue('--platform', argv[++i]);
                if (v !== 'ios' && v !== 'android') {
                    throw new ArgParseError(`--platform must be "ios" or "android", got "${v}"`);
                }
                args.platform = v;
                break;
            }
            case '--flows-dir':
                args.flowsDir = requireValue('--flows-dir', argv[++i]);
                break;
            case '--stubs-dir':
                args.stubsDir = requireValue('--stubs-dir', argv[++i]);
                break;
            case '--env': {
                const kv = requireValue('--env', argv[++i]);
                const eq = kv.indexOf('=');
                if (eq <= 0) throw new ArgParseError(`--env expects KEY=VALUE, got "${kv}"`);
                args.env[kv.slice(0, eq)] = kv.slice(eq + 1);
                break;
            }
            case '--setup-timeout-ms':
                args.setupTimeoutMs = toPositiveInt('--setup-timeout-ms', requireValue('--setup-timeout-ms', argv[++i]));
                break;
            case '--action-timeout-ms':
                args.actionTimeoutMs = toPositiveInt('--action-timeout-ms', requireValue('--action-timeout-ms', argv[++i]));
                break;
            case '--settle-ms':
                args.settleMs = toPositiveInt('--settle-ms', requireValue('--settle-ms', argv[++i]));
                break;
            case '--driver-cooldown-ms':
                args.driverCooldownMs = toPositiveInt('--driver-cooldown-ms', requireValue('--driver-cooldown-ms', argv[++i]));
                break;
            case '--quiet':
            case '-q':
                args.quiet = true;
                break;
            case '--help':
            case '-h':
                throw new ArgParseError('__HELP__');
            default:
                if (a.startsWith('-')) {
                    throw new ArgParseError(`Unknown flag: ${a}`);
                }
                if (positional !== undefined) {
                    throw new ArgParseError(`Unexpected positional argument "${a}" (already got "${positional}")`);
                }
                positional = a;
                break;
        }
    }

    if (!args.specPath && positional) args.specPath = positional;
    if (!args.specPath) throw new ArgParseError('A spec path is required (either positional or via --spec)');

    return args;
}

export function formatSummary(r: RunFeatureTestOutput): string {
    const lines: string[] = [];
    const badge = r.passed ? 'PASS' : 'FAIL';
    lines.push('');
    lines.push(`${badge}  ${r.name}  (${r.durationMs} ms)`);
    if (r.error) lines.push(`  error: ${r.error}`);

    if (r.setup.flows.length) {
        lines.push('');
        lines.push('Setup:');
        for (const f of r.setup.flows) {
            const tag = f.passed ? 'ok' : 'FAIL';
            lines.push(`  [${tag}] ${f.name} (${f.durationMs} ms)${f.error ? ` — ${f.error.split('\n')[0]}` : ''}`);
        }
    }

    if (r.actions.interactions.length) {
        lines.push('');
        lines.push(`Actions (session ${r.actions.sessionId || '<none>'}):`);
        for (const a of r.actions.interactions) {
            lines.push(`  · ${a.action} ${a.element} (${a.durationMs} ms)`);
        }
    }

    if (r.assertions.length) {
        lines.push('');
        lines.push('Assertions:');
        for (const a of r.assertions) {
            const tag = a.passed ? 'ok' : 'FAIL';
            lines.push(`  [${tag}] ${a.type}: ${a.verdict}`);
        }
    }

    if (r.teardown.flows.length || r.teardown.compiledYamlPath) {
        lines.push('');
        lines.push('Teardown:');
        for (const f of r.teardown.flows) {
            const tag = f.passed ? 'ok' : 'WARN';
            lines.push(`  [${tag}] ${f.name} (${f.durationMs} ms)`);
        }
        if (r.teardown.compiledYamlPath) {
            lines.push(`  compiled yaml: ${r.teardown.compiledYamlPath}`);
        }
    }

    lines.push('');
    return lines.join('\n');
}

function buildInput(parsed: ParsedArgs): RunFeatureTestInput {
    const env = Object.keys(parsed.env).length ? parsed.env : undefined;
    return {
        spec: parsed.specPath,
        env,
        platform: parsed.platform,
        flowsDir: parsed.flowsDir,
        stubsDir: parsed.stubsDir,
        setupTimeoutMs: parsed.setupTimeoutMs,
        actionTimeoutMs: parsed.actionTimeoutMs,
        settleMs: parsed.settleMs,
        driverCooldownMs: parsed.driverCooldownMs,
    };
}

export async function runCli(argv: readonly string[]): Promise<number> {
    let parsed: ParsedArgs;
    try {
        parsed = parseArgs(argv);
    } catch (err) {
        if (err instanceof ArgParseError) {
            if (err.message === '__HELP__') {
                process.stderr.write(USAGE);
                return 0;
            }
            process.stderr.write(`${err.message}\n\n${USAGE}`);
            return 2;
        }
        throw err;
    }

    await sessionManager.initialize();

    if (!parsed.quiet) {
        process.stderr.write(`[run_feature_test] loading spec: ${parsed.specPath}\n`);
    }

    let result: RunFeatureTestOutput;
    try {
        result = await handleRunFeatureTest(buildInput(parsed));
    } catch (err) {
        process.stderr.write(`[run_feature_test] aborted: ${(err as Error).message}\n`);
        return 2;
    }

    // Always emit JSON on stdout so CI can capture it
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');

    if (!parsed.quiet) {
        process.stderr.write(formatSummary(result));
    }

    return result.passed ? 0 : 1;
}

// Only run when invoked directly (skipped when imported for tests)
const isDirect =
    process.argv[1] && /mobile-automator-feature-test|feature-test\.js$/.test(process.argv[1]);
if (isDirect) {
    runCli(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((err) => {
            process.stderr.write(`[run_feature_test] fatal: ${err?.stack ?? err}\n`);
            process.exit(2);
        });
}
