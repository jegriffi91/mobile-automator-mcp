import { describe, it, expect, afterEach } from 'vitest';
import { taskRegistry } from './registry.js';

afterEach(() => {
    taskRegistry._clearForTests();
});

function nextTick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('TaskRegistry', () => {
    it('runs a runner that returns a value (status=done, result set)', async () => {
        const task = await taskRegistry.run({ kind: 'build' }, async () => ({ ok: true, value: 42 }));
        expect(task.status).toBe('done');
        expect(task.result).toEqual({ ok: true, value: 42 });
        expect(task.finishedAt).toBeDefined();
        expect(task.durationMs()).toBeGreaterThanOrEqual(0);
    });

    it('start() returns synchronously with status=running', async () => {
        const task = taskRegistry.start({ kind: 'build' }, async () => {
            await new Promise((r) => setTimeout(r, 5));
            return 'done';
        });
        expect(task.status).toBe('running');
        expect(task.taskId).toMatch(/^[0-9a-f-]{36}$/);
        // Drain
        await taskRegistry.get(task.taskId);
        await new Promise((r) => setTimeout(r, 20));
        expect(taskRegistry.get(task.taskId)?.status).toBe('done');
    });

    it('failed runner: status=failed, error set, cleanups ran', async () => {
        let cleanupRan = false;
        const task = await taskRegistry.run({ kind: 'build' }, async (ctx) => {
            ctx.cleanup.add('test-cleanup', () => {
                cleanupRan = true;
            });
            throw new Error('boom');
        });
        expect(task.status).toBe('failed');
        expect(task.error).toBe('boom');
        expect(cleanupRan).toBe(true);
    });

    it('runner that throws AbortError after signal aborted: status=cancelled', async () => {
        const task = taskRegistry.start({ kind: 'build' }, async (ctx) => {
            await new Promise((resolve, reject) => {
                ctx.signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        // Cancel immediately
        await Promise.resolve();
        const ok = taskRegistry.cancel(task.taskId, 'user-cancel');
        expect(ok).toBe(true);
        // Wait for terminal
        for (let i = 0; i < 50; i++) {
            if (task.status !== 'running') break;
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(task.status).toBe('cancelled');
        expect(task.error).toBe('user-cancel');
    });

    it('cancel(): triggers cleanup, status flips to cancelled', async () => {
        let cleanupRan = false;
        const task = taskRegistry.start({ kind: 'build' }, async (ctx) => {
            ctx.cleanup.add('test', () => {
                cleanupRan = true;
            });
            await new Promise((resolve, reject) => {
                ctx.signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        await Promise.resolve();
        expect(taskRegistry.cancel(task.taskId)).toBe(true);
        for (let i = 0; i < 50; i++) {
            if (task.status !== 'running') break;
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(task.status).toBe('cancelled');
        expect(cleanupRan).toBe(true);
    });

    it('cancellation wins over runner success when runner ignores abort signal', async () => {
        // Runner that ignores ctx.signal entirely and returns a value.
        const task = taskRegistry.start({ kind: 'build' }, async () => {
            await new Promise((r) => setTimeout(r, 20));
            return 42;
        });
        await Promise.resolve();
        expect(taskRegistry.cancel(task.taskId, 'user-cancel')).toBe(true);
        // Wait for terminal
        for (let i = 0; i < 50; i++) {
            if (task.status !== 'running' && task.status !== 'cancelling') break;
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(task.status).toBe('cancelled');
        expect(task.result).toBeUndefined();
        expect(task.error).toMatch(/cancelled/);
    });

    it('cancel() on terminal task returns false', async () => {
        const task = await taskRegistry.run({ kind: 'build' }, async () => 'done');
        expect(taskRegistry.cancel(task.taskId)).toBe(false);
    });

    it('cancel() on unknown id returns false', () => {
        expect(taskRegistry.cancel('00000000-0000-0000-0000-000000000000')).toBe(false);
    });

    it('prune(0) removes finished tasks', async () => {
        const task = await taskRegistry.run({ kind: 'build' }, async () => 'done');
        expect(taskRegistry.get(task.taskId)).toBeDefined();
        await new Promise((r) => setTimeout(r, 5));
        const removed = taskRegistry.prune(0);
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(taskRegistry.get(task.taskId)).toBeUndefined();
    });

    it('prune does not remove still-running tasks', async () => {
        const task = taskRegistry.start({ kind: 'build' }, async (ctx) => {
            await new Promise((resolve) => {
                ctx.signal.addEventListener('abort', () => resolve(undefined));
            });
            return 'cancelled';
        });
        await nextTick();
        expect(taskRegistry.prune(0)).toBe(0);
        expect(taskRegistry.get(task.taskId)).toBeDefined();
        // Cleanup
        taskRegistry.cancel(task.taskId);
    });

    it('list({kind}) filters by kind', async () => {
        await taskRegistry.run({ kind: 'build' }, async () => 'a');
        await taskRegistry.run({ kind: 'unit_tests' }, async () => 'b');
        const builds = taskRegistry.list({ kind: 'build' });
        expect(builds).toHaveLength(1);
        expect(builds[0].kind).toBe('build');
    });

    it('list({status}) filters by status (single + array)', async () => {
        await taskRegistry.run({ kind: 'build' }, async () => 'ok');
        await taskRegistry.run({ kind: 'build' }, async () => {
            throw new Error('x');
        });
        expect(taskRegistry.list({ status: 'done' })).toHaveLength(1);
        expect(taskRegistry.list({ status: ['done', 'failed'] })).toHaveLength(2);
    });

    it('recentOutputLines reflects appendLine calls', async () => {
        const task = await taskRegistry.run({ kind: 'build' }, async (ctx) => {
            ctx.appendLine('hello');
            ctx.appendLine('world', 'stderr');
            return 'ok';
        });
        expect(task.recentOutputLines()).toEqual(['hello', 'world']);
        expect(task.lineCount()).toBe(2);
    });

    it('recentOutputLines visible mid-flight (before terminal)', async () => {
        let resolveDone: () => void = () => undefined;
        const done = new Promise<void>((r) => {
            resolveDone = r;
        });
        const task = taskRegistry.start({ kind: 'build' }, async (ctx) => {
            ctx.appendLine('first');
            await new Promise((r) => setTimeout(r, 10));
            ctx.appendLine('second');
            await done;
            return 'ok';
        });
        await new Promise((r) => setTimeout(r, 30));
        expect(task.recentOutputLines()).toContain('first');
        expect(task.recentOutputLines()).toContain('second');
        expect(task.status).toBe('running');
        resolveDone();
        // drain
        for (let i = 0; i < 50; i++) {
            if (task.status !== 'running') break;
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(task.status).toBe('done');
    });
});
