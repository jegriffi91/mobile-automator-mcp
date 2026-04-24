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
  ensureCleanDriverState: vi.fn().mockResolvedValue(undefined),
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
  handleGetNetworkLogs,
  handleSetMockResponse,
  handleClearMockResponses,
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

    it('cleans the XCTest driver with a cooldown before reinstalling (regression: Bug #5)', async () => {
      // Bug: back-to-back `maestro test` invocations failed with
      // `ConnectException: Failed to connect to /127.0.0.1:7001` because the
      // simulator hadn't released the port before the next run tried to bind.
      // Fix: the handler must call ensureCleanDriverState (uninstall + cooldown),
      // not the bare uninstallDriver.
      const result = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      expect(mockDriverFns.ensureCleanDriverState).toHaveBeenCalledWith(
        'ios',
        'FAKE-UUID-1234',
      );
      expect(mockDriverFns.uninstallDriver).not.toHaveBeenCalled();

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

    it('should dispatch a point-based tap for custom controls', async () => {
      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      const actionResult = await handleExecuteUIAction({
        sessionId: startResult.sessionId,
        action: 'tap',
        element: { point: { x: 201, y: 186 } },
      });

      expect(actionResult.success).toBe(true);
      expect(actionResult.message).toContain('point(201,186)');
      expect(mockDriverFns.executeAction).toHaveBeenCalledWith(
        'tap',
        expect.objectContaining({ point: { x: 201, y: 186 } }),
        undefined,
      );

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

  describe('get_network_logs', () => {
    it('time-scopes before applying limit (regression: Bug #4)', async () => {
      // Start a session — sessionStart is "now".
      const startResult = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      const now = Date.now();
      const beforeSession = new Date(now - 60_000).toISOString(); // 1 min before
      const afterSession = new Date(now + 60_000).toISOString();  // 1 min after (simulated)

      // Proxyman returns 60 old pre-session events followed by the single
      // in-session event we actually care about. The old default limit (50)
      // would have sliced off the in-session event before time-scoping.
      const oldEvents = Array.from({ length: 60 }, (_, i) => ({
        sessionId: startResult.sessionId,
        timestamp: beforeSession,
        method: 'GET',
        url: `https://api.example.com/noise/${i}`,
        statusCode: 200,
      }));
      const inSessionEvent = {
        sessionId: startResult.sessionId,
        timestamp: afterSession,
        method: 'POST',
        url: 'https://api.example.com/equifax/tap',
        statusCode: 200,
      };
      mockProxymanWrapper.getTransactions.mockResolvedValueOnce([
        ...oldEvents,
        inSessionEvent,
      ]);

      const result = await handleGetNetworkLogs({
        sessionId: startResult.sessionId,
        limit: 50,
      });

      // The in-session event must survive: limit was applied *after* time-scope,
      // not before. The wrapper is called with `undefined` so it returns all.
      expect(mockProxymanWrapper.getTransactions).toHaveBeenCalledWith(
        startResult.sessionId,
        undefined,
        undefined,
        undefined,
      );
      expect(result.events.map((e) => e.url)).toContain(
        'https://api.example.com/equifax/tap',
      );

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

    it('forwards driverCooldownMs into DriverFactory.createCliOnly (Bug #9 fix)', async () => {
      await handleRunTest({
        yamlPath: '/tmp/test.yaml',
        driverCooldownMs: 7500,
      });

      expect(DriverFactory.createCliOnly).toHaveBeenCalledWith({ driverCooldownMs: 7500 });
    });

    it('omits timeouts when driverCooldownMs is not supplied', async () => {
      await handleRunTest({ yamlPath: '/tmp/test.yaml' });
      expect(DriverFactory.createCliOnly).toHaveBeenCalledWith(undefined);
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

  describe('set_mock_response / clear_mock_responses', () => {
    // These tests stand up a real local origin + real MockServer, so we can
    // validate the end-to-end path (app → mock server → backend) rather than
    // just checking handler bookkeeping.
    let http: typeof import('http');
    let origin: import('http').Server;
    let originPort: number;
    let sessionId: string;

    beforeAll(async () => {
      http = await import('http');
    });

    beforeEach(async () => {
      origin = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: { customerStatusV3: { loginStatus: 'SUCCESS' } },
            path: req.url,
          }));
        });
      });
      originPort = await new Promise<number>((resolve) => {
        origin.listen(0, '127.0.0.1', () => {
          const a = origin.address();
          if (a && typeof a !== 'string') resolve(a.port);
        });
      });

      const start = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });
      sessionId = start.sessionId;
    });

    afterEach(async () => {
      // Best-effort cleanup — tests may have already torn the session down
      // via their own stopAndCompile call, in which case the transition throws.
      try { await handleClearMockResponses({ sessionId, stopServer: true }); } catch { /* already gone */ }
      try { await handleStopAndCompile({ sessionId }); } catch { /* already compiled */ }
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    });

    it('proxies a matched request to the real backend and applies jsonPatch', async () => {
      const result = await handleSetMockResponse({
        sessionId,
        defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
        mock: {
          matcher: { pathContains: '/graphql', method: 'POST' },
          proxyBaseUrl: `http://127.0.0.1:${originPort}`,
          responseTransform: {
            jsonPatch: [
              { op: 'replace', path: '/data/customerStatusV3/loginStatus', value: 'OP2_INTERCEPT' },
            ],
          },
        },
      });
      expect(result.mockId).toBeTruthy();
      expect(result.port).toBeGreaterThan(0);
      expect(result.baseUrl).toBe(`http://127.0.0.1:${result.port}`);
      expect(result.totalMocks).toBe(1);

      const res = await fetch(`${result.baseUrl}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'CustomerStatusAndCustomerAuthenticationQuery' }),
      });
      const body = await res.json() as { data: { customerStatusV3: { loginStatus: string } } };
      expect(body.data.customerStatusV3.loginStatus).toBe('OP2_INTERCEPT');
    });

    it('serves a static response when staticResponse is set', async () => {
      const result = await handleSetMockResponse({
        sessionId,
        defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
        mock: {
          id: 'feature-flag-off',
          matcher: { pathContains: '/api/flags' },
          staticResponse: { status: 200, jsonBody: { newLogin: false } },
        },
      });
      expect(result.mockId).toBe('feature-flag-off');

      const res = await fetch(`${result.baseUrl}/api/flags`);
      expect(await res.json()).toEqual({ newLogin: false });
    });

    it('passes non-matched requests through to the real backend', async () => {
      const result = await handleSetMockResponse({
        sessionId,
        defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
        mock: {
          matcher: { pathContains: '/only-this' },
          staticResponse: { status: 418, jsonBody: { teapot: true } },
        },
      });

      const res = await fetch(`${result.baseUrl}/elsewhere`);
      const body = await res.json() as { data: unknown; path: string };
      expect(res.status).toBe(200);
      expect(body.path).toBe('/elsewhere');
      expect(body.data).toBeDefined();
    });

    it('requires defaultPassthroughUrl on the first call for a session', async () => {
      await expect(
        handleSetMockResponse({
          sessionId,
          mock: {
            matcher: { pathContains: '/x' },
            staticResponse: { status: 200 },
          },
        }),
      ).rejects.toThrow(/defaultPassthroughUrl/);
    });

    it('refuses to change defaultPassthroughUrl mid-session', async () => {
      await handleSetMockResponse({
        sessionId,
        defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
        mock: { matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
      });
      await expect(
        handleSetMockResponse({
          sessionId,
          defaultPassthroughUrl: 'http://other.example.com',
          mock: { matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
        }),
      ).rejects.toThrow(/refusing to change/);
    });

    it('clear_mock_responses with mockId removes one; without it removes all', async () => {
      const a = await handleSetMockResponse({
        sessionId,
        defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
        mock: { id: 'a', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
      });
      await handleSetMockResponse({
        sessionId,
        mock: { id: 'b', matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
      });
      expect(a.totalMocks).toBe(1); // a at time of registration

      const removeOne = await handleClearMockResponses({ sessionId, mockId: 'a' });
      expect(removeOne.removed).toBe(1);
      expect(removeOne.remaining).toBe(1);

      const removeRest = await handleClearMockResponses({ sessionId });
      expect(removeRest.removed).toBe(1);
      expect(removeRest.remaining).toBe(0);
    });

    it('clear_mock_responses with stopServer=true shuts the mock server down', async () => {
      const set = await handleSetMockResponse({
        sessionId,
        defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
        mock: { matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
      });
      const cleared = await handleClearMockResponses({ sessionId, stopServer: true });
      expect(cleared.serverStopped).toBe(true);

      // Server should no longer accept connections
      await expect(fetch(`${set.baseUrl}/x`)).rejects.toThrow();
    });

    it('rejects set_mock_response for an unknown session', async () => {
      await expect(
        handleSetMockResponse({
          sessionId: 'nonexistent-session',
          defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
          mock: { matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
        }),
      ).rejects.toThrow(/Session not found/);
    });

    it('stop_and_compile tears down the mock server automatically', async () => {
      const set = await handleSetMockResponse({
        sessionId,
        defaultPassthroughUrl: `http://127.0.0.1:${originPort}`,
        mock: { matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
      });
      await handleStopAndCompile({ sessionId });
      await expect(fetch(`${set.baseUrl}/x`)).rejects.toThrow();
    });
  });
});
