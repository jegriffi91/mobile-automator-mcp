/**
 * Android unit test runner — shells `./gradlew test<Variant>UnitTest` and
 * parses the JUnit XML reports Gradle writes under
 * `<module>/build/test-results/<task>/`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { truncateOutput } from '../build/utils.js';
import {
    parseJunitReportDir,
    type UnitTestSummary,
} from './parsers.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TEST_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 100 * 1024 * 1024;

export interface AndroidUnitTestOptions {
    projectPath: string;
    module?: string;
    variant?: string;
    gradleTask?: string;
    testFilter?: string;
    timeoutMs?: number;
}

export interface AndroidUnitTestResult extends UnitTestSummary {
    passed: boolean;
    reportDir?: string;
    durationMs: number;
    output: string;
}

function capitalize(s: string): string {
    if (!s) return s;
    return s[0].toUpperCase() + s.slice(1);
}

function deriveGradleTask(variant: string, explicit?: string): string {
    if (explicit) return explicit;
    return `test${capitalize(variant)}UnitTest`;
}

/**
 * Resolve the canonical Gradle reports directory for a module + variant.
 * Matches Gradle's default: `<module>/build/test-results/<task>/`.
 */
function reportsDir(projectPath: string, module: string, task: string): string {
    return path.join(projectPath, module, 'build', 'test-results', task);
}

export async function runAndroidUnitTests(
    options: AndroidUnitTestOptions,
): Promise<AndroidUnitTestResult> {
    const module = options.module ?? 'app';
    const variant = options.variant ?? 'debug';
    const task = deriveGradleTask(variant, options.gradleTask);
    const gradlewPath = path.join(options.projectPath, 'gradlew');

    try {
        await fs.access(gradlewPath);
    } catch {
        throw new Error(`gradlew wrapper not found at ${gradlewPath}`);
    }

    const args = [`:${module}:${task}`];
    if (options.testFilter) {
        args.push('--tests', options.testFilter);
    }

    const start = Date.now();
    let rawOutput = '';
    let exitedSuccessfully = false;
    try {
        const { stdout, stderr } = await execFileAsync(gradlewPath, args, {
            cwd: options.projectPath,
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

    const reportDir = reportsDir(options.projectPath, module, task);
    const summary = await parseJunitReportDir(reportDir);
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
        reportDir,
        durationMs: Date.now() - start,
        output: truncateOutput(rawOutput),
    };
}
