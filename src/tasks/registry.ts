/**
 * In-process registry for long-running async tasks.
 *
 * Bypasses the MCP transport timeout (~5 min) by returning a taskId
 * immediately and letting agents poll for status. Tasks live in memory only —
 * server restart loses in-flight tasks. Auto-prunes finished tasks after a TTL.
 *
 * Designed to be generalizable: `kind: 'build' | 'unit_tests' | 'recording'`.
 * Phase 2 wires `start_build` to this; Phase 2.5 will add `run_unit_tests`.
 */

import { randomUUID } from 'crypto';
import { CleanupImpl, type Cleanup } from '../cleanup.js';
import { RingBuffer } from './ring-buffer.js';

export type TaskKind = 'build' | 'unit_tests' | 'recording';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_TASK_TTL_MS = 60 * 60 * 1000; // 1h

export interface TaskContext {
    readonly signal: AbortSignal;
    readonly cleanup: Cleanup;
    appendLine(line: string, stream?: 'stdout' | 'stderr'): void;
}

export interface Task<TResult = unknown> {
    readonly taskId: string;
    readonly kind: TaskKind;
    status: TaskStatus;
    readonly startedAt: string;
    finishedAt?: string;
    durationMs(): number;
    recentOutputLines(maxTail?: number): string[];
    lineCount(): number;
    result?: TResult;
    error?: string;
}

export type TaskRunner<TResult> = (ctx: TaskContext) => Promise<TResult>;

export interface RegisterOptions {
    kind: TaskKind;
    timeoutMs?: number;
    ringBuffer?: { maxLines?: number; maxBytes?: number };
}

export interface ListTasksFilter {
    kind?: TaskKind;
    status?: TaskStatus | TaskStatus[];
    since?: string;
}

export interface TaskRegistry {
    /** Schedule a runner; returns the Task immediately with status='running'. */
    start<TResult>(opts: RegisterOptions, run: TaskRunner<TResult>): Task<TResult>;
    /** Schedule + await terminal state; resolves with the same Task. */
    run<TResult>(opts: RegisterOptions, run: TaskRunner<TResult>): Promise<Task<TResult>>;
    get<TResult = unknown>(taskId: string): Task<TResult> | undefined;
    list(filter?: ListTasksFilter): Task[];
    cancel(taskId: string, reason?: string): boolean;
    prune(olderThanMs: number): number;
    /** Start the periodic prune timer. Production callers invoke this once at boot. */
    startPruneTimer(): void;
    stopPruneTimer(): void;
    _clearForTests(): void;
}

interface InternalTask<TResult = unknown> extends Task<TResult> {
    _controller: AbortController;
    _cleanup: CleanupImpl;
    _buffer: RingBuffer;
    _settle: () => void;
    _terminalPromise: Promise<void>;
}

class TaskRegistryImpl implements TaskRegistry {
    private readonly tasks = new Map<string, InternalTask>();
    private pruneTimer?: NodeJS.Timeout;

    start<TResult>(opts: RegisterOptions, run: TaskRunner<TResult>): Task<TResult> {
        const taskId = randomUUID();
        const startedAt = new Date().toISOString();
        const controller = new AbortController();
        const cleanup = new CleanupImpl();
        const buffer = new RingBuffer(opts.ringBuffer);

        // Mirror cleanup.signal abort onto our controller (and vice versa).
        // The runner reads ctx.signal which is controller.signal; cancel() flips
        // both via cleanup.abort() then controller.abort().
        const onCleanupAbort = () => {
            if (!controller.signal.aborted) {
                controller.abort(cleanup.signal.reason);
            }
        };
        if (cleanup.signal.aborted) onCleanupAbort();
        else cleanup.signal.addEventListener('abort', onCleanupAbort, { once: true });

        let settle: () => void = () => undefined;
        const terminalPromise = new Promise<void>((resolve) => {
            settle = resolve;
        });

        const task: InternalTask<TResult> = {
            taskId,
            kind: opts.kind,
            status: 'running',
            startedAt,
            durationMs() {
                const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
                return end - Date.parse(startedAt);
            },
            recentOutputLines(maxTail?: number) {
                return buffer.snapshot(maxTail);
            },
            lineCount() {
                return buffer.totalPushed();
            },
            _controller: controller,
            _cleanup: cleanup,
            _buffer: buffer,
            _settle: () => settle(),
            _terminalPromise: terminalPromise,
        };

        this.tasks.set(taskId, task as InternalTask);

        const ctx: TaskContext = {
            signal: controller.signal,
            cleanup,
            appendLine: (line: string, _stream?: 'stdout' | 'stderr') => {
                buffer.push(line);
            },
        };

        // Schedule on a microtask so callers see status='running' synchronously.
        queueMicrotask(() => {
            // Fire-and-track: the body's promise lifecycle is handled here.
            this.execute(task as InternalTask<TResult>, run, ctx);
        });

        return task;
    }

