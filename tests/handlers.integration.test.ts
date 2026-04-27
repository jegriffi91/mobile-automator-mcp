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
  _setProxymanMcpClientFactory,
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

  describe('set_mock_response / clear_mock_responses (Proxyman MCP gateway)', () => {
    // Inject a fully-mocked ProxymanMcpClient so we can assert what the gateway
    // forwards to Proxyman without spawning the real mcp-server.
    let mockProxymanClient: {
      isConnected: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      callTool: ReturnType<typeof vi.fn>;
      getProxyStatus: ReturnType<typeof vi.fn>;
      toggleTool: ReturnType<typeof vi.fn>;
      enableSslProxying: ReturnType<typeof vi.fn>;
      createScriptingRule: ReturnType<typeof vi.fn>;
      deleteRule: ReturnType<typeof vi.fn>;
      listRules: ReturnType<typeof vi.fn>;
    };
    let restoreFactory: () => unknown;
    let sessionId: string;

    beforeEach(async () => {
      mockProxymanClient = {
        isConnected: vi.fn().mockReturnValue(true),
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue(''),
        getProxyStatus: vi.fn().mockResolvedValue('Recording: Active'),
        toggleTool: vi.fn().mockResolvedValue(undefined),
        enableSslProxying: vi.fn().mockResolvedValue(undefined),
        createScriptingRule: vi.fn().mockImplementation(async () =>
          `RULE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        ),
        deleteRule: vi.fn().mockResolvedValue(undefined),
        listRules: vi.fn().mockResolvedValue([]),
        // Phase-1 admin/cleanup additions
        listRulesByTagPrefix: vi.fn(),
        deleteRulesByTagPrefix: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
      };
      // Make tag-prefix delete drive its result from listRules+deleteRule so
      // existing tests that stub listRules/deleteRule still work.
      mockProxymanClient.listRulesByTagPrefix.mockImplementation(async (prefix: string) => {
        const all = await mockProxymanClient.listRules();
        return all.filter((r: { name: string }) => r.name.startsWith(prefix));
      });
      mockProxymanClient.deleteRulesByTagPrefix.mockImplementation(async (prefix: string) => {
        let rules: { id: string; name: string }[] = [];
        try {
          rules = await mockProxymanClient.listRulesByTagPrefix(prefix);
        } catch (err) {
          return { deleted: [], failed: [{ id: '*list*', error: (err as Error).message }] };
        }
        const deleted: string[] = [];
        const failed: { id: string; error: string }[] = [];
        for (const r of rules) {
          try {
            await mockProxymanClient.deleteRule(r.id, 'scripting');
            deleted.push(r.id);
          } catch (err) {
            failed.push({ id: r.id, error: (err as Error).message });
          }
        }
        return { deleted, failed };
      });
      restoreFactory = _setProxymanMcpClientFactory(() => mockProxymanClient as never);
      const start = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });
      sessionId = start.sessionId;
    });

    afterEach(async () => {
      // Clear any standalone mocks from prior tests — they live in a
      // module-scoped Map that survives test boundaries by default.
      try { await handleClearMockResponses({ allStandalone: true }); } catch { /* may be empty */ }
      try { await handleStopAndCompile({ sessionId }); } catch { /* may already be done */ }
      _setProxymanMcpClientFactory(restoreFactory);
    });

    it('translates a jsonPatch mock into a Proxyman scripting rule', async () => {
      const result = await handleSetMockResponse({
        sessionId,
        mock: {
          matcher: {
            pathContains: '/api/federated/graphql',
            method: 'POST',
            requestBodyContains: 'CustomerStatusAndCustomerAuthenticationQuery',
          },
          responseTransform: {
            jsonPatch: [
              { op: 'replace', path: '/data/customerStatusV3/loginStatus', value: 'OP2_INTERCEPT' },
            ],
          },
        },
      });
      expect(result.mockId).toBeTruthy();
      expect(result.proxymanRuleId).toMatch(/^RULE-/);
      expect(result.ruleName).toBe(`mca:${sessionId}:${result.mockId}`);
      expect(result.totalSessionMocks).toBe(1);

      // Confirms include_paths default flip happens via the client wrapper
      expect(mockProxymanClient.createScriptingRule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: result.ruleName,
          url: '*/api/federated/graphql*',
          method: 'POST',
          enableRequest: false,
          enableResponse: true,
        }),
      );
      const generatedScript = mockProxymanClient.createScriptingRule.mock.calls[0][0].scriptContent;
      expect(generatedScript).toContain('OP2_INTERCEPT');
      expect(generatedScript).toContain('/data/customerStatusV3/loginStatus');
      expect(generatedScript).toContain('CustomerStatusAndCustomerAuthenticationQuery');
    });

    it('translates a staticResponse mock into a script that hard-replaces the body', async () => {
      const result = await handleSetMockResponse({
        sessionId,
        mock: {
          id: 'flag-off',
          matcher: { urlPathEquals: '/api/v2/flags' },
          staticResponse: {
            status: 200,
            jsonBody: { flags: { newLogin: false } },
          },
        },
      });
      expect(result.mockId).toBe('flag-off');

      const script = mockProxymanClient.createScriptingRule.mock.calls[0][0].scriptContent;
      expect(script).toContain('response.statusCode = 200');
      expect(script).toContain('newLogin');
      expect(script).toContain("'application/json'");
    });

    it('passes graphqlQueryName through to Proxyman natively', async () => {
      await handleSetMockResponse({
        sessionId,
        mock: {
          matcher: {
            pathContains: '/graphql',
            graphqlQueryName: 'GetCurrentUser',
          },
          staticResponse: { status: 200, jsonBody: { user: null } },
        },
      });
      expect(mockProxymanClient.createScriptingRule).toHaveBeenCalledWith(
        expect.objectContaining({ graphqlQueryName: 'GetCurrentUser' }),
      );
    });

    it('defensively toggles the Scripting tool master switch on each set call', async () => {
      await handleSetMockResponse({
        sessionId,
        mock: {
          matcher: { pathContains: '/x' },
          staticResponse: { status: 200 },
        },
      });
      expect(mockProxymanClient.toggleTool).toHaveBeenCalledWith('scripting', true);
    });

    it('clear_mock_responses with mockId removes one rule', async () => {
      const a = await handleSetMockResponse({
        sessionId,
        mock: { id: 'a', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
      });
      const b = await handleSetMockResponse({
        sessionId,
        mock: { id: 'b', matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
      });
      expect(b.totalSessionMocks).toBe(2);

      const cleared = await handleClearMockResponses({ sessionId, mockId: 'a' });
      expect(cleared.removed).toBe(1);
      expect(cleared.remaining).toBe(1);
      expect(mockProxymanClient.deleteRule).toHaveBeenCalledWith(a.proxymanRuleId, 'scripting');
    });

    it('clear_mock_responses without mockId clears all session rules', async () => {
      await handleSetMockResponse({
        sessionId,
        mock: { matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
      });
      await handleSetMockResponse({
        sessionId,
        mock: { matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
      });

      const cleared = await handleClearMockResponses({ sessionId });
      expect(cleared.removed).toBe(2);
      expect(cleared.remaining).toBe(0);
      expect(mockProxymanClient.deleteRule).toHaveBeenCalledTimes(2);
    });

    it('stop_and_compile auto-cleans session-tagged rules from Proxyman', async () => {
      const setResult = await handleSetMockResponse({
        sessionId,
        mock: { matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
      });

      // Pretend Proxyman reports this rule and one stale rule from another session
      mockProxymanClient.listRules.mockResolvedValue([
        { id: setResult.proxymanRuleId, name: setResult.ruleName, url: '*', enabled: true, ruleType: 'scripting' },
        { id: 'OTHER-X', name: 'mca:other-session:m1', url: '*', enabled: true, ruleType: 'scripting' },
        { id: 'USER-Y', name: 'UserCreatedRule', url: '*', enabled: true, ruleType: 'scripting' },
      ]);

      await handleStopAndCompile({ sessionId });

      // Only this session's rule was deleted
      expect(mockProxymanClient.deleteRule).toHaveBeenCalledWith(setResult.proxymanRuleId, 'scripting');
      expect(mockProxymanClient.deleteRule).not.toHaveBeenCalledWith('OTHER-X', 'scripting');
      expect(mockProxymanClient.deleteRule).not.toHaveBeenCalledWith('USER-Y', 'scripting');
    });

    it('rejects set_mock_response when sessionId is provided but unknown', async () => {
      await expect(
        handleSetMockResponse({
          sessionId: 'nonexistent-session',
          mock: { matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
        }),
      ).rejects.toThrow(/Session not found/);
    });

    // ── P1: standalone (session-independent) mocks ──────────────────────────

    it('installs a STANDALONE mock when sessionId is omitted', async () => {
      const result = await handleSetMockResponse({
        mock: {
          id: 'flag-off',
          matcher: { pathContains: '/api/flags' },
          staticResponse: { status: 200, jsonBody: { newLogin: false } },
        },
      });
      expect(result.scope).toBe('standalone');
      expect(result.ruleName).toBe('mca:standalone:flag-off');
      expect(result.totalStandaloneMocks).toBe(1);
      expect(result.totalSessionMocks).toBeUndefined();
      // No session check needed — call succeeds even though no session exists
      expect(mockProxymanClient.createScriptingRule).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mca:standalone:flag-off' }),
      );
    });

    it('clears a single standalone mock by mockId', async () => {
      const set = await handleSetMockResponse({
        mock: { id: 'a', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
      });
      await handleSetMockResponse({
        mock: { id: 'b', matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
      });

      const cleared = await handleClearMockResponses({ mockId: 'a' });
      expect(cleared.scope).toBe('standalone-one');
      expect(cleared.removed).toBe(1);
      expect(cleared.remaining).toBe(1);
      expect(mockProxymanClient.deleteRule).toHaveBeenCalledWith(set.proxymanRuleId, 'scripting');
    });

    it('clears all standalone mocks via allStandalone:true', async () => {
      await handleSetMockResponse({
        mock: { id: 'a', matcher: { pathContains: '/a' }, staticResponse: { status: 200 } },
      });
      await handleSetMockResponse({
        mock: { id: 'b', matcher: { pathContains: '/b' }, staticResponse: { status: 200 } },
      });

      const cleared = await handleClearMockResponses({ allStandalone: true });
      expect(cleared.scope).toBe('standalone-all');
      expect(cleared.removed).toBe(2);
      expect(cleared.remaining).toBe(0);
    });

    it('standalone mocks survive stop_and_compile_test (not session-tagged)', async () => {
      const standalone = await handleSetMockResponse({
        mock: { id: 'persist', matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
      });
      // Session has no mocks of its own. listRules returns the standalone +
      // user rules, none of which are session-tagged.
      mockProxymanClient.listRules.mockResolvedValue([
        { id: standalone.proxymanRuleId, name: standalone.ruleName, url: '*', enabled: true, ruleType: 'scripting' },
        { id: 'USER-Y', name: 'UserCreatedRule', url: '*', enabled: true, ruleType: 'scripting' },
      ]);

      await handleStopAndCompile({ sessionId });

      // Standalone rule was NOT deleted by session cleanup
      expect(mockProxymanClient.deleteRule).not.toHaveBeenCalledWith(standalone.proxymanRuleId, 'scripting');

      // Cleanup via the standalone path still works
      const cleared = await handleClearMockResponses({ mockId: 'persist' });
      expect(cleared.removed).toBe(1);
    });

    it('session and standalone mocks can coexist independently', async () => {
      const sessionMock = await handleSetMockResponse({
        sessionId,
        mock: { id: 's-1', matcher: { pathContains: '/s' }, staticResponse: { status: 200 } },
      });
      const standaloneMock = await handleSetMockResponse({
        mock: { id: 'st-1', matcher: { pathContains: '/st' }, staticResponse: { status: 200 } },
      });
      expect(sessionMock.scope).toBe('session');
      expect(standaloneMock.scope).toBe('standalone');
      expect(sessionMock.ruleName).toContain(`mca:${sessionId}:`);
      expect(standaloneMock.ruleName).toBe('mca:standalone:st-1');

      // Clearing session shouldn't touch standalone
      await handleClearMockResponses({ sessionId });
      expect(mockProxymanClient.deleteRule).toHaveBeenCalledWith(sessionMock.proxymanRuleId, 'scripting');
      expect(mockProxymanClient.deleteRule).not.toHaveBeenCalledWith(standaloneMock.proxymanRuleId, 'scripting');

      // Tidy up the standalone for test isolation
      await handleClearMockResponses({ allStandalone: true });
    });

    // ── P2: inputText action via execute_ui_action ──────────────────────────

    it('inputText action succeeds without an element (focused-field typing)', async () => {
      const result = await handleExecuteUIAction({
        sessionId,
        action: 'inputText',
        textInput: 'hunter2',
      });
      expect(result.success).toBe(true);
      expect(mockDriverFns.executeAction).toHaveBeenCalledWith('inputText', {}, 'hunter2');
    });

    it('non-inputText actions still require an element', async () => {
      await expect(
        handleExecuteUIAction({
          sessionId,
          action: 'tap',
          // element omitted — should throw at the handler boundary
        }),
      ).rejects.toThrow(/requires an element/);
    });

    it('returns a clear error when Proxyman MCP rejects the rule (e.g. MCP disabled)', async () => {
      mockProxymanClient.createScriptingRule.mockRejectedValueOnce(
        Object.assign(new Error('Proxyman is not running or MCP server not started.'), { name: 'ProxymanMcpError' }),
      );
      await expect(
        handleSetMockResponse({
          sessionId,
          mock: { matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
        }),
      ).rejects.toThrow();
    });

    it('falls back to the local ledger if list_rules fails during cleanup', async () => {
      const setResult = await handleSetMockResponse({
        sessionId,
        mock: { matcher: { pathContains: '/x' }, staticResponse: { status: 200 } },
      });
      mockProxymanClient.listRules.mockRejectedValue(new Error('Proxyman went away'));

      await handleStopAndCompile({ sessionId });

      // Even though list_rules failed, the ledger entry was still deleted
      expect(mockProxymanClient.deleteRule).toHaveBeenCalledWith(setResult.proxymanRuleId, 'scripting');
    });

    it('skips Proxyman cleanup entirely when the client never connected', async () => {
      // Set up a fresh session with a NEVER-connected client (isConnected=false,
      // no rules registered locally either)
      const offlineClient = {
        ...mockProxymanClient,
        isConnected: vi.fn().mockReturnValue(false),
      };
      _setProxymanMcpClientFactory(() => offlineClient as never);

      const start = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });

      // No set_mock_response calls — ledger is empty for this session.
      // stop_and_compile should not attempt list_rules / deleteRule.
      await handleStopAndCompile({ sessionId: start.sessionId });
      expect(offlineClient.listRules).not.toHaveBeenCalled();
      expect(offlineClient.deleteRule).not.toHaveBeenCalled();
    });
  });

  describe('start_recording_session → enable_ssl_proxying integration', () => {
    let mockProxymanClient: { enableSslProxying: ReturnType<typeof vi.fn> } & Record<string, unknown>;
    let restoreFactory: () => unknown;

    beforeEach(() => {
      mockProxymanClient = {
        isConnected: vi.fn().mockReturnValue(true),
        enableSslProxying: vi.fn().mockResolvedValue(undefined),
      };
      restoreFactory = _setProxymanMcpClientFactory(() => mockProxymanClient as never);
    });

    afterEach(() => {
      _setProxymanMcpClientFactory(restoreFactory);
    });

    it('auto-arms SSL proxying for each filterDomain on session start', async () => {
      const result = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
        filterDomains: ['api.experian.com', 'api2.experian.com:443'],
      });
      expect(mockProxymanClient.enableSslProxying).toHaveBeenCalledTimes(2);
      // Port suffix stripped before forwarding to Proxyman
      expect(mockProxymanClient.enableSslProxying).toHaveBeenCalledWith('api.experian.com');
      expect(mockProxymanClient.enableSslProxying).toHaveBeenCalledWith('api2.experian.com');
      await handleStopAndCompile({ sessionId: result.sessionId });
    });

    it('does not call SSL proxying when filterDomains is omitted', async () => {
      const result = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
      });
      expect(mockProxymanClient.enableSslProxying).not.toHaveBeenCalled();
      await handleStopAndCompile({ sessionId: result.sessionId });
    });

    it('continues recording start when SSL proxying fails (Proxyman MCP unavailable)', async () => {
      mockProxymanClient.enableSslProxying.mockRejectedValue(new Error('connection refused'));
      const result = await handleStartRecording({
        appBundleId: 'com.test.app',
        platform: 'ios',
        filterDomains: ['api.example.com'],
      });
      expect(result.readiness?.driverReady).toBe(true);
      await handleStopAndCompile({ sessionId: result.sessionId });
    });
  });

  // ── Phase 1 Step 4: cleanup-on-failure regression tests ──
  describe('cleanup accumulator (Phase 1)', () => {
    it('handleStartRecording: poller failure rolls back driver registration and aborts session', async () => {
      // Force startPolling to throw — exercises the rollback path on the
      // poller cleanup action.
      const origCreateTreeReader = mockDriverFns.createTreeReader;
      mockDriverFns.createTreeReader = vi.fn(() => {
        throw new Error('poller-startup-failed');
      }) as never;

      try {
        await expect(
          handleStartRecording({ appBundleId: 'com.test.app', platform: 'ios' }),
        ).rejects.toThrow(/poller-startup-failed/);

        // No session left in activeDrivers
        expect(sessionManager.listActiveDrivers()).toEqual([]);
        // No active poller
        expect(sessionManager.listActivePollers()).toEqual([]);
        // No live (non-aborted) recording sessions in DB
        const active = sessionManager.listActiveSessions();
        expect(active).toEqual([]);
      } finally {
        mockDriverFns.createTreeReader = origCreateTreeReader;
      }
    });

    it('handleSetMockResponse: rollback on post-create failure deletes the new Proxyman rule', async () => {
      const mockProxymanClient = {
        isConnected: vi.fn().mockReturnValue(true),
        toggleTool: vi.fn().mockResolvedValue(undefined),
        createScriptingRule: vi.fn().mockResolvedValue('NEW-RULE-ID'),
        deleteRule: vi.fn().mockResolvedValue(undefined),
        listRules: vi.fn().mockResolvedValue([]),
      };
      const restore = _setProxymanMcpClientFactory(() => mockProxymanClient as never);

      try {
        const start = await handleStartRecording({
          appBundleId: 'com.test.app',
          platform: 'ios',
        });

        // Stub addSessionMock to throw so the rollback registered after
        // createScriptingRule() runs.
        const origAdd = sessionManager.addSessionMock.bind(sessionManager);
        const spy = vi
          .spyOn(sessionManager, 'addSessionMock')
          .mockImplementation(() => {
            throw new Error('ledger-write-failed');
          });

        await expect(
          handleSetMockResponse({
            sessionId: start.sessionId,
            mock: {
              matcher: { url: 'https://api.example.com/users' },
              staticResponse: { status: 200, body: { ok: true } },
            },
          }),
        ).rejects.toThrow(/ledger-write-failed/);

        expect(mockProxymanClient.deleteRule).toHaveBeenCalledWith('NEW-RULE-ID', 'scripting');

        spy.mockRestore();
        // Restore so handleStopAndCompile can clean state
        sessionManager.addSessionMock = origAdd as never;
        await handleStopAndCompile({ sessionId: start.sessionId });
      } finally {
        _setProxymanMcpClientFactory(restore);
      }
    });
  });

  describe('start_build (Phase 2 smoke)', () => {
    it('returns a UUID and registers a running task', async () => {
      const { handleStartBuild } = await import('../src/handlers.js');
      const { taskRegistry } = await import('../src/tasks/registry.js');
      try {
        const out = await handleStartBuild({
          platform: 'ios',
          workspacePath: '/nope/X.xcworkspace',
          scheme: 'X',
        });
        expect(out.taskId).toMatch(/^[0-9a-f-]{36}$/);
        expect(out.kind).toBe('build');
        expect(out.status).toBe('running');
        expect(taskRegistry.get(out.taskId)).toBeDefined();
        // Cancel so the runner doesn't actually shell xcodebuild against /nope/.
        taskRegistry.cancel(out.taskId, 'test-teardown');
      } finally {
        taskRegistry._clearForTests();
      }
    });
  });
});
