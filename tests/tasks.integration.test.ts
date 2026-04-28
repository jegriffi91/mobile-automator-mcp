/**
 * Integration tests for the task-lifecycle handlers (Phase 2).
 *
 * Exercises taskRegistry directly through the handlers — no MCP transport,
 * no real builds. Stub runners simulate iOS/Android build behaviors.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    handlePollTaskStatus,
    handleGetTaskResult,
    handleCancelTask,
    handleListTasks,
    handleStartBuild,
    _setCancelDeadlineMsForTests,
} from '../src/handlers.js';
import { taskRegistry } from '../src/tasks/registry.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

afterEach(() => {
    taskRegistry._clearForTests();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('Task lifecycle integration', () => {
    it('happy path: stub runner resolves; poll → done; get_task_result returns payload', async () => {
        // Schedule a stub task via the registry directly (start_build would
        // shell xcodebuild). The registry is the unit under test for the
        // handler chain.
        const task = taskRegistry.start({ kind: 'build' }, async () => ({
            passed: true,
            platform: 'ios' as const,
            appPath: '/tmp/X.app',
            durationMs: 10,
            output: 'BUILD SUCCEEDED',
        }));

        // Drain to terminal.
        await waitFor(() => task.status !== 'running');

        const polled = await handlePollTaskStatus({ taskId: task.taskId });
        expect(polled.status).toBe('done');
        expect(polled.taskId).toBe(task.taskId);
        expect(polled.notFound).toBeUndefined();

        const got = await handleGetTaskResult({ taskId: task.taskId });
        expect(got.status).toBe('done');
        expect(got.result?.kind).toBe('build');
        if (got.result?.kind === 'build') {
            expect(got.result.build.passed).toBe(true);
            expect(got.result.build.output).toBe('BUILD SUCCEEDED');
        }
    });

    it('cancel path: long-running stub runner cancels and runs cleanup', async () => {
        let cleanupRan = false;
        const task = taskRegistry.start({ kind: 'build' }, async (ctx) => {
            ctx.cleanup.add('test-cleanup', () => {
                cleanupRan = true;
            });
            await new Promise<void>((_, reject) => {
                ctx.signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
            return { dummy: true };
        });

        // Let the runner reach its await point.
        await new Promise((r) => setTimeout(r, 10));

        const cancelled = await handleCancelTask({
            taskId: task.taskId,
            reason: 'integration test',
        });
        expect(cancelled.cancelled).toBe(true);
        expect(cancelled.previousStatus).toBe('running');
        expect(cancelled.finalStatus).toBe('cancelled');
        expect(cleanupRan).toBe(true);
    });

    it('streaming visibility: appendLine output reflected in poll mid-flight', async () => {
        let resumeRunner: () => void = () => undefined;
        const gate = new Promise<void>((r) => {
            resumeRunner = r;
        });
        const task = taskRegistry.start({ kind: 'build' }, async (ctx) => {
            ctx.appendLine('compiling Foo.swift');
            ctx.appendLine('compiling Bar.swift', 'stderr');
            await gate;
            return { passed: true };
        });

        // Wait for output to be appended.
        await waitFor(() => task.lineCount() >= 2);

        const polled = await handlePollTaskStatus({ taskId: task.taskId });
        expect(polled.status).toBe('running');
        expect(polled.recentOutputLines).toContain('compiling Foo.swift');
        expect(polled.recentOutputLines).toContain('compiling Bar.swift');
        expect(polled.lineCount).toBe(2);

        resumeRunner();
        await waitFor(() => task.status === 'done');
    });

    it('notFound: poll/get_task_result/cancel on unknown UUID returns structured response', async () => {
        const polled = await handlePollTaskStatus({ taskId: VALID_UUID });
        // Use toEqual so absence of `kind` and `startedAt` is verified — those
        // fields would be lies (we don't know the kind, and there is no start).
        expect(polled).toEqual({
            taskId: VALID_UUID,
            status: 'failed',
            durationMs: 0,
            recentOutputLines: [],
            lineCount: 0,
            notFound: true,
        });
        expect(polled).not.toHaveProperty('kind');
        expect(polled).not.toHaveProperty('startedAt');

        const got = await handleGetTaskResult({ taskId: VALID_UUID });
        expect(got.notFound).toBe(true);
        expect(got.error).toMatch(/not found/i);

        const cancelled = await handleCancelTask({ taskId: VALID_UUID });
        expect(cancelled.cancelled).toBe(false);
        expect(cancelled.notFound).toBe(true);
    });

    it('list_tasks reflects registered tasks with filters', async () => {
        await taskRegistry.run({ kind: 'build' }, async () => 'a');
        await taskRegistry.run({ kind: 'build' }, async () => {
            throw new Error('intentional');
        });

        const all = await handleListTasks({});
        expect(all.totalTasks).toBe(2);

        const builds = await handleListTasks({ kind: 'build' });
        expect(builds.totalTasks).toBe(2);

        const onlyDone = await handleListTasks({ status: 'done' });
        expect(onlyDone.totalTasks).toBe(1);
        expect(onlyDone.tasks[0].status).toBe('done');

        const doneOrFailed = await handleListTasks({ status: ['done', 'failed'] });
        expect(doneOrFailed.totalTasks).toBe(2);
    });

    it("handleCancelTask returns finalStatus='cancelling' when runner ignores abort beyond deadline", async () => {
        // Shrink the deadline so the test is fast (default is 10s).
        const prev = _setCancelDeadlineMsForTests(100);
        try {
            // Runner that completely ignores ctx.signal — settles long after
            // the cancel deadline elapses. The runner is intentionally slow
            // (300ms vs 100ms deadline) so the busy-poll exits while status
            // is still 'cancelling'.
            const task = taskRegistry.start({ kind: 'build' }, async () => {
                await new Promise((r) => setTimeout(r, 300));
                return { ignored: true };
            });
            await new Promise((r) => setTimeout(r, 5));

            const out = await handleCancelTask({ taskId: task.taskId });
            expect(out.cancelled).toBe(true);
            expect(out.previousStatus).toBe('running');
            // Deadline elapsed before runner settled — should report the
            // honest transient status, NOT 'running' (that would contradict
            // cancelled:true).
            expect(out.finalStatus).toBe('cancelling');

            // Runner eventually returns; fix #1 forces 'cancelled' since
            // the abort signal was already raised when it resolved.
            await waitFor(() => task.status === 'cancelled');
        } finally {
            _setCancelDeadlineMsForTests(prev);
        }
    });

    it('handleStartBuild rejects iOS input missing scheme but creates a failed task', async () => {
        // Routed through the registry: the runner throws synchronously inside
        // the validation, so the task ends up in `failed` (not surfaced as a
        // sync throw — start_build never throws after the schedule call).
        const out = await handleStartBuild({
            platform: 'ios',
            // scheme intentionally omitted
            workspacePath: '/nope/X.xcworkspace',
        });
        expect(out.kind).toBe('build');
        expect(out.status).toBe('running');

        // Wait for the runner to fail validation.
        await waitFor(() => {
            const t = taskRegistry.get(out.taskId);
            return !!t && t.status !== 'running';
        });
        const polled = await handlePollTaskStatus({ taskId: out.taskId });
        expect(polled.status).toBe('failed');
        expect(polled.error).toMatch(/scheme/);
    });
});
