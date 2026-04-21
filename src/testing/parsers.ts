/**
 * Parsers that turn raw test-runner output into structured summaries.
 *
 * iOS:     xcodebuild stdout — regex scan of `Test Case '...' passed/failed/skipped` lines
 *          plus `error:` lines to attach first-line failure messages. Chosen over
 *          xcresulttool because the JSON format changes across Xcode versions while
 *          stdout has stayed backwards-compatible for many releases.
 *
 * Android: JUnit XML reports — Gradle's test tasks write one XML per test class under
 *          `<module>/build/test-results/<task>/`. We walk the directory, parse each
 *          file, and merge the results.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface UnitTestFailure {
    name: string;
    message?: string;
    file?: string;
    line?: number;
}

export interface UnitTestSummary {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    skippedTests: number;
    failures: UnitTestFailure[];
}

export function emptySummary(): UnitTestSummary {
    return {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        failures: [],
    };
}

export function mergeSummaries(a: UnitTestSummary, b: UnitTestSummary): UnitTestSummary {
    return {
        totalTests: a.totalTests + b.totalTests,
        passedTests: a.passedTests + b.passedTests,
        failedTests: a.failedTests + b.failedTests,
        skippedTests: a.skippedTests + b.skippedTests,
        failures: [...a.failures, ...b.failures],
    };
}

const TEST_CASE_RESULT = /Test Case '-\[(.+?) (\S+?)\]' (passed|failed|skipped)\b/g;
const TEST_CASE_ERROR = /^(.+?):(\d+): error: -\[(.+?) (\S+?)\] : (.+)$/;

/**
 * Parse xcodebuild test stdout into a structured summary. Counts are derived
 * from per-test `Test Case ... passed/failed/skipped` lines to avoid
 * double-counting the nested "Executed N tests" summary lines xcodebuild emits
 * once per suite level.
 */
export function parseXcodebuildOutput(output: string): UnitTestSummary {
    const summary = emptySummary();
    const errorsByTest = new Map<string, { file: string; line: number; message: string }>();

    for (const raw of output.split(/\r?\n/)) {
        const m = raw.match(TEST_CASE_ERROR);
        if (!m) continue;
        const [, file, lineStr, cls, method, msg] = m;
        errorsByTest.set(`${cls} ${method}`, {
            file,
            line: Number(lineStr),
            message: msg.trim(),
        });
    }

    for (const match of output.matchAll(TEST_CASE_RESULT)) {
        const [, cls, method, result] = match;
        summary.totalTests += 1;
        if (result === 'passed') {
            summary.passedTests += 1;
        } else if (result === 'failed') {
            summary.failedTests += 1;
            const err = errorsByTest.get(`${cls} ${method}`);
            summary.failures.push({
                name: `${cls}/${method}`,
                message: err?.message,
                file: err?.file,
                line: err?.line,
            });
        } else {
            summary.skippedTests += 1;
        }
    }

    return summary;
}

function decodeXmlEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#10;/g, '\n')
        .replace(/&#13;/g, '\r')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&amp;/g, '&');
}

function attr(openingTag: string, name: string): string | undefined {
    const re = new RegExp(`\\b${name}="([^"]*)"`);
    const m = openingTag.match(re);
    return m ? decodeXmlEntities(m[1]) : undefined;
}

const FIRST_LINE_LIMIT = 500;

function firstLine(text: string): string | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const line = trimmed.split(/\r?\n/)[0].trim();
    return line.length > FIRST_LINE_LIMIT ? `${line.slice(0, FIRST_LINE_LIMIT)}…` : line;
}

/**
 * Parse a single JUnit XML document. Counts and failures are derived directly
 * from `<testcase>` entries rather than trusting the parent `<testsuite>`
 * attributes — Gradle occasionally emits bogus totals for nested suites.
 */
export function parseJunitXml(content: string): UnitTestSummary {
    const summary = emptySummary();

    const caseRegex = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    for (const match of content.matchAll(caseRegex)) {
        const attrs = match[1];
        const body = match[3] ?? '';
        const name = attr(attrs, 'name') ?? '(anonymous)';
        const classname = attr(attrs, 'classname');
        const fullName = classname ? `${classname}.${name}` : name;

        summary.totalTests += 1;

        const skipped = /<skipped\b/.test(body);
        const failureMatch =
            body.match(/<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure>)/)
            ?? body.match(/<error\b([^>]*?)(?:\/>|>([\s\S]*?)<\/error>)/);

        if (skipped) {
            summary.skippedTests += 1;
        } else if (failureMatch) {
            summary.failedTests += 1;
            const failAttrs = failureMatch[1];
            const failBody = decodeXmlEntities(failureMatch[2] ?? '');
            const message = attr(failAttrs, 'message') ?? firstLine(failBody);
            summary.failures.push({
                name: fullName,
                message,
            });
        } else {
            summary.passedTests += 1;
        }
    }

    return summary;
}

async function walkXml(dir: string): Promise<string[]> {
    const found: string[] = [];
    async function walk(d: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.xml')) {
                found.push(full);
            }
        }
    }
    await walk(dir);
    return found;
}

/**
 * Parse every JUnit XML file below `reportDir` and merge into a single summary.
 * Returns `emptySummary()` (with zeroed counts) if the directory is missing.
 */
export async function parseJunitReportDir(reportDir: string): Promise<UnitTestSummary> {
    const files = await walkXml(reportDir);
    let summary = emptySummary();
    for (const file of files) {
        try {
            const content = await fs.readFile(file, 'utf8');
            summary = mergeSummaries(summary, parseJunitXml(content));
        } catch {
            // skip unreadable files silently — the aggregate count still reports fail counts
            // for files we could parse
        }
    }
    return summary;
}
