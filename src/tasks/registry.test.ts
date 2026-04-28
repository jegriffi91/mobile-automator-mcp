import { describe, it, expect, afterEach, vi } from 'vitest';
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
        // Wait for terminal (cancel() flips to 'cancelling' first; runner
        // settles into 'cancelled').
        for (let i = 0; i < 50; i++) {
            if (task.status !== 'running' && task.status !== 'cancelling') break;
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
            if (task.status !== 'running' && task.status !== 'cancelling') break;
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

    it("cancel() sets status='cancelling' synchronously (before runner settles)", async () => {
        const task = taskRegistry.start({ kind: 'build' }, async (ctx) => {
            await new Promise((resolve, reject) => {
                ctx.signal.addEventListener('abort', () => {
                    // Defer the rejection so the synchronous post-cancel read
                    // sees 'cancelling' before execute() flips it to 'cancelled'.
                    setTimeout(() => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                    }, 20);
                });
            });
        });
        await Promise.resolve();
        expect(taskRegistry.cancel(task.taskId)).toBe(true);
        // No await — must be visible synchronously.
        expect(task.status).toBe('cancelling');
        // Eventually flips to terminal.
        for (let i = 0; i < 50; i++) {
            if (task.status === 'cancelled') break;
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(task.status).toBe('cancelled');
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

    describe('per-kind retention cap', () => {
        async function waitTerminal(task: { status: string }): Promise<void> {
            for (let i = 0; i < 200; i++) {
                if (task.status !== 'running' && task.status !== 'pending' && task.status !== 'cancelling') return;
                await new Promise((r) => setTimeout(r, 5));
            }
        }

        it('evicts oldest finished task of same kind when cap exceeded', async () => {
            const t1 = await taskRegistry.run({ kind: 'build', maxRetained: 3 }, async () => 'a');
            const t2 = await taskRegistry.run({ kind: 'build', maxRetained: 3 }, async () => 'b');
            const t3 = await taskRegistry.run({ kind: 'build', maxRetained: 3 }, async () => 'c');
            // 4th should evict t1 (oldest finished).
            const t4 = await taskRegistry.run({ kind: 'build', maxRetained: 3 }, async () => 'd');

            const builds = taskRegistry.list({ kind: 'build' });
            expect(builds).toHaveLength(3);
            expect(taskRegistry.get(t1.taskId)).toBeUndefined();
            expect(taskRegistry.get(t2.taskId)).toBeDefined();
            expect(taskRegistry.get(t3.taskId)).toBeDefined();
            expect(taskRegistry.get(t4.taskId)).toBeDefined();
        });

        it('never evicts running tasks; logs a one-shot warning when cap breached', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            try {
                // Three runners that wait forever (until aborted).
                const runners = [0, 1, 2].map(() =>
                    taskRegistry.start({ kind: 'build', maxRetained: 3 }, async (ctx) => {
                        await new Promise<void>((_, reject) => {
                            ctx.signal.addEventListener('abort', () => {
                                const e = new Error('aborted');
                                e.name = 'AbortError';
                                reject(e);
                            });
                        });
                        return 'never';
                    }),
                );
                // Allow them all to reach 'running'.
                await new Promise((r) => setTimeout(r, 10));

                // 4th breaches the cap; nothing terminal to evict.
                const t4 = taskRegistry.start({ kind: 'build', maxRetained: 3 }, async (ctx) => {
                    await new Promise<void>((_, reject) => {
                        ctx.signal.addEventListener('abort', () => {
                            const e = new Error('aborted');
                            e.name = 'AbortError';
                            reject(e);
                        });
                    });
                    return 'never';
                });

                // All 4 should still be present (nothing evicted).
                expect(taskRegistry.list({ kind: 'build' })).toHaveLength(4);
                for (const t of runners) {
                    expect(taskRegistry.get(t.taskId)).toBeDefined();
                }
                expect(taskRegistry.get(t4.taskId)).toBeDefined();

                // Warning logged exactly once.
                const warnCalls = errSpy.mock.calls.filter((c) =>
                    typeof c[0] === 'string' && (c[0] as string).includes('cap=3 breached'),
                );
                expect(warnCalls).toHaveLength(1);
            } finally {
                errSpy.mockRestore();
            }
        });

        it('per-kind isolation: evicting build kind does not touch unit_tests', async () => {
            const builds = [];
            for (let i = 0; i < 3; i++) {
                builds.push(await taskRegistry.run({ kind: 'build', maxRetained: 3 }, async () => `b${i}`));
            }
            const tests = [];
            for (let i = 0; i < 3; i++) {
                tests.push(
                    await taskRegistry.run({ kind: 'unit_tests', maxRetained: 3 }, async () => `t${i}`),
                );
            }

            // Force eviction in build kind by adding a 4th build.
            await taskRegistry.run({ kind: 'build', maxRetained: 3 }, async () => 'b4');

            const buildList = taskRegistry.list({ kind: 'build' });
            const testList = taskRegistry.list({ kind: 'unit_tests' });
            expect(buildList).toHaveLength(3);
            expect(testList).toHaveLength(3);
            // Oldest build evicted.
            expect(taskRegistry.get(builds[0].taskId)).toBeUndefined();
            // All unit_tests intact.
            for (const t of tests) {
                expect(taskRegistry.get(t.taskId)).toBeDefined();
            }
        });

        it('warning latch resets after a successful eviction', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            try {
                // Helper: spawn a runner that blocks on abort.
                const blocking = () =>
                    taskRegistry.start({ kind: 'build', maxRetained: 2 }, async (ctx) => {
                        await new Promise<void>((_, reject) => {
                            ctx.signal.addEventListener('abort', () => {
                                const e = new Error('aborted');
                                e.name = 'AbortError';
                                reject(e);
                            });
                        });
                        return 'x';
                    });

                // Phase A: fill cap=2 with two running tasks, then a 3rd ->
                // breach + warn (count #1).
                const a = blocking();
                const b = blocking();
                await new Promise((r) => setTimeout(r, 10));
                blocking(); // 3rd task — cap breached, all running -> warns.

                let warnCount = errSpy.mock.calls.filter((c) =>
                    typeof c[0] === 'string' && (c[0] as string).includes('cap=2 breached'),
                ).length;
                expect(warnCount).toBe(1);

                // Phase B: let one of the running tasks settle to terminal so
                // a future breach can evict.
                taskRegistry.cancel(a.taskId);
                await waitTerminal(a);

                // Now start a 4th — this evicts terminal task `a`. Latch resets.
                blocking();
                expect(taskRegistry.get(a.taskId)).toBeUndefined();
                // No new warning emitted (eviction succeeded).
                warnCount = errSpy.mock.calls.filter((c) =>
                    typeof c[0] === 'string' && (c[0] as string).includes('cap=2 breached'),
                ).length;
                expect(warnCount).toBe(1);

                // Phase C: cancel another -> let it settle -> back to all running
                // by adding more. Actually simpler: with latch reset, breach again
                // while everyone is still running should re-warn.
                // Cancel `b` to terminal then evict it via a 5th task.
                taskRegistry.cancel(b.taskId);
                await waitTerminal(b);
                blocking(); // evicts `b` cleanly — no warn.

                // Now the registry has 3 running tasks at cap=2. Spawning another
                // breaches with no terminal candidates -> warning re-arms and fires.
                blocking();
                warnCount = errSpy.mock.calls.filter((c) =>
                    typeof c[0] === 'string' && (c[0] as string).includes('cap=2 breached'),
                ).length;
                expect(warnCount).toBe(2);
            } finally {
                errSpy.mockRestore();
            }
        });

        it('env-var MCA_TASK_MAX_RETAINED overrides the default', async () => {
            const prev = process.env.MCA_TASK_MAX_RETAINED;
            process.env.MCA_TASK_MAX_RETAINED = '2';
            try {
                for (let i = 0; i < 4; i++) {
                    await taskRegistry.run({ kind: 'build' }, async () => `v${i}`);
                }
                expect(taskRegistry.list({ kind: 'build' })).toHaveLength(2);
            } finally {
                if (prev === undefined) delete process.env.MCA_TASK_MAX_RETAINED;
                else process.env.MCA_TASK_MAX_RETAINED = prev;
            }
        });
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