    private async execute<TResult>(
        task: InternalTask<TResult>,
        run: TaskRunner<TResult>,
        ctx: TaskContext,
    ): Promise<void> {
        try {
            const result = await run(ctx);
            if (task._controller.signal.aborted) {
                // Cancellation was requested but the runner ignored the abort
                // signal and returned a value anyway. Preserve the cancellation
                // intent — don't surface result, matching failure-path semantics.
                task.status = 'cancelled';
                task.error = 'cancelled (runner returned after abort signaled)';
            } else {
                task.result = result;
                task.status = 'done';
            }
        } catch (err) {
            // Run cleanups on any error.
            try {
                await task._cleanup.runAll();
            } catch {
                // already swallowed inside runAll
            }
            const aborted =
                task._controller.signal.aborted ||
                (err instanceof Error && err.name === 'AbortError');
            if (aborted) {
                task.status = 'cancelled';
                const reason = task._controller.signal.reason;
                if (reason instanceof Error) {
                    task.error = reason.message;
                } else if (typeof reason === 'string') {
                    task.error = reason;
                } else if (err instanceof Error) {
                    task.error = err.message;
                }
            } else {
                task.status = 'failed';
                task.error = err instanceof Error ? err.message : String(err);
            }
        } finally {
            task.finishedAt = new Date().toISOString();
            task._settle();
        }
    }

    async run<TResult>(
        opts: RegisterOptions,
        run: TaskRunner<TResult>,
    ): Promise<Task<TResult>> {
        const task = this.start(opts, run) as InternalTask<TResult>;
        await task._terminalPromise;
        return task;
    }

    get<TResult = unknown>(taskId: string): Task<TResult> | undefined {
        return this.tasks.get(taskId) as Task<TResult> | undefined;
    }

    list(filter?: ListTasksFilter): Task[] {
        const all = Array.from(this.tasks.values());
        if (!filter) return all;

        const statusFilter = filter.status
            ? Array.isArray(filter.status)
                ? filter.status
                : [filter.status]
            : undefined;
        const sinceMs = filter.since ? Date.parse(filter.since) : undefined;

        return all.filter((t) => {
            if (filter.kind && t.kind !== filter.kind) return false;
            if (statusFilter && !statusFilter.includes(t.status)) return false;
            if (sinceMs !== undefined && Date.parse(t.startedAt) < sinceMs) return false;
            return true;
        });
    }

    cancel(taskId: string, reason?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        if (task.status !== 'running' && task.status !== 'pending') return false;

        const reasonErr = new Error(reason ?? 'cancelled');
        reasonErr.name = 'AbortError';
        task._cleanup.abort(reasonErr);
        if (!task._controller.signal.aborted) {
            task._controller.abort(reasonErr);
        }
        return true;
    }

    prune(olderThanMs: number): number {
        const cutoff = Date.now() - olderThanMs;
        let removed = 0;
        for (const [id, t] of this.tasks) {
            if (t.finishedAt && Date.parse(t.finishedAt) < cutoff) {
                this.tasks.delete(id);
                removed += 1;
            }
        }
        return removed;
    }

    startPruneTimer(): void {
        if (this.pruneTimer) return;
        const ttl = parseTtl(process.env.MCA_TASK_TTL_MS) ?? DEFAULT_TASK_TTL_MS;
        this.pruneTimer = setInterval(() => {
            try {
                this.prune(ttl);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error('[TaskRegistry] prune failed', err);
            }
        }, DEFAULT_PRUNE_INTERVAL_MS);
        if (typeof this.pruneTimer.unref === 'function') {
            this.pruneTimer.unref();
        }
    }

    stopPruneTimer(): void {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = undefined;
        }
    }

    _clearForTests(): void {
        // Abort any outstanding tasks so background promises settle cleanly.
        for (const t of this.tasks.values()) {
            if (t.status === 'running' || t.status === 'pending') {
                try {
                    t._cleanup.abort(new Error('test reset'));
                    t._controller.abort(new Error('test reset'));
                } catch {
                    // ignore
                }
            }
        }
        this.tasks.clear();
        this.stopPruneTimer();
    }
}

function parseTtl(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const taskRegistry: TaskRegistry = new TaskRegistryImpl();
