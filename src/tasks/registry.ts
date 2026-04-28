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
export type TaskStatus =
    | 'pending'
    | 'running'
    | 'cancelling'
    | 'done'
    | 'failed'
    | 'cancelled';

const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_TASK_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_RETAINED_PER_KIND = 50;

function parseMaxRetained(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

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
    /**
     * Set when the task transitioned to cancelling/cancelled via cancel() or
     * watchdog timeout. Surfaces "watchdog timeout (Xms)" vs user-supplied
     * reason so agents can distinguish.
     */
    cancelReason?: string;
}

export type TaskRunner<TResult> = (ctx: TaskContext) => Promise<TResult>;

export interface RegisterOptions {
    kind: TaskKind;
    timeoutMs?: number;
    ringBuffer?: { maxLines?: number; maxBytes?: number };
    /**
     * Per-kind retention cap for finished tasks. Newest finished evicts oldest
     * finished when count exceeds the cap. Running/cancelling/pending tasks
     * are NEVER evicted. Default: env MCA_TASK_MAX_RETAINED or 50.
     */
    maxRetained?: number;
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
    _watchdog?: NodeJS.Timeout;
}

class TaskRegistryImpl implements TaskRegistry {
    private readonly tasks = new Map<string, InternalTask>();
    private pruneTimer?: NodeJS.Timeout;
    private readonly capWarnedKinds = new Set<TaskKind>();

    /**
     * Evict oldest *terminal* tasks of the given kind until count <= cap.
     * Terminal = status in {'done','failed','cancelled'}. Running/cancelling/
     * pending are skipped. If no terminal candidates exist while over cap,
     * log a one-shot warning per kind and return without eviction.
     *
     * Returns the number of tasks evicted.
     */
    private evictIfOverCap(kind: TaskKind, cap: number): number {
        const sameKind: InternalTask[] = [];
        for (const t of this.tasks.values()) {
            if (t.kind === kind) sameKind.push(t as InternalTask);
        }
        if (sameKind.length <= cap) return 0;

        const TERMINAL: TaskStatus[] = ['done', 'failed', 'cancelled'];
        const terminal = sameKind
            .filter((t) => TERMINAL.includes(t.status) && t.finishedAt)
            .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));

        const overBy = sameKind.length - cap;
        let evicted = 0;
        for (const t of terminal) {
            if (evicted >= overBy) break;
            this.tasks.delete(t.taskId);
            evicted += 1;
        }

        if (evicted > 0) {
            this.capWarnedKinds.delete(kind); // re-arm warning for future breaches
        } else if (!this.capWarnedKinds.has(kind)) {
            // eslint-disable-next-line no-console
            console.error(
                `[TaskRegistry] kind=${kind} cap=${cap} breached (${sameKind.length} tasks, all in-flight); accepting breach`,
            );
            this.capWarnedKinds.add(kind);
        }
        return evicted;
    }

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

        const cap = opts.maxRetained
            ?? parseMaxRetained(process.env.MCA_TASK_MAX_RETAINED)
            ?? DEFAULT_MAX_RETAINED_PER_KIND;
        this.evictIfOverCap(opts.kind, cap);

        // Install watchdog AFTER task is in the map (so cancel() during the
        // timer can find it) but BEFORE queueMicrotask (so the runner sees an
        // already-armed controller if the timer somehow fires synchronously).
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            const ms = opts.timeoutMs;
            task._watchdog = setTimeout(() => {
                // Mirrors cancel() but with a watchdog-specific reason. Only
                // fires if task hasn't already settled.
                if (task.status !== 'running' && task.status !== 'pending') return;
                const reasonStr = `watchdog timeout (${ms}ms)`;
                const err = new Error(reasonStr);
                err.name = 'AbortError';
                task.cancelReason = reasonStr;
                task._cleanup.abort(err);
                if (!task._controller.signal.aborted) task._controller.abort(err);
                task.status = 'cancelling';
            }, ms);
            if (typeof task._watchdog.unref === 'function') task._watchdog.unref();
        }

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
            if (task._watchdog) {
                clearTimeout(task._watchdog);
                task._watchdog = undefined;
            }
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

        const reasonStr = reason ?? 'cancelled';
        const reasonErr = new Error(reasonStr);
        reasonErr.name = 'AbortError';
        task.cancelReason = reasonStr;
        task._cleanup.abort(reasonErr);
        if (!task._controller.signal.aborted) {
            task._controller.abort(reasonErr);
        }
        // Synchronously visible to the next read. The runner's terminal
        // settlement in execute() flips this to 'cancelled' (or 'failed' if
        // the runner threw a non-abort error after we signaled).
        task.status = 'cancelling';
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
            if (t._watchdog) {
                clearTimeout(t._watchdog);
                t._watchdog = undefined;
            }
            if (
                t.status === 'running' ||
                t.status === 'pending' ||
                t.status === 'cancelling'
            ) {
                try {
                    t._cleanup.abort(new Error('test reset'));
                    t._controller.abort(new Error('test reset'));
                } catch {
                    // ignore
                }
            }
        }
        this.tasks.clear();
        this.capWarnedKinds.clear();
        this.stopPruneTimer();
    }
}

function parseTtl(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const taskRegistry: TaskRegistry = new TaskRegistryImpl();
