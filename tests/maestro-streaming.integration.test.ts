/**
 * Integration tests for Maestro stdout streaming into the TaskRegistry RingBuffer.
 *
 * Verifies that when start_test / start_flow runs, Maestro output lines are
 * forwarded through ctx.appendLine into the task's ring buffer so that
 * poll_task_status shows live output lines mid-flight.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// ── Mock objects ──

const mockValidateSimulator = vi.fn().mockResolvedValue({
  booted: true,
  deviceId: 'FAKE-UUID-STREAM',
});

type MockDriverFns = Record<string, ReturnType<typeof vi.fn>> & { isRunning: boolean };

const mockDriverFns: MockDriverFns = {
  validateSimulator: mockValidateSimulator,
  validateSetup: vi.fn().mockResolvedValue(undefined),
  uninstallDriver: vi.fn().mockResolvedValue(undefined),
  ensureCleanDriverState: vi.fn().mockResolvedValue(undefined),
  executeAction: vi.fn().mockResolvedValue({ success: true }),
  runTest: vi.fn().mockResolvedValue({
    passed: true,
    output: 'Test passed',
    durationMs: 50,
  }),
  dumpHierarchy: vi.fn().mockResolvedValue('TreeNode|id=root'),
  dumpHierarchyLite: vi.fn().mockResolvedValue('TreeNode|id=root'),
  dumpHierarchyUntilSettled: vi.fn().mockResolvedValue({
    hierarchy: 'TreeNode|id=root',
    settleDurationMs: 50,
  }),
  createTreeReader: vi.fn().mockReturnValue(async () => ({ role: 'Application', children: [] })),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  isRunning: true,
};

vi.mock('../src/maestro/driver.js', () => ({
  DriverFactory: {
    create: vi.fn(),
    createCliOnly: vi.fn(),
  },
}));

vi.mock('../src/proxyman/index.js', () => ({
  proxymanWrapper: {},
  ProxymanWrapper: vi.fn(),
  PayloadValidator: { validate: vi.fn().mockReturnValue({ matched: true, mismatches: [] }) },
  resolveCliPath: vi.fn().mockResolvedValue('/usr/bin/proxyman-cli'),
  _resetResolvedCliPath: vi.fn(),
}));

import { sessionManager } from '../src/session/index.js';
const { DriverFactory } = await import('../src/maestro/driver.js');

const {
  handleStartTest,
  handlePollTaskStatus,
} = await import('../src/handlers.js');

const { taskRegistry } = await import('../src/tasks/registry.js');

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('Maestro stdout streaming into TaskRegistry RingBuffer', () => {
  beforeAll(async () => {
    await sessionManager.initialize();
  });

  beforeEach(() => {
    vi.mocked(DriverFactory.create).mockResolvedValue(mockDriverFns as never);
    vi.mocked(DriverFactory.createCliOnly).mockResolvedValue(mockDriverFns as never);
  });

  afterEach(() => {
    taskRegistry._clearForTests();
    vi.clearAllMocks();
  });

  it('onLine lines emitted during runTest appear in poll_task_status recentOutputLines', async () => {
    // Stub runTest to call onLine a few times before resolving.
    // The onLine callback is the 5th argument — the real MaestroWrapper passes
    // it to spawnStream; here we simulate a Maestro process emitting lines.
    mockDriverFns.runTest.mockImplementation(
      async (
        _yamlPath: string,
        _env: unknown,
        _debugOutput: unknown,
        _signal: unknown,
        onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
      ) => {
        onLine?.('Flow step 1 started', 'stdout');
        onLine?.('Flow step 2 started', 'stdout');
        onLine?.('Flow step 3 passed', 'stdout');
        return { passed: true, output: 'All steps passed', durationMs: 50 };
      },
    );

    const out = await handleStartTest({ yamlPath: '/tmp/login.yaml', platform: 'ios' });
    expect(out.taskId).toBeTruthy();

    // Wait for the task to finish.
    await waitFor(() => {
      const t = taskRegistry.get(out.taskId);
      return !!t && t.status !== 'running';
    });

    const polled = await handlePollTaskStatus({ taskId: out.taskId });
    expect(polled.status).toBe('done');

    // The lines emitted via onLine should appear in the ring buffer.
    const recentLines = polled.recentOutputLines ?? [];
    expect(recentLines.some((l) => l.includes('Flow step 1 started'))).toBe(true);
    expect(recentLines.some((l) => l.includes('Flow step 3 passed'))).toBe(true);
  });

  it('poll_task_status shows lines mid-flight before task completes', async () => {
    let resolveRunTest!: () => void;

    // Hold runTest open until we explicitly release it; emit lines beforehand.
    mockDriverFns.runTest.mockImplementation(
      async (
        _yamlPath: string,
        _env: unknown,
        _debugOutput: unknown,
        signal: AbortSignal | undefined,
        onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
      ) => {
        onLine?.('mid-flight line A', 'stdout');
        onLine?.('mid-flight line B', 'stdout');

        // Hold until released or aborted.
        await new Promise<void>((resolve) => {
          resolveRunTest = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { passed: true, output: '', durationMs: 0 };
      },
    );

    const out = await handleStartTest({ yamlPath: '/tmp/slow.yaml', platform: 'ios' });

    // Poll while still running — lines should already be in the ring buffer.
    await waitFor(() => {
      const t = taskRegistry.get(out.taskId);
      if (!t) return false;
      return t.lineCount() >= 2;
    });

    const polledMidFlight = await handlePollTaskStatus({ taskId: out.taskId });
    const lines = polledMidFlight.recentOutputLines ?? [];
    expect(lines.some((l) => l.includes('mid-flight line A'))).toBe(true);
    expect(lines.some((l) => l.includes('mid-flight line B'))).toBe(true);

    // Release the held runTest.
    resolveRunTest();

    await waitFor(() => {
      const t = taskRegistry.get(out.taskId);
      return !!t && t.status !== 'running';
    });
  });
});
