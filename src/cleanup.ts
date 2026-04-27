/**
 * Cleanup accumulator + runHandler wrapper.
 *
 * Pattern: register cleanup actions while building up state. On any throw /
 * abort / timeout, registered actions run in reverse order (LIFO), errors
 * swallowed and logged, then the original error is re-thrown. On success,
 * cleanups are NOT run — the caller is expected to forget() the ones whose
 * state they keep (or leave them registered if they want a finally-style
 * teardown).
 *
 * Zero new npm deps.
 */

export type CleanupAction = {
  name: string;
  run: () => Promise<void> | void;
};

export interface Cleanup {
  /** Latest registered runs first (LIFO). */
  add(name: string, run: () => Promise<void> | void): void;
  /** Drops a previously-registered action by name (success path). */
  forget(name: string): void;
  size(): number;
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

export interface RunHandlerOptions {
  timeoutMs?: number;
  /** For log lines and TimeoutError messages. */
  name: string;
}

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  readonly handlerName: string;
  constructor(name: string, ms: number) {
    super(`Handler "${name}" timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.handlerName = name;
    this.timeoutMs = ms;
  }
}

class CleanupImpl implements Cleanup {
  private readonly actions: CleanupAction[] = [];
  private readonly controller: AbortController;

  constructor() {
    this.controller = new AbortController();
  }

  add(name: string, run: () => Promise<void> | void): void {
    this.actions.push({ name, run });
  }

  forget(name: string): void {
    // Remove the most recently-added action with this name.
    for (let i = this.actions.length - 1; i >= 0; i--) {
      if (this.actions[i].name === name) {
        this.actions.splice(i, 1);
        return;
      }
    }
  }

  size(): number {
    return this.actions.length;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  /** Runs registered actions in reverse order, swallowing/logging errors. */
  async runAll(): Promise<void> {
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const action = this.actions[i];
      try {
        await action.run();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[Cleanup] ${action.name}: failed`, err);
      }
    }
    this.actions.length = 0;
  }
}

/**
 * On any throw / abort / timeout, registered actions run in reverse order,
 * errors swallowed and logged via console.error, then original error re-thrown.
 * On success, cleanups are NOT run — caller is expected to forget() the ones
 * whose state they keep.
 */
export async function runHandler<T>(
  opts: RunHandlerOptions,
  fn: (cleanup: Cleanup) => Promise<T>,
): Promise<T> {
  const cleanup = new CleanupImpl();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  // Watchdog: ensure that if fn ignores the signal on timeout, we still
  // begin the cleanup phase and reject with a TimeoutError.
  const timeoutRace = new Promise<never>((_, reject) => {
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const err = new TimeoutError(opts.name, opts.timeoutMs!);
        cleanup.abort(err);
        reject(err);
      }, opts.timeoutMs);
      // Don't keep the event loop alive purely for this timer.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }
  });

  try {
    const result = opts.timeoutMs && opts.timeoutMs > 0
      ? await Promise.race([fn(cleanup), timeoutRace])
      : await fn(cleanup);
    if (timer) clearTimeout(timer);
    // Success: do NOT run cleanups. Caller forgets what they want to keep.
    return result;
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (!timedOut) {
      // Make sure any inner work that respects the signal aborts too.
      cleanup.abort(err);
    }
    await cleanup.runAll();
    throw err;
  }
}
