/**
 * Phase 5 — parseMaestroDebugOutput tests.
 *
 * Verifies the parser is defensive: missing dirs, malformed JSON, and
 * unknown command shapes degrade rather than throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { parseMaestroDebugOutput, weaveFlowExecutions } from './flow-weaver.js';
import type { FlowStep } from './flow-weaver.js';
import type { FlowExecutionRecord } from '../types.js';
import type { PollRecord } from '../session/touch-inferrer.js';

const FIXTURE = path.join(
    process.cwd(),
    'tests',
    'fixtures',
    'maestro-debug',
    'sample-flow',
);

async function withTempDir<T>(
    fn: (dir: string) => Promise<T>,
): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-weaver-test-'));
    try {
        return await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

describe('parseMaestroDebugOutput', () => {
    it('parses the canonical 3-step fixture in chronological order', async () => {
        const steps = await parseMaestroDebugOutput(FIXTURE);
        expect(steps).toHaveLength(3);
        expect(steps[0].kind).toBe('tapOnElement');
        expect(steps[0].target).toBe('Login');
        expect(steps[0].status).toBe('COMPLETED');
        expect(steps[1].kind).toBe('inputText');
        expect(steps[1].target).toBe('test@example.com');
        expect(steps[2].kind).toBe('assertVisible');
        expect(steps[2].status).toBe('FAILED');
        expect(steps[2].error).toBe('Element not found');
    });

    it('returns an ISO timestamp converted from epoch ms', async () => {
        const steps = await parseMaestroDebugOutput(FIXTURE);
        expect(steps[0].timestamp).toBe(new Date(1746121231000).toISOString());
    });

    it('returns [] when the directory does not exist', async () => {
        const steps = await parseMaestroDebugOutput('/nonexistent/path-that-does-not-exist');
        expect(steps).toEqual([]);
    });

    it('returns [] when the directory is empty', async () => {
        await withTempDir(async (dir) => {
            const steps = await parseMaestroDebugOutput(dir);
            expect(steps).toEqual([]);
        });
    });

    it('skips a malformed JSON file but parses sibling files', async () => {
        await withTempDir(async (dir) => {
            await fs.writeFile(
                path.join(dir, 'commands-(broken.yaml).json'),
                'not-json',
                'utf-8',
            );
            await fs.writeFile(
                path.join(dir, 'commands-(good.yaml).json'),
                JSON.stringify([
                    {
                        command: { tapOnElementCommand: { selector: { text: 'Hi' } } },
                        metadata: {
                            status: 'COMPLETED',
                            timestamp: 1746121231000,
                            duration: 10,
                            sequenceNumber: 0,
                        },
                    },
                ]),
                'utf-8',
            );
            const steps = await parseMaestroDebugOutput(dir);
            expect(steps).toHaveLength(1);
            expect(steps[0].target).toBe('Hi');
        });
    });

    it('classifies an unknown command shape as kind="unknown" and preserves raw', async () => {
        await withTempDir(async (dir) => {
            const entry = {
                command: {},
                metadata: {
                    status: 'COMPLETED',
                    timestamp: 1746121231000,
                    duration: 5,
                    sequenceNumber: 0,
                },
            };
            await fs.writeFile(
                path.join(dir, 'commands-(weird.yaml).json'),
                JSON.stringify([entry]),
                'utf-8',
            );
            const steps = await parseMaestroDebugOutput(dir);
            expect(steps).toHaveLength(1);
            expect(steps[0].kind).toBe('unknown');
            expect(steps[0].raw).toEqual(entry);
        });
    });

    it('merges multiple commands-*.json files in chronological order', async () => {
        await withTempDir(async (dir) => {
            await fs.writeFile(
                path.join(dir, 'commands-(b.yaml).json'),
                JSON.stringify([
                    {
                        command: { tapOnElementCommand: { selector: { text: 'B' } } },
                        metadata: {
                            status: 'COMPLETED',
                            timestamp: 2000,
                            duration: 1,
                            sequenceNumber: 0,
                        },
                    },
                ]),
                'utf-8',
            );
            await fs.writeFile(
                path.join(dir, 'commands-(a.yaml).json'),
                JSON.stringify([
                    {
                        command: { tapOnElementCommand: { selector: { text: 'A' } } },
                        metadata: {
                            status: 'COMPLETED',
                            timestamp: 1000,
                            duration: 1,
                            sequenceNumber: 0,
                        },
                    },
                ]),
                'utf-8',
            );
            const steps = await parseMaestroDebugOutput(dir);
            expect(steps.map((s) => s.target)).toEqual(['A', 'B']);
        });
    });

    it('extracts an error message from a structured error object', async () => {
        await withTempDir(async (dir) => {
            await fs.writeFile(
                path.join(dir, 'commands-(err.yaml).json'),
                JSON.stringify([
                    {
                        command: { assertVisibleCommand: { selector: { text: 'X' } } },
                        metadata: {
                            status: 'FAILED',
                            timestamp: 1746121232000,
                            duration: 5000,
                            sequenceNumber: 0,
                            error: { message: 'Element not visible after 5000ms' },
                        },
                    },
                ]),
                'utf-8',
            );
            const steps = await parseMaestroDebugOutput(dir);
            expect(steps[0].error).toBe('Element not visible after 5000ms');
        });
    });

    it('ignores non-array JSON files (e.g. accidentally placed reports)', async () => {
        await withTempDir(async (dir) => {
            await fs.writeFile(
                path.join(dir, 'commands-(weird.yaml).json'),
                JSON.stringify({ not: 'an array' }),
                'utf-8',
            );
            const steps = await parseMaestroDebugOutput(dir);
            expect(steps).toEqual([]);
        });
    });
});

// Suppress noisy parse-failure stderr in CI logs.
const originalErr = console.error;
beforeEach(() => {
    console.error = () => {};
});
afterEach(() => {
    console.error = originalErr;
});

// ── weaveFlowExecutions ──

function boundary(
    boundaryKind: 'flow_start' | 'flow_end',
    flowName: string,
    timestamp: string,
): PollRecord {
    return {
        timestamp,
        durationMs: 0,
        result: 'flow_boundary',
        boundaryKind,
        inferredTarget: flowName,
    };
}

function pollOk(timestamp: string): PollRecord {
    return {
        timestamp,
        durationMs: 50,
        result: 'equal',
    };
}

function makeStep(seq: number, kind: string, target?: string): FlowStep {
    return {
        sequenceNumber: seq,
        timestamp: new Date(1746121231000 + seq * 100).toISOString(),
        kind,
        ...(target !== undefined ? { target } : {}),
        durationMs: 10,
        status: 'COMPLETED',
        raw: {},
    };
}

describe('weaveFlowExecutions', () => {
    it('zero flows → empty result, no warnings', () => {
        const result = weaveFlowExecutions({
            pollRecords: [pollOk('2026-04-28T10:00:00.000Z')],
            flowExecutions: [],
            parsedSteps: new Map(),
        });
        expect(result.woven).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.yamlBlocks).toEqual([]);
        expect(result.pollRecords).toHaveLength(1);
    });

    it('one matched flow → woven entry with steps; boundaries stripped', () => {
        const startedAt = '2026-04-28T10:00:00.000Z';
        const endedAt = '2026-04-28T10:00:05.000Z';
        const polls: PollRecord[] = [
            pollOk('2026-04-28T09:59:59.000Z'),
            boundary('flow_start', 'login', startedAt),
            boundary('flow_end', 'login', endedAt),
            pollOk('2026-04-28T10:00:06.000Z'),
        ];
        const exec: FlowExecutionRecord = {
            flowName: 'login',
            startedAt,
            endedAt,
            durationMs: 5000,
            output: '',
            succeeded: true,
            flowPath: '/abs/login.yaml',
        };
        const steps = [makeStep(0, 'tapOnElement', 'Login')];
        const result = weaveFlowExecutions({
            pollRecords: polls,
            flowExecutions: [exec],
            parsedSteps: new Map([[`login|${startedAt}`, steps]]),
        });
        expect(result.warnings).toEqual([]);
        expect(result.woven).toHaveLength(1);
        expect(result.woven[0].flowName).toBe('login');
        expect(result.woven[0].flowPath).toBe('/abs/login.yaml');
        expect(result.woven[0].steps).toHaveLength(1);
        expect(result.pollRecords.every((r) => r.result !== 'flow_boundary')).toBe(true);
        expect(result.yamlBlocks).toHaveLength(1);
        expect(result.yamlBlocks[0].flowName).toBe('login');
    });

    it('flow with missing parsedSteps → empty steps + warning', () => {
        const startedAt = '2026-04-28T10:00:00.000Z';
        const endedAt = '2026-04-28T10:00:05.000Z';
        const polls = [
            boundary('flow_start', 'login', startedAt),
            boundary('flow_end', 'login', endedAt),
        ];
        const exec: FlowExecutionRecord = {
            flowName: 'login',
            startedAt,
            endedAt,
            durationMs: 5000,
            output: '',
            succeeded: true,
        };
        const result = weaveFlowExecutions({
            pollRecords: polls,
            flowExecutions: [exec],
            parsedSteps: new Map(),
        });
        expect(result.woven).toHaveLength(1);
        expect(result.woven[0].steps).toEqual([]);
        expect(result.warnings.some((w) => w.includes('no parsed steps'))).toBe(true);
    });

    it('orphan flow_start → warning, no woven entry', () => {
        const result = weaveFlowExecutions({
            pollRecords: [boundary('flow_start', 'lonely', '2026-04-28T10:00:00.000Z')],
            flowExecutions: [],
            parsedSteps: new Map(),
        });
        expect(result.woven).toEqual([]);
        expect(result.warnings.some((w) => w.includes('orphan flow_start'))).toBe(true);
    });

    it('orphan flow_end → warning, no woven entry', () => {
        const result = weaveFlowExecutions({
            pollRecords: [boundary('flow_end', 'orphan', '2026-04-28T10:00:00.000Z')],
            flowExecutions: [],
            parsedSteps: new Map(),
        });
        expect(result.woven).toEqual([]);
        expect(result.warnings.some((w) => w.includes('orphan flow_end'))).toBe(true);
    });

    it('two flows → two woven entries in chronological order', () => {
        const t1Start = '2026-04-28T10:00:00.000Z';
        const t1End = '2026-04-28T10:00:01.000Z';
        const t2Start = '2026-04-28T10:00:05.000Z';
        const t2End = '2026-04-28T10:00:06.000Z';
        const polls = [
            boundary('flow_start', 'a', t1Start),
            boundary('flow_end', 'a', t1End),
            boundary('flow_start', 'b', t2Start),
            boundary('flow_end', 'b', t2End),
        ];
        const execs: FlowExecutionRecord[] = [
            {
                flowName: 'a',
                startedAt: t1Start,
                endedAt: t1End,
                durationMs: 1000,
                output: '',
                succeeded: true,
            },
            {
                flowName: 'b',
                startedAt: t2Start,
                endedAt: t2End,
                durationMs: 1000,
                output: '',
                succeeded: true,
            },
        ];
        const result = weaveFlowExecutions({
            pollRecords: polls,
            flowExecutions: execs,
            parsedSteps: new Map([
                [`a|${t1Start}`, [makeStep(0, 'tapOnElement', 'A')]],
                [`b|${t2Start}`, [makeStep(0, 'tapOnElement', 'B')]],
            ]),
        });
        expect(result.woven.map((w) => w.flowName)).toEqual(['a', 'b']);
    });

    it('cancelled flow → cancelled propagates to yaml block', () => {
        const startedAt = '2026-04-28T10:00:00.000Z';
        const endedAt = '2026-04-28T10:00:05.000Z';
        const polls = [
            boundary('flow_start', 'login', startedAt),
            boundary('flow_end', 'login', endedAt),
        ];
        const exec: FlowExecutionRecord = {
            flowName: 'login',
            startedAt,
            endedAt,
            durationMs: 5000,
            output: '',
            succeeded: false,
            cancelled: true,
        };
        const result = weaveFlowExecutions({
            pollRecords: polls,
            flowExecutions: [exec],
            parsedSteps: new Map([[`login|${startedAt}`, []]]),
        });
        expect(result.yamlBlocks[0].cancelled).toBe(true);
    });
});
