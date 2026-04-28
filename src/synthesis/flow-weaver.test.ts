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
import { parseMaestroDebugOutput } from './flow-weaver.js';

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
