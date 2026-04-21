import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    parseXcodebuildOutput,
    parseJunitXml,
    parseJunitReportDir,
    mergeSummaries,
    emptySummary,
} from './parsers.js';

describe('parseXcodebuildOutput()', () => {
    it('returns zeroed summary for empty input', () => {
        const result = parseXcodebuildOutput('');
        expect(result).toEqual(emptySummary());
    });

    it('counts a single passing test', () => {
        const output = [
            "Test Case '-[MyAppTests.MyTests testFoo]' started.",
            "Test Case '-[MyAppTests.MyTests testFoo]' passed (0.015 seconds).",
        ].join('\n');
        const result = parseXcodebuildOutput(output);
        expect(result.totalTests).toBe(1);
        expect(result.passedTests).toBe(1);
        expect(result.failedTests).toBe(0);
        expect(result.failures).toHaveLength(0);
    });

    it('captures failure with file/line/message when an error line precedes the failed marker', () => {
        const output = [
            "Test Case '-[MyAppTests.MyTests testBar]' started.",
            '/Users/x/MyAppTests/MyTests.swift:42: error: -[MyAppTests.MyTests testBar] : XCTAssertEqual failed: ("a") is not equal to ("b")',
            "Test Case '-[MyAppTests.MyTests testBar]' failed (0.018 seconds).",
        ].join('\n');
        const result = parseXcodebuildOutput(output);
        expect(result.totalTests).toBe(1);
        expect(result.passedTests).toBe(0);
        expect(result.failedTests).toBe(1);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatchObject({
            name: 'MyAppTests.MyTests/testBar',
            file: '/Users/x/MyAppTests/MyTests.swift',
            line: 42,
        });
        expect(result.failures[0].message).toContain('XCTAssertEqual failed');
    });

    it('handles a mix of passed/failed/skipped tests without double-counting nested suite summaries', () => {
        const output = [
            "Test Suite 'All tests' started at 2026-04-20 12:00:00.",
            "Test Suite 'MyAppTests.xctest' started at 2026-04-20 12:00:00.",
            "Test Case '-[MyTests testA]' started.",
            "Test Case '-[MyTests testA]' passed (0.010 seconds).",
            "Test Case '-[MyTests testB]' started.",
            '/tmp/MyTests.swift:10: error: -[MyTests testB] : wrong',
            "Test Case '-[MyTests testB]' failed (0.010 seconds).",
            "Test Case '-[MyTests testC]' skipped (0.001 seconds).",
            '\t Executed 3 tests, with 1 failure (0 unexpected) in 0.021 (0.022) seconds',
            '\t Executed 3 tests, with 1 failure (0 unexpected) in 0.021 (0.025) seconds',
        ].join('\n');
        const result = parseXcodebuildOutput(output);
        expect(result.totalTests).toBe(3);
        expect(result.passedTests).toBe(1);
        expect(result.failedTests).toBe(1);
        expect(result.skippedTests).toBe(1);
    });

    it('falls back to undefined message/file when no error line precedes a failed marker', () => {
        const output = "Test Case '-[MyTests testSilent]' failed (0.100 seconds).";
        const result = parseXcodebuildOutput(output);
        expect(result.failedTests).toBe(1);
        expect(result.failures[0]).toEqual({
            name: 'MyTests/testSilent',
            message: undefined,
            file: undefined,
            line: undefined,
        });
    });
});

