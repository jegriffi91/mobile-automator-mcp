/**
 * iOS unit test runner — shells `xcodebuild test`.
 *
 * Writes a .xcresult bundle next to tmpdir for post-hoc inspection, and parses
 * xcodebuild's stdout with the regex parser in `./parsers.ts`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import { truncateOutput } from '../build/utils.js';
import { parseXcodebuildOutput, type UnitTestSummary } from './parsers.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TEST_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 100 * 1024 * 1024;

export interface IosUnitTestOptions {
    workspacePath?: string;
    projectPath?: string;
    scheme: string;
    destination?: string;
    configuration?: string;
    testPlan?: string;
    onlyTesting?: string[];
    resultBundlePath?: string;
    timeoutMs?: number;
}

export interface IosUnitTestResult extends UnitTestSummary {
    passed: boolean;
    resultBundlePath: string;
    durationMs: number;
    output: string;
}

function defaultResultBundlePath(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(os.tmpdir(), 'mobile-automator-tests', `run-${ts}.xcresult`);
}

export async function runIosUnitTests(
    options: IosUnitTestOptions,
): Promise<IosUnitTestResult> {
    if (!options.workspacePath && !options.projectPath) {
        throw new Error('iOS unit tests require "workspacePath" or "projectPath"');
    }

    const destination = options.destination ?? 'platform=iOS Simulator,name=iPhone 15';
    const configuration = options.configuration ?? 'Debug';
    const resultBundlePath = options.resultBundlePath ?? defaultResultBundlePath();

    const args: string[] = [];
    if (options.workspacePath) {
        args.push('-workspace', options.workspacePath);
    } else if (options.projectPath) {
        args.push('-project', options.projectPath);
    }
    args.push(
        '-scheme', options.scheme,
        '-configuration', configuration,
        '-destination', destination,
        '-resultBundlePath', resultBundlePath,
    );
    if (options.testPlan) args.push('-testPlan', options.testPlan);
    for (const filter of options.onlyTesting ?? []) {
        args.push(`-only-testing:${filter}`);
    }
    args.push('test');

    const start = Date.now();
    let rawOutput = '';
    let exitedSuccessfully = false;
    try {
        const { stdout, stderr } = await execFileAsync('xcodebuild', args, {
            maxBuffer: MAX_BUFFER,
            timeout: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
        });
        rawOutput = [stdout, stderr].filter(Boolean).join('\n');
        exitedSuccessfully = true;
    } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        rawOutput = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        exitedSuccessfully = false;
    }

    const summary = parseXcodebuildOutput(rawOutput);
    // xcodebuild exits non-zero on test failure but also on compile failure. Treat
    // "at least one test ran AND none failed" as passed to distinguish the two.
    const passed =
        exitedSuccessfully &&
        summary.failedTests === 0 &&
        summary.totalTests > 0;

    return {
        passed,
        totalTests: summary.totalTests,
        passedTests: summary.passedTests,
        failedTests: summary.failedTests,
        skippedTests: summary.skippedTests,
        failures: summary.failures,
        resultBundlePath,
        durationMs: Date.now() - start,
        output: truncateOutput(rawOutput),
    };
}
