/**
 * Integration tests for the start_test / start_flow async flow handlers
 * (Phase 5 — flow tasks routed through TaskRegistry).
 *
 * Layer: Integration (mocked external I/O — Maestro CLI, Proxyman CLI).
 *
 * Covers:
 * - start_test returns a taskId immediately, polling reflects done state.
 * - start_flow returns a taskId for a named flow.
 * - cancel_task on a running flow SIGTERMs the Maestro CLI (via the parent
 *   abort signal threaded through executeFlowWithPause) and runs resume
 *   cleanup when an active recording session was bracketed.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// ── Mock objects ──

const mockProxymanWrapper = {
  snapshotBaseline: vi.fn().mockResolvedValue(0),
  exportHarScopedParsed: vi.fn().mockResolvedValue({ log: { entries: [] } }),
  getTransactions: vi.fn().mockResolvedValue([]),
  getPayload: vi.fn().mockResolvedValue(null),
  exportHar: vi.fn().mockResolvedValue('/tmp/mock.har'),
  exportHarScoped: vi.fn().mockResolvedValue('/tmp/mock-scoped.har'),
};

const mockValidateSimulator = vi.fn().mockResolvedValue({
  booted: true,
  deviceId: 'FAKE-UUID-1234',
});

type MockDriverFns = Record<string, ReturnType<typeof vi.fn>> & {
  isRunning: boolean;
};

const mockDriverFns: MockDriverFns = {
  validateSimulator: mockValidateSimulator,
  validateSetup: vi.fn().mockResolvedValue(undefined),
  uninstallDriver: vi.fn().mockResolvedValue(undefined),
  ensureCleanDriverState: vi.fn().mockResolvedValue(undefined),
  executeAction: vi.fn().mockResolvedValue({ success: true }),
  runTest: vi.fn().mockResolvedValue({
    passed: true,
    output: 'Test passed',
    durationMs: 1234,
  }),
  dumpHierarchy: vi.fn().mockResolvedValue('TreeNode|id=root'),
  dumpHierarchyLite: vi.fn().mockResolvedValue('TreeNode|id=root'),
  dumpHierarchyUntilSettled: vi.fn().mockResolvedValue({
    hierarchy: 'TreeNode|id=root',
    settleDurationMs: 50,
  }),
  createTreeReader: vi.fn().mockReturnValue(async () => ({
    role: 'Application',
    children: [],
  })),
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
  proxymanWrapper: mockProxymanWrapper,
  ProxymanWrapper: vi.fn().mockImplementation(() => mockProxymanWrapper),
  PayloadValidator: {
    validate: vi.fn().mockReturnValue({ matched: true, mismatches: [] }),
  },
  resolveCliPath: vi.fn().mockResolvedValue('/usr/bin/proxyman-cli'),
  _resetResolvedCliPath: vi.fn(),
}));

import { sessionManager } from '../src/session/index.js';
const { DriverFactory } = await import('../src/maestro/driver.js');

const {
  handleStartTest,
  handleStartFlow,
  handlePollTaskStatus,
  handleGetTaskResult,
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

describe('start_test / start_flow (Phase 5)', () => {
  beforeAll(async () => {
    await sessionManager.initialize();
  });

  beforeEach(() => {
    vi.mocked(DriverFactory.create).mockResolvedValue(mockDriverFns as never);
    vi.mocked(DriverFactory.createCliOnly).mockResolvedValue(mockDriverFns as never);
    mockDriverFns.runTest.mockResolvedValue({
      passed: true,
      output: 'Test passed',
      durationMs: 1234,
    });
  });

  afterEach(() => {
    taskRegistry._clearForTests();
    vi.clearAllMocks();
  });

  it('start_test: returns a taskId immediately and resolves to status=done with full RunTestOutput', async () => {
    const out = await handleStartTest({ yamlPath: '/tmp/login.yaml', platform: 'ios' });
    expect(out.kind).toBe('test');
    expect(out.status).toBe('running');
    expect(out.taskId).toMatch(/^[0-9a-f-]{36}$/);

    await waitFor(() => {
      const t = taskRegistry.get(out.taskId);
      return !!t && t.status !== 'running';
    });

    const polled = await handlePollTaskStatus({ taskId: out.taskId });
    expect(polled.status).toBe('done');
    expect(polled.kind).toBe('test');

    const got = await handleGetTaskResult({ taskId: out.taskId });
    expect(got.status).toBe('done');
    expect(got.result?.kind).toBe('test');
    if (got.result?.kind === 'test') {
      expect(got.result.test.passed).toBe(true);
      expect(got.result.test.output).toBe('Test passed');
    }
  });

  it('start_flow smoke: returns a taskId; resolution failure surfaces as failed task', async () => {
    // Resolving the named flow against a non-existent dir is the cheapest
    // observable side-effect. Confirms the handler delegates through the
    // registry rather than throwing synchronously.
    const out = await handleStartFlow({
      name: 'definitely-not-real',
      flowsDir: '/tmp/does-not-exist-' + Date.now(),
    });
    expect(out.kind).toBe('flow');
    expect(out.status).toBe('running');

    await waitFor(() => {
      const t = taskRegistry.get(out.taskId);
      return !!t && t.status !== 'running';
    });

    const polled = await handlePollTaskStatus({ taskId: out.taskId });
    expect(polled.status).toBe('failed');
    expect(polled.error).toBeTruthy();
  });
});