describe('parseJunitXml()', () => {
    it('returns zeroed summary for input without testcases', () => {
        const xml = '<testsuite name="empty" tests="0"></testsuite>';
        const result = parseJunitXml(xml);
        expect(result).toEqual(emptySummary());
    });

    it('counts self-closing passing testcases', () => {
        const xml = `
            <testsuite name="MyTest" tests="2">
              <testcase name="testFoo" classname="com.example.MyTest" time="0.01"/>
              <testcase name="testBar" classname="com.example.MyTest" time="0.02"/>
            </testsuite>
        `;
        const result = parseJunitXml(xml);
        expect(result.totalTests).toBe(2);
        expect(result.passedTests).toBe(2);
        expect(result.failedTests).toBe(0);
    });

    it('extracts failure message attribute and records a failure entry', () => {
        const xml = `
            <testsuite name="MyTest">
              <testcase name="testBar" classname="com.example.MyTest" time="0.01">
                <failure message="expected:&lt;a&gt; but was:&lt;b&gt;" type="AssertionError">
                  stack trace
                </failure>
              </testcase>
            </testsuite>
        `;
        const result = parseJunitXml(xml);
        expect(result.totalTests).toBe(1);
        expect(result.failedTests).toBe(1);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].name).toBe('com.example.MyTest.testBar');
        expect(result.failures[0].message).toBe('expected:<a> but was:<b>');
    });

    it('derives failure message from first body line when message attribute is missing', () => {
        const xml = `
            <testsuite>
              <testcase name="t" classname="C">
                <failure>first error line\nmore detail\nstack</failure>
              </testcase>
            </testsuite>
        `;
        const result = parseJunitXml(xml);
        expect(result.failures[0].message).toBe('first error line');
    });

    it('treats <error> like <failure>', () => {
        const xml = `
            <testsuite>
              <testcase name="t" classname="C">
                <error message="NPE">stack</error>
              </testcase>
            </testsuite>
        `;
        const result = parseJunitXml(xml);
        expect(result.failedTests).toBe(1);
        expect(result.failures[0].message).toBe('NPE');
    });

    it('counts <skipped> testcases as skipped, not passed or failed', () => {
        const xml = `
            <testsuite>
              <testcase name="ignored" classname="C">
                <skipped/>
              </testcase>
              <testcase name="ran" classname="C"/>
            </testsuite>
        `;
        const result = parseJunitXml(xml);
        expect(result.totalTests).toBe(2);
        expect(result.passedTests).toBe(1);
        expect(result.skippedTests).toBe(1);
        expect(result.failedTests).toBe(0);
    });

    it('parses multiple testsuites in one document', () => {
        const xml = `
            <testsuites>
              <testsuite name="A">
                <testcase name="t1" classname="A"/>
              </testsuite>
              <testsuite name="B">
                <testcase name="t2" classname="B">
                  <failure message="nope"/>
                </testcase>
              </testsuite>
            </testsuites>
        `;
        const result = parseJunitXml(xml);
        expect(result.totalTests).toBe(2);
        expect(result.passedTests).toBe(1);
        expect(result.failedTests).toBe(1);
    });
});

describe('mergeSummaries()', () => {
    it('sums counts and concatenates failures', () => {
        const a = {
            totalTests: 2,
            passedTests: 1,
            failedTests: 1,
            skippedTests: 0,
            failures: [{ name: 'a/test1', message: 'x' }],
        };
        const b = {
            totalTests: 3,
            passedTests: 2,
            failedTests: 0,
            skippedTests: 1,
            failures: [],
        };
        const merged = mergeSummaries(a, b);
        expect(merged).toEqual({
            totalTests: 5,
            passedTests: 3,
            failedTests: 1,
            skippedTests: 1,
            failures: [{ name: 'a/test1', message: 'x' }],
        });
    });
});

describe('parseJunitReportDir()', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'junit-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns zeroed summary when the directory does not exist', async () => {
        const result = await parseJunitReportDir(path.join(tmpDir, 'nope'));
        expect(result).toEqual(emptySummary());
    });

    it('merges every XML file under the directory (recursively)', async () => {
        const nested = path.join(tmpDir, 'nested');
        await fs.mkdir(nested);
        await fs.writeFile(
            path.join(tmpDir, 'a.xml'),
            '<testsuite><testcase name="t1" classname="A"/></testsuite>',
        );
        await fs.writeFile(
            path.join(nested, 'b.xml'),
            '<testsuite><testcase name="t2" classname="B"><failure message="no"/></testcase></testsuite>',
        );
        const result = await parseJunitReportDir(tmpDir);
        expect(result.totalTests).toBe(2);
        expect(result.passedTests).toBe(1);
        expect(result.failedTests).toBe(1);
    });

    it('ignores non-XML files', async () => {
        await fs.writeFile(path.join(tmpDir, 'junk.txt'), 'not xml');
        await fs.writeFile(
            path.join(tmpDir, 'real.xml'),
            '<testsuite><testcase name="t" classname="C"/></testsuite>',
        );
        const result = await parseJunitReportDir(tmpDir);
        expect(result.totalTests).toBe(1);
    });
});
