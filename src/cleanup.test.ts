import { describe, it, expect, vi } from 'vitest';
import { runHandler, TimeoutError } from './cleanup.js';

describe('runHandler / Cleanup', () => {
  it('runs cleanups in LIFO order on failure', async () => {
    const order: string[] = [];
    await expect(
      runHandler({ name: 'lifo' }, async (cleanup) => {
        cleanup.add('first', () => {
          order.push('first');
        });
        cleanup.add('second', () => {
          order.push('second');
        });
        cleanup.add('third', () => {
          order.push('third');
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('swallows errors thrown by individual cleanup actions', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    await expect(
      runHandler({ name: 'swallow' }, async (cleanup) => {
        cleanup.add('safe-1', () => {
          ran.push('safe-1');
        });
        cleanup.add('throws', () => {
          throw new Error('cleanup-fail');
        });
        cleanup.add('safe-2', () => {
          ran.push('safe-2');
        });
        throw new Error('handler-fail');
      }),
    ).rejects.toThrow('handler-fail');
    expect(ran).toEqual(['safe-2', 'safe-1']);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it('runs cleanups on timeout and aborts the signal', async () => {
    const ran: string[] = [];
    let aborted = false;
    await expect(
      runHandler({ name: 'tmo', timeoutMs: 30 }, async (cleanup) => {
        cleanup.add('cleanup-on-timeout', () => {
          ran.push('cleanup-on-timeout');
        });
        cleanup.signal.addEventListener('abort', () => {
          aborted = true;
        });
        // Ignore the signal — watchdog should still fire.
        await new Promise((resolve) => setTimeout(resolve, 200));
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(ran).toEqual(['cleanup-on-timeout']);
    expect(aborted).toBe(true);
  });

  it('does NOT run cleanups on success', async () => {
    const ran: string[] = [];
    const result = await runHandler({ name: 'happy' }, async (cleanup) => {
      cleanup.add('should-not-run', () => {
        ran.push('should-not-run');
      });
      return 42;
    });
    expect(result).toBe(42);
    expect(ran).toEqual([]);
  });

  it('forget() removes one registration', async () => {
    const ran: string[] = [];
    await expect(
      runHandler({ name: 'forget' }, async (cleanup) => {
        cleanup.add('a', () => {
          ran.push('a');
        });
        cleanup.add('b', () => {
          ran.push('b');
        });
        cleanup.add('c', () => {
          ran.push('c');
        });
        cleanup.forget('b');
        expect(cleanup.size()).toBe(2);
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(ran).toEqual(['c', 'a']);
  });

  it('forget() removes only the most recent matching action', async () => {
    const ran: string[] = [];
    await expect(
      runHandler({ name: 'forget-one' }, async (cleanup) => {
        cleanup.add('dup', () => {
          ran.push('dup-1');
        });
        cleanup.add('dup', () => {
          ran.push('dup-2');
        });
        cleanup.forget('dup');
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(ran).toEqual(['dup-1']);
  });

  it('signal aborts when fn throws', async () => {
    let aborted = false;
    await expect(
      runHandler({ name: 'abort-on-throw' }, async (cleanup) => {
        cleanup.signal.addEventListener('abort', () => {
          aborted = true;
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(aborted).toBe(true);
  });

  it('TimeoutError includes the handler name and timeout value', async () => {
    try {
      await runHandler({ name: 'foo', timeoutMs: 10 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).handlerName).toBe('foo');
      expect((err as TimeoutError).timeoutMs).toBe(10);
      expect((err as Error).message).toMatch(/foo/);
      expect((err as Error).message).toMatch(/10ms/);
    }
  });
});
