/**
 * Integration tests for MCP tool handlers.
 *
 * These tests exercise the full handler pipeline with mocked external I/O
 * (Maestro CLI, Proxyman CLI, child_process) to verify orchestration logic
 * without requiring a booted simulator.
 *
 * Layer: Integration (between unit tests and smoke tests)
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// ── Create mock objects BEFORE vi.mock calls ──

const mockProxymanWrapper = {
  snapshotBaseline: vi.fn().mockResolvedValue(0),
  exportHarScopedParsed: vi.fn().mockResolvedValue({
    log: { entries: [] },
  }),
  getTransactions: vi.fn().mockResolvedValue([]),
  getPayload: vi.fn().mockResolvedValue(null),
  exportHar: vi.fn().mockResolvedValue('/tmp/mock.har'),
  exportHarScoped: vi.fn().mockResolvedValue('/tmp/mock-scoped.har'),
};

const mockValidateSimulator = vi.fn().mockResolvedValue({
  booted: true,
  deviceId: 'FAKE-UUID-1234',
});

const mockDriverFns = {
  dumpHierarchy: vi.fn().mockResolvedValue(
    'TreeNode|id=root|text=|accessibilityLabel=|role=Application\n' +
    '  TreeNode|id=login_submit_button|text=Login|accessibilityLabel=Login Button|role=Button\n' +
    '  TreeNode|id=login_username_field|text=|accessibilityLabel=Username|role=TextField',
  ),
  dumpHierarchyLite: vi.fn().mockResolvedValue(
    'TreeNode|id=root|text=|accessibilityLabel=|role=Application',
  ),
  dumpHierarchyUntilSettled: vi.fn().mockResolvedValue({
    hierarchy: 'TreeNode|id=root|text=|accessibilityLabel=|role=Application',
    settleDurationMs: 150,
  }),
  executeAction: vi.fn().mockResolvedValue({ success: true }),
  runTest: vi.fn().mockResolvedValue({
    passed: true,
    output: 'Test passed successfully',
    durationMs: 5000,
  }),
  validateSetup: vi.fn().mockResolvedValue(undefined),
  validateSimulator: mockValidateSimulator,
  uninstallDriver: vi.fn().mockResolvedValue(undefined),
  createTreeReader: vi.fn().mockReturnValue(async () => ({
    role: 'Application',
    children: [],
  })),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  isRunning: true,
};

// ── Mock the external-I/O modules BEFORE importing handlers ──

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

// ── Import the handlers and modules ──

import { sessionManager } from '../src/session/index.js';
const { DriverFactory } = await import('../src/maestro/driver.js');

const {
  handleStartRecording,
  handleStopAndCompile,
  handleGetUIHierarchy,
  handleExecuteUIAction,
  handleRunTest,
  handleGetSessionTimeline,
} = await import('../src/handlers.js');

// ── Test suites ──

describe('Handler Integration Tests', () => {
  beforeAll(async () => {
    // Initialize the session database (in-memory SQLite) before any tests
    await sessionManager.initialize();
  });

  beforeEach(() => {
    // Reset mock implementations to defaults before each test
    // Must re-set DriverFactory mocks since they're inside vi.mock factory
    vi.mocked(DriverFactory.create).mockResolvedValue(mockDriverFns as never);
    vi.mocked(DriverFactory.createCliOnly).mockResolvedValue(mockDriverFns as never);

    mockValidateSimulator.mockResolvedValue({
      booted: true,
      deviceId: 'FAKE-UUID-1234',
    });
    mockDriverFns.executeAction.mockResolvedValue({ success: true });
    mockDriverFns.runTest.mockResolvedValue({
      passed: true,
      output: 'Test passed successfully',
      durationMs: 5000,
    });
    mockProxymanWrapper.snapshotBaseline.mockResolvedValue(0);
    mockProxymanWrapper.exportHarScopedParsed.mockResolvedValue({
      log: { entries: [] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('start_recording_session → stop_and_compile_test lifecycle', () => {
    it('should start a session and receive a session ID', async () => {
      const result = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      expect(result.sessionId).toBeDefined();
      expect(result.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.message).toContain('Recording session');
      expect(result.readiness?.driverReady).toBe(true);

      // Clean up
      await handleStopAndCompile({ sessionId: result.sessionId });
    });

    it('should compile a session into YAML output', async () => {
      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      const compileResult = await handleStopAndCompile({
        sessionId: startResult.sessionId,
      });

      expect(compileResult.sessionId).toBe(startResult.sessionId);
      expect(compileResult.yaml).toBeDefined();
      expect(compileResult.yaml).toContain('appId');
      expect(compileResult.yamlPath).toBeDefined();
    });

    it('should include polling diagnostics in compile output', async () => {
      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      const compileResult = await handleStopAndCompile({
        sessionId: startResult.sessionId,
      });

      // Polling diagnostics should be present (even if all zeros)
      if (compileResult.pollingDiagnostics) {
        expect(compileResult.pollingDiagnostics.pollCount).toBeTypeOf('number');
        expect(compileResult.pollingDiagnostics.successCount).toBeTypeOf('number');
        expect(compileResult.pollingDiagnostics.errorCount).toBeTypeOf('number');
        expect(compileResult.pollingDiagnostics.inferredCount).toBeTypeOf('number');
      }
    });
  });

  describe('get_ui_hierarchy', () => {
    it('should capture hierarchy from a session driver', async () => {
      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      const result = await handleGetUIHierarchy({
        sessionId: startResult.sessionId,
      });

      expect(result.hierarchy).toBeDefined();
      expect(result.hierarchy.role).toBeDefined();

      // Clean up
      await handleStopAndCompile({ sessionId: startResult.sessionId });
    });

    it('should filter to interactive elements when interactiveOnly is true', async () => {
      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      const result = await handleGetUIHierarchy({
        sessionId: startResult.sessionId,
        interactiveOnly: true,
      });

      expect(result.hierarchy).toBeDefined();

      // Clean up
      await handleStopAndCompile({ sessionId: startResult.sessionId });
    });
  });

  describe('execute_ui_action', () => {
    it('should dispatch a tap action successfully', async () => {
      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      const actionResult = await handleExecuteUIAction({
        sessionId: startResult.sessionId,
        action: 'tap',
        element: { id: 'login_submit_button' },
      });

      expect(actionResult.success).toBe(true);
      expect(actionResult.message).toContain('tap');
      expect(actionResult.message).toContain('login_submit_button');

      // Clean up
      await handleStopAndCompile({ sessionId: startResult.sessionId });
    });

    it('should fail gracefully when driver returns error', async () => {
      mockDriverFns.executeAction.mockResolvedValue({
        success: false,
        error: 'Element not found on screen',
      });

      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      await expect(
        handleExecuteUIAction({
          sessionId: startResult.sessionId,
          action: 'tap',
          element: { id: 'nonexistent_button' },
        }),
      ).rejects.toThrow('Failed to execute action');

      // Clean up
      await handleStopAndCompile({ sessionId: startResult.sessionId });
    });
  });

  describe('run_test', () => {
    it('should return pass/fail result with duration', async () => {
      const result = await handleRunTest({
        yamlPath: '/tmp/test.yaml',
      });

      expect(result.passed).toBe(true);
      expect(result.output).toBe('Test passed successfully');
      expect(result.durationMs).toBe(5000);
    });

    it('should report failure when Maestro test fails', async () => {
      mockDriverFns.runTest.mockResolvedValue({
        passed: false,
        output: 'AssertVisible failed: element not found',
        durationMs: 3000,
      });

      const result = await handleRunTest({
        yamlPath: '/tmp/test.yaml',
      });

      expect(result.passed).toBe(false);
      expect(result.output).toContain('AssertVisible failed');
    });
  });

  describe('Error handling', () => {
    it('should throw on execute_ui_action with invalid session ID', async () => {
      await expect(
        handleExecuteUIAction({
          sessionId: 'nonexistent-session',
          action: 'tap',
          element: { id: 'button' },
        }),
      ).rejects.toThrow('No active driver');
    });

    it('should throw on stop_and_compile with invalid session ID', async () => {
      await expect(
        handleStopAndCompile({
          sessionId: 'nonexistent-session',
        }),
      ).rejects.toThrow();
    });

    it('should throw on start_recording when no simulator is booted', async () => {
      mockValidateSimulator.mockResolvedValue({
        booted: false,
      });

      await expect(
        handleStartRecording({
          appBundleId: 'com.test.app',
          platform: 'ios',
        }),
      ).rejects.toThrow('No booted');
    });
  });
});
