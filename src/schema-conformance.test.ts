/**
 * Schema Conformance Tests — validates that representative handler outputs
 * conform to their Zod output schemas.
 *
 * These tests prevent the class of bug where a handler returns data with
 * additional properties not declared in the schema, which the MCP SDK
 * rejects at runtime via JSON Schema `additionalProperties: false`.
 *
 * Strategy: construct fixture data matching what each handler returns,
 * then verify `OutputSchema.parse(fixture)` succeeds without stripping fields.
 */

import { describe, it, expect } from 'vitest';
import {
  StartRecordingOutputSchema,
  StopAndCompileOutputSchema,
  GetUIHierarchyOutputSchema,
  ExecuteUIActionOutputSchema,
  GetNetworkLogsOutputSchema,
  VerifySDUIPayloadOutputSchema,
  RegisterSegmentOutputSchema,
  RunTestOutputSchema,
  ListDevicesOutputSchema,
  GetSessionTimelineOutputSchema,
  ListFlowsOutputSchema,
  RunFlowOutputSchema,
  BuildAppOutputSchema,
  InstallAppOutputSchema,
  UninstallAppOutputSchema,
  BootSimulatorOutputSchema,
  TakeScreenshotOutputSchema,
  RunUnitTestsOutputSchema,
  FeatureTestSpecSchema,
  RunFeatureTestInputSchema,
  RunFeatureTestOutputSchema,
  SetMockResponseInputSchema,
  SetMockResponseOutputSchema,
  ClearMockResponsesInputSchema,
  ClearMockResponsesOutputSchema,
  ListActiveSessionsOutputSchema,
  ListActiveMocksInputSchema,
  ListActiveMocksOutputSchema,
  ForceCleanupSessionInputSchema,
  ForceCleanupSessionOutputSchema,
  ForceCleanupMocksInputSchema,
  ForceCleanupMocksOutputSchema,
  AuditStateOutputSchema,
  StartBuildOutputSchema,
  PollTaskStatusInputSchema,
  PollTaskStatusOutputSchema,
  GetTaskResultInputSchema,
  GetTaskResultOutputSchema,
  CancelTaskInputSchema,
  CancelTaskOutputSchema,
  ListTasksInputSchema,
  ListTasksOutputSchema,
} from './schemas.js';

describe('Schema Conformance', () => {
  describe('StartRecordingOutputSchema', () => {
    it('should accept valid output', () => {
      const output = {
        sessionId: 'session-abc123',
        message: 'Recording started for com.example.app on ios',
      };
      const result = StartRecordingOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should reject output with additional properties', () => {
      const output = {
        sessionId: 'session-abc123',
        message: 'Recording started',
        unexpectedField: 'should-fail',
      };
      const result = StartRecordingOutputSchema.strict().safeParse(output);
      expect(result.success).toBe(false);
    });
  });

  describe('StopAndCompileOutputSchema', () => {
    it('should accept minimal output', () => {
      const output = {
        sessionId: 'session-abc123',
        yaml: 'appId: com.example.app\n---\n- tapOn:\n    id: "button"',
        yamlPath: '/tmp/maestro-test-session-abc123.yaml',
      };
      const result = StopAndCompileOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept output with all optional fields including pollingDiagnostics', () => {
      const output = {
        sessionId: 'session-abc123',
        yaml: 'appId: com.example.app\n---\n- tapOn:\n    id: "button"',
        yamlPath: '/tmp/maestro-test-session-abc123.yaml',
        fixturesDir: '/tmp/session-abc123/wiremock/__files',
        stubsDir: '/tmp/session-abc123/wiremock',
        manifestPath: '/tmp/session-abc123/manifest.json',
        segmentFingerprint: 'abcd1234',
        matchedSegments: [
          { name: 'login', fingerprint: 'abcd1234', similarity: 0.95, yamlPath: '/segments/login.yaml' },
        ],
        pollingDiagnostics: {
          pollCount: 100,
          successCount: 98,
          errorCount: 2,
          inferredCount: 5,
          lastError: 'Timeout',
          elapsedMs: 30000,
          expectedPolls: 60,
          actualPollingRateMs: 510,
          configuredPollingRateMs: 500,
          equalTreeCount: 80,
          thresholdExceededCount: 3,
          diffButNullInferenceCount: 2,
          baselineElementCount: 15,
        },
        timelinePath: '/tmp/session-abc123/timeline.json',
      };
      const result = StopAndCompileOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('GetUIHierarchyOutputSchema', () => {
    it('should accept hierarchy with structuralHash', () => {
      const output = {
        hierarchy: {
          role: 'Application',
          children: [
            {
              id: 'login_button',
              accessibilityLabel: 'Log In',
              text: 'Log In',
              role: 'Button',
              children: [],
              structuralHash: 'abcd1234',
            },
          ],
          structuralHash: 'ef567890',
        },
        nodeCount: 2,
      };
      const result = GetUIHierarchyOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept hierarchy without structuralHash (backward compat)', () => {
      const output = {
        hierarchy: {
          role: 'Application',
          children: [],
        },
        nodeCount: 1,
      };
      const result = GetUIHierarchyOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept output with rawOutput and artifactPath', () => {
      const output = {
        hierarchy: { role: 'Application', children: [] },
        rawOutput: '{"type": "Application"}',
        nodeCount: 1,
        artifactPath: '/tmp/hierarchy.json',
      };
      const result = GetUIHierarchyOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('ExecuteUIActionOutputSchema', () => {
    it('should accept valid output', () => {
      const output = { success: true, message: 'Tapped on "login_button"' };
      const result = ExecuteUIActionOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('GetNetworkLogsOutputSchema', () => {
    it('should accept output with network events', () => {
      const output = {
        events: [
          {
            sessionId: 'session-abc',
            timestamp: '2024-01-01T00:00:00Z',
            method: 'GET',
            url: 'https://api.example.com/data',
            statusCode: 200,
            responseBody: '{"key": "value"}',
            durationMs: 150,
          },
        ],
        total: 1,
      };
      const result = GetNetworkLogsOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept output with all NetworkEvent fields', () => {
      const output = {
        events: [
          {
            id: 1,
            sessionId: 'session-abc',
            timestamp: '2024-01-01T00:00:00Z',
            method: 'POST',
            url: 'https://api.example.com/login',
            statusCode: 200,
            requestBody: '{"user": "test"}',
            responseBody: '{"token": "abc"}',
            durationMs: 250,
          },
        ],
        total: 1,
      };
      const result = GetNetworkLogsOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('VerifySDUIPayloadOutputSchema', () => {
    it('should accept matched result', () => {
      const output = { matched: true };
      const result = VerifySDUIPayloadOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept unmatched result with mismatches', () => {
      const output = {
        matched: false,
        actual: { title: 'Wrong Title' },
        mismatches: ['title: expected "Hello" but got "Wrong Title"'],
      };
      const result = VerifySDUIPayloadOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('RegisterSegmentOutputSchema', () => {
    it('should accept valid output', () => {
      const output = {
        name: 'login-flow',
        fingerprint: 'abc123def456',
        registryPath: '/segments/registry.json',
        message: 'Segment "login-flow" registered',
      };
      const result = RegisterSegmentOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('RunTestOutputSchema', () => {
    it('should accept passed test result', () => {
      const output = {
        passed: true,
        output: 'All tests passed',
        durationMs: 5000,
      };
      const result = RunTestOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept result with stubServerPort', () => {
      const output = {
        passed: false,
        output: 'Test failed: element not found',
        stubServerPort: 8080,
        durationMs: 3000,
      };
      const result = RunTestOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('ListDevicesOutputSchema', () => {
    it('should accept iOS device list', () => {
      const output = {
        devices: [
          {
            platform: 'ios' as const,
            udid: 'ABCD-1234-EFGH-5678',
            name: 'iPhone 16 Pro',
            state: 'Booted',
            osVersion: 'iOS 18.1',
            isAvailable: true,
          },
        ],
        total: 1,
      };
      const result = ListDevicesOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept Android device in list', () => {
      const output = {
        devices: [
          {
            platform: 'android' as const,
            udid: 'emulator-5554',
            name: 'Pixel 7 API 34',
            state: 'Booted',
          },
        ],
        total: 1,
      };
      const result = ListDevicesOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('ListFlowsOutputSchema', () => {
    it('should accept empty list', () => {
      const output = { flows: [], flowsDir: '/foo/flows', total: 0 };
      const result = ListFlowsOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept entries with full metadata', () => {
      const output = {
        flows: [
          {
            name: 'login',
            path: '/foo/flows/login.yaml',
            description: 'Login flow',
            tags: ['auth', 'setup'],
            params: {
              username: { required: true, default: 'admin', description: 'Username' },
              password: { required: true, default: 'admin' },
            },
          },
          { name: 'navigate-to-settings', path: '/foo/flows/navigate-to-settings.yaml' },
        ],
        flowsDir: '/foo/flows',
        total: 2,
      };
      const result = ListFlowsOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('RunFlowOutputSchema', () => {
    it('should accept minimal output', () => {
      const output = {
        passed: true,
        flowName: 'login',
        flowPath: '/foo/flows/login.yaml',
        appliedParams: {},
        output: 'Flow completed',
        durationMs: 1234,
      };
      const result = RunFlowOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('should accept output with applied params and stub port', () => {
      const output = {
        passed: false,
        flowName: 'login',
        flowPath: '/foo/flows/login.yaml',
        appliedParams: { USERNAME: 'admin', PASSWORD: 'admin' },
        output: 'Element not found',
        stubServerPort: 3030,
        durationMs: 5678,
      };
      const result = RunFlowOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('BuildAppOutputSchema', () => {
    it('should accept iOS success output', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        appPath: '/tmp/build/Build/Products/Debug-iphonesimulator/MyApp.app',
        bundleId: 'com.example.MyApp',
        derivedDataPath: '/tmp/build',
        durationMs: 120000,
        output: 'Build succeeded',
      };
      expect(BuildAppOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should accept Android success output', () => {
      const output = {
        passed: true,
        platform: 'android' as const,
        appPath: '/project/app/build/outputs/apk/debug/app-debug.apk',
        module: 'app',
        variant: 'debug',
        durationMs: 60000,
        output: 'BUILD SUCCESSFUL',
      };
      expect(BuildAppOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should accept failure output without appPath', () => {
      const output = {
        passed: false,
        platform: 'ios' as const,
        durationMs: 5000,
        output: 'error: no such scheme',
      };
      expect(BuildAppOutputSchema.safeParse(output).success).toBe(true);
    });
  });

  describe('InstallAppOutputSchema', () => {
    it('should accept iOS install output with bundleId', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        deviceUdid: 'ABCD-1234',
        bundleId: 'com.example.MyApp',
        durationMs: 3000,
        output: '',
      };
      expect(InstallAppOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should accept Android install output without bundleId', () => {
      const output = {
        passed: true,
        platform: 'android' as const,
        deviceUdid: 'emulator-5554',
        durationMs: 4000,
        output: 'Success',
      };
      expect(InstallAppOutputSchema.safeParse(output).success).toBe(true);
    });
  });

  describe('UninstallAppOutputSchema', () => {
    it('should accept valid output', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        deviceUdid: 'ABCD-1234',
        bundleId: 'com.example.MyApp',
        durationMs: 500,
        output: '',
      };
      expect(UninstallAppOutputSchema.safeParse(output).success).toBe(true);
    });
  });

  describe('BootSimulatorOutputSchema', () => {
    it('should accept booted result', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        deviceUdid: 'ABCD-1234',
        state: 'Booted',
        alreadyBooted: false,
        durationMs: 15000,
        output: '',
      };
      expect(BootSimulatorOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should accept alreadyBooted result', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        deviceUdid: 'ABCD-1234',
        state: 'Booted',
        alreadyBooted: true,
        durationMs: 150,
        output: '',
      };
      expect(BootSimulatorOutputSchema.safeParse(output).success).toBe(true);
    });
  });

  describe('TakeScreenshotOutputSchema', () => {
    it('should accept a successful capture', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        deviceUdid: 'ABCD-1234',
        imagePath: '/tmp/mobile-automator-screenshots/screenshot-1.png',
        sizeBytes: 204800,
        durationMs: 350,
        output: '',
      };
      expect(TakeScreenshotOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should accept a failed capture without sizeBytes', () => {
      const output = {
        passed: false,
        platform: 'android' as const,
        deviceUdid: 'emulator-5554',
        imagePath: '/tmp/mobile-automator-screenshots/screenshot-2.png',
        durationMs: 12,
        output: 'error: device offline',
      };
      expect(TakeScreenshotOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should reject negative sizeBytes', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        deviceUdid: 'ABCD-1234',
        imagePath: '/tmp/s.png',
        sizeBytes: -1,
        durationMs: 100,
        output: '',
      };
      expect(TakeScreenshotOutputSchema.safeParse(output).success).toBe(false);
    });
  });

  describe('RunUnitTestsOutputSchema', () => {
    it('should accept a passing iOS run', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        totalTests: 10,
        passedTests: 10,
        failedTests: 0,
        skippedTests: 0,
        failures: [],
        durationMs: 42000,
        resultBundlePath: '/tmp/mobile-automator-tests/run.xcresult',
        output: 'Test Suite passed',
      };
      expect(RunUnitTestsOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should accept a failing Android run with failure details', () => {
      const output = {
        passed: false,
        platform: 'android' as const,
        totalTests: 5,
        passedTests: 3,
        failedTests: 2,
        skippedTests: 0,
        failures: [
          {
            name: 'com.example.MyTest.testA',
            message: 'expected:<a> but was:<b>',
          },
          {
            name: 'com.example.MyTest.testB',
            message: 'NPE',
            file: 'MyTest.java',
            line: 42,
          },
        ],
        durationMs: 15000,
        reportDir: '/app/build/test-results/testDebugUnitTest',
        output: 'BUILD FAILED',
      };
      expect(RunUnitTestsOutputSchema.safeParse(output).success).toBe(true);
    });

    it('should reject negative test counts', () => {
      const output = {
        passed: true,
        platform: 'ios' as const,
        totalTests: -1,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        failures: [],
        durationMs: 1,
        output: '',
      };
      expect(RunUnitTestsOutputSchema.safeParse(output).success).toBe(false);
    });
  });

  describe('GetSessionTimelineOutputSchema', () => {
    it('should accept valid timeline output', () => {
      const output = {
        sessionId: 'session-abc123',
        status: 'recording',
        elapsedMs: 15000,
        pollSummary: {
          totalPolls: 30,
          byResult: { baseline: 1, equal: 20, inferred: 5, error: 4 },
          starvationPeriods: 2,
          configuredIntervalMs: 500,
          actualAverageMs: 510,
        },
        interactionSummary: {
          total: 5,
          bySource: { inferred: 3, dispatched: 2 },
        },
        gaps: [
          { from: '2024-01-01T00:00:01Z', to: '2024-01-01T00:00:04Z', durationMs: 3000, reason: 'poll_starvation' },
        ],
        recentPolls: [
          { timestamp: '2024-01-01T00:00:14Z', durationMs: 120, result: 'equal' },
          { timestamp: '2024-01-01T00:00:15Z', durationMs: 130, result: 'inferred', inferredTarget: 'btn' },
        ],
      };
      const result = GetSessionTimelineOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('FeatureTestSpecSchema', () => {
    it('accepts a minimal spec', () => {
      const spec = {
        name: 'SDUI parallelism',
        appBundleId: 'com.example.app',
        actions: [{ tap: { id: 'tab-equifax' } }],
        assertions: [
          { type: 'parallelism', matcher: { pathContains: '/graphql' }, maxWindowMs: 2000, minExpectedCount: 6 },
        ],
      };
      const result = FeatureTestSpecSchema.safeParse(spec);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.setup).toEqual([]);
        expect(result.data.teardown).toEqual([]);
      }
    });

    it('accepts all documented action shapes', () => {
      const spec = {
        name: 'action-coverage',
        appBundleId: 'com.example.app',
        actions: [
          { tap: { point: { x: 100, y: 200 } } },
          { tap: { id: 'menu' } },
          { tap: { text: 'Sign in' } },
          { type: { id: 'email', text: 'a@b.c' } },
          { scroll: { direction: 'down' } },
          { wait: 1500 },
          { assertVisible: { id: 'home' } },
        ],
        assertions: [],
      };
      expect(FeatureTestSpecSchema.safeParse(spec).success).toBe(true);
    });

    it('accepts an inline mocks[] block (spec-level Proxyman gateway integration)', () => {
      const spec = {
        name: 'mocks-in-spec',
        appBundleId: 'com.example.app',
        mocks: [
          {
            id: 'login-status-override',
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
          {
            matcher: { urlPathEquals: '/api/v2/flags' },
            staticResponse: {
              status: 200,
              jsonBody: { flags: { newLogin: false } },
            },
          },
        ],
        actions: [{ tap: { id: 'go' } }],
        assertions: [],
      };
      const result = FeatureTestSpecSchema.safeParse(spec);
      expect(result.success).toBe(true);
    });

    it('rejects a mocks entry that mixes staticResponse and responseTransform', () => {
      const spec = {
        name: 'bad',
        appBundleId: 'com.example.app',
        mocks: [{
          matcher: { pathContains: '/x' },
          staticResponse: { status: 200 },
          responseTransform: { jsonPatch: [] },
        }],
        actions: [],
        assertions: [],
      };
      expect(FeatureTestSpecSchema.safeParse(spec).success).toBe(false);
    });

    it('treats omitted mocks[] as default empty array', () => {
      const spec = {
        name: 'no-mocks',
        appBundleId: 'com.example.app',
        actions: [],
        assertions: [],
      };
      const result = FeatureTestSpecSchema.safeParse(spec);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.mocks).toEqual([]);
    });

    it('accepts all eight assertion types', () => {
      const spec = {
        name: 'assertion-coverage',
        appBundleId: 'com.example.app',
        actions: [{ tap: { id: 'go' } }],
        assertions: [
          { type: 'parallelism', matcher: { pathContains: '/x' }, maxWindowMs: 2000, minExpectedCount: 2 },
          { type: 'on_screen', expectedCalls: [{ pathContains: '/x' }] },
          { type: 'absent', forbiddenCalls: [{ pathContains: '/bad' }] },
          { type: 'sequence', expectedOrder: [{ pathContains: '/a' }, { pathContains: '/b' }] },
          { type: 'performance', matcher: { pathContains: '/x' }, maxIndividualMs: 500 },
          { type: 'payload', matcher: { pathContains: '/x' }, responseAssertions: [{ path: 'data', exists: true }] },
          { type: 'deduplication', matcher: { pathContains: '/x' }, maxDuplicates: 1 },
          { type: 'error_handling', expectedErrors: [{ statusCode: 500 }] },
        ],
      };
      const result = FeatureTestSpecSchema.safeParse(spec);
      expect(result.success).toBe(true);
    });

    it('rejects an action entry with two action keys at once', () => {
      const spec = {
        name: 'bad',
        appBundleId: 'com.example.app',
        actions: [{ tap: { id: 'a' }, wait: 500 }],
        assertions: [],
      };
      expect(FeatureTestSpecSchema.safeParse(spec).success).toBe(false);
    });

    it('rejects an unknown assertion type', () => {
      const spec = {
        name: 'bad',
        appBundleId: 'com.example.app',
        actions: [],
        assertions: [{ type: 'nonsense', matcher: {} }],
      };
      expect(FeatureTestSpecSchema.safeParse(spec).success).toBe(false);
    });
  });

  describe('RunFeatureTestInputSchema', () => {
    it('accepts a string spec (file path)', () => {
      const result = RunFeatureTestInputSchema.safeParse({ spec: '/tmp/feature.yaml' });
      expect(result.success).toBe(true);
    });

    it('accepts an inline spec object with all timeout overrides', () => {
      const result = RunFeatureTestInputSchema.safeParse({
        spec: {
          name: 't',
          appBundleId: 'com.e.a',
          actions: [],
          assertions: [],
        },
        env: { TOKEN: 'abc' },
        platform: 'ios',
        flowsDir: '/repo/flows',
        stubsDir: '/repo/stubs',
        setupTimeoutMs: 90000,
        actionTimeoutMs: 20000,
        settleMs: 2000,
        driverCooldownMs: 4000,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('RunFeatureTestOutputSchema', () => {
    it('accepts a fully populated passing result', () => {
      const output = {
        passed: true,
        name: 'SDUI parallelism',
        durationMs: 82000,
        setup: {
          passed: true,
          flows: [
            { name: 'login', passed: true, durationMs: 6000 },
          ],
        },
        actions: {
          sessionId: 's-1',
          interactions: [
            { action: 'tap', element: 'point(201,186)', durationMs: 1200 },
            { action: 'wait', element: '5000ms', durationMs: 5001, waitMs: 5000 },
          ],
        },
        assertions: [
          {
            type: 'parallelism',
            passed: true,
            verdict: '6 events fired within 453ms (≤2000)',
            details: { count: 6, actualSpanMs: 453 },
          },
        ],
        teardown: {
          flows: [{ name: 'sign-out', passed: true, durationMs: 4000 }],
          compiledYamlPath: '/tmp/test-s1.yaml',
        },
      };
      const result = RunFeatureTestOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('accepts a failure result carrying an error and partial phases', () => {
      const output = {
        passed: false,
        name: 'SDUI parallelism',
        durationMs: 14000,
        setup: {
          passed: false,
          flows: [
            { name: 'login', passed: false, durationMs: 14000, error: 'Timeout waiting for splash' },
          ],
        },
        actions: { sessionId: '', interactions: [] },
        assertions: [],
        teardown: { flows: [] },
        error: 'Setup phase failed',
      };
      expect(RunFeatureTestOutputSchema.safeParse(output).success).toBe(true);
    });
  });

  describe('SetMockResponseInputSchema (session vs standalone)', () => {
    it('accepts a standalone mock with sessionId omitted (P1)', () => {
      const result = SetMockResponseInputSchema.safeParse({
        mock: {
          matcher: { pathContains: '/api/flags' },
          staticResponse: { status: 200, jsonBody: { newLogin: false } },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.sessionId).toBeUndefined();
    });
  });

  describe('SetMockResponseInputSchema', () => {
    it('accepts a jsonPatch (responseTransform) mock', () => {
      const result = SetMockResponseInputSchema.safeParse({
        sessionId: 'sess-1',
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
      expect(result.success).toBe(true);
    });

    it('accepts a staticResponse mock with explicit ID', () => {
      const result = SetMockResponseInputSchema.safeParse({
        sessionId: 'sess-1',
        mock: {
          id: 'flag-off',
          matcher: { urlPathEquals: '/api/v2/flags' },
          staticResponse: {
            status: 200,
            jsonBody: { newLogin: false },
            headers: { 'Cache-Control': 'no-store' },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a graphqlQueryName matcher (Proxyman-native filter)', () => {
      const result = SetMockResponseInputSchema.safeParse({
        sessionId: 'sess-1',
        mock: {
          matcher: { pathContains: '/graphql', graphqlQueryName: 'GetCurrentUser' },
          staticResponse: { status: 200, jsonBody: { user: null } },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects a mock with both staticResponse and responseTransform', () => {
      const result = SetMockResponseInputSchema.safeParse({
        sessionId: 'sess-1',
        mock: {
          matcher: { pathContains: '/x' },
          staticResponse: { status: 200 },
          responseTransform: { jsonPatch: [] },
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a mock with neither staticResponse nor responseTransform', () => {
      const result = SetMockResponseInputSchema.safeParse({
        sessionId: 'sess-1',
        mock: { matcher: { pathContains: '/x' } },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown JSON Patch ops', () => {
      const result = SetMockResponseInputSchema.safeParse({
        sessionId: 'sess-1',
        mock: {
          matcher: { pathContains: '/x' },
          responseTransform: { jsonPatch: [{ op: 'test', path: '/x', value: 1 }] },
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown HTTP method', () => {
      const result = SetMockResponseInputSchema.safeParse({
        sessionId: 'sess-1',
        mock: {
          matcher: { pathContains: '/x', method: 'TRACE' },
          staticResponse: { status: 200 },
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('SetMockResponseOutputSchema', () => {
    it('accepts a session-scoped output', () => {
      const result = SetMockResponseOutputSchema.safeParse({
        mockId: 'mock-abcd1234',
        proxymanRuleId: 'AC5CFB7B',
        ruleName: 'mca:sess-1:mock-abcd1234',
        scope: 'session',
        totalSessionMocks: 3,
      });
      expect(result.success).toBe(true);
    });

    it('accepts a standalone output', () => {
      const result = SetMockResponseOutputSchema.safeParse({
        mockId: 'mock-deadbeef',
        proxymanRuleId: '12345678',
        ruleName: 'mca:standalone:mock-deadbeef',
        scope: 'standalone',
        totalStandaloneMocks: 2,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('ClearMockResponsesInputSchema (3 modes)', () => {
    it('accepts session-scoped clear-all', () => {
      expect(ClearMockResponsesInputSchema.safeParse({ sessionId: 'sess-1' }).success).toBe(true);
    });

    it('accepts session-scoped clear-one', () => {
      expect(
        ClearMockResponsesInputSchema.safeParse({ sessionId: 'sess-1', mockId: 'mock-abcd' }).success,
      ).toBe(true);
    });

    it('accepts standalone clear-one (mockId only)', () => {
      expect(
        ClearMockResponsesInputSchema.safeParse({ mockId: 'mock-deadbeef' }).success,
      ).toBe(true);
    });

    it('accepts allStandalone:true', () => {
      expect(
        ClearMockResponsesInputSchema.safeParse({ allStandalone: true }).success,
      ).toBe(true);
    });

    it('rejects empty input (no scope signal)', () => {
      expect(ClearMockResponsesInputSchema.safeParse({}).success).toBe(false);
    });

    it('rejects sessionId combined with allStandalone (mutually exclusive)', () => {
      expect(
        ClearMockResponsesInputSchema.safeParse({ sessionId: 'sess-1', allStandalone: true }).success,
      ).toBe(false);
    });

    it('output accepts session scope', () => {
      expect(
        ClearMockResponsesOutputSchema.safeParse({ removed: 2, remaining: 1, scope: 'session' }).success,
      ).toBe(true);
    });

    it('output accepts standalone-one scope', () => {
      expect(
        ClearMockResponsesOutputSchema.safeParse({ removed: 1, remaining: 0, scope: 'standalone-one' }).success,
      ).toBe(true);
    });

    it('output accepts standalone-all scope', () => {
      expect(
        ClearMockResponsesOutputSchema.safeParse({ removed: 5, remaining: 0, scope: 'standalone-all' }).success,
      ).toBe(true);
    });
  });

  // ── Phase 1 admin tools ──────────────────────────────────────────────────
  describe('Admin tool schemas (Phase 1)', () => {
    it('ListActiveSessionsOutputSchema accepts a populated inventory', () => {
      const result = ListActiveSessionsOutputSchema.safeParse({
        sessions: [
          {
            sessionId: 's-1',
            appBundleId: 'com.x',
            platform: 'ios',
            status: 'recording',
            startedAt: '2026-04-27T00:00:00Z',
            driverActive: true,
            pollerActive: true,
            pollerHealth: { pollCount: 10, successCount: 9, errorCount: 1, lastPollAt: '2026-04-27T00:00:05Z' },
            mockCount: 2,
          },
          {
            sessionId: 's-2',
            appBundleId: 'com.y',
            platform: 'android',
            status: 'aborted',
            startedAt: '2026-04-27T00:00:00Z',
            stoppedAt: '2026-04-27T00:01:00Z',
            abortedReason: 'manual cleanup',
            driverActive: false,
            pollerActive: false,
            pollerHealth: null,
            mockCount: 0,
          },
        ],
        totalSessions: 2,
        totalActiveDrivers: 1,
        totalActivePollers: 1,
      });
      expect(result.success).toBe(true);
    });

    it('ListActiveMocksInputSchema accepts empty input and a sessionId filter', () => {
      expect(ListActiveMocksInputSchema.safeParse({}).success).toBe(true);
      expect(ListActiveMocksInputSchema.safeParse({ sessionId: 'sess-1' }).success).toBe(true);
    });

    it('ListActiveMocksOutputSchema accepts a drift-detected response', () => {
      const result = ListActiveMocksOutputSchema.safeParse({
        proxymanReachable: true,
        rules: [
          {
            ruleId: 'A',
            name: 'mca:s-1:m1',
            url: '*',
            enabled: true,
            scope: 'session',
            sessionId: 's-1',
            mockId: 'm1',
            inLocalLedger: true,
          },
          {
            ruleId: 'B',
            name: 'mca:standalone:m2',
            url: '*',
            enabled: true,
            scope: 'standalone',
            mockId: 'm2',
            inLocalLedger: false,
          },
          {
            ruleId: 'C',
            name: 'OtherToolRule',
            url: '*',
            enabled: true,
            scope: 'unknown',
            inLocalLedger: false,
          },
        ],
        drift: { rulesNotInLedger: ['B', 'C'], ledgerNotInProxyman: [] },
      });
      expect(result.success).toBe(true);
    });

    it('ForceCleanupSessionInputSchema applies the default reason', () => {
      const result = ForceCleanupSessionInputSchema.safeParse({ sessionId: 'x' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.reason).toBe('manual force-cleanup');
    });

    it('ForceCleanupSessionOutputSchema accepts a success result', () => {
      expect(
        ForceCleanupSessionOutputSchema.safeParse({
          sessionId: 's-1',
          pollerStopped: true,
          driverRemoved: true,
          proxymanRulesDeleted: 3,
          proxymanReachable: true,
          sessionMarkedAborted: true,
          errors: [],
        }).success,
      ).toBe(true);
    });

    it('ForceCleanupMocksInputSchema rejects scope=session without sessionId', () => {
      expect(ForceCleanupMocksInputSchema.safeParse({ scope: 'session' }).success).toBe(false);
      expect(
        ForceCleanupMocksInputSchema.safeParse({ scope: 'session', sessionId: 's' }).success,
      ).toBe(true);
      expect(ForceCleanupMocksInputSchema.safeParse({ scope: 'all' }).success).toBe(true);
      expect(ForceCleanupMocksInputSchema.safeParse({ scope: 'standalone' }).success).toBe(true);
    });

    it('ForceCleanupMocksOutputSchema accepts a partial-failure result', () => {
      expect(
        ForceCleanupMocksOutputSchema.safeParse({
          scope: 'all',
          proxymanReachable: true,
          rulesDeleted: 2,
          ledgerEntriesCleared: 4,
          errors: ['deleteRule(R3): denied'],
        }).success,
      ).toBe(true);
    });

    it('StartBuildOutputSchema accepts the immediate-return shape', () => {
      expect(
        StartBuildOutputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          kind: 'build',
          status: 'running',
          startedAt: '2026-04-27T00:00:00.000Z',
        }).success,
      ).toBe(true);
    });

    it('PollTaskStatusInputSchema rejects out-of-range tailLines', () => {
      expect(
        PollTaskStatusInputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          tailLines: 600,
        }).success,
      ).toBe(false);
    });

    it('PollTaskStatusOutputSchema accepts a running task projection', () => {
      expect(
        PollTaskStatusOutputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          kind: 'build',
          status: 'running',
          startedAt: '2026-04-27T00:00:00.000Z',
          durationMs: 1234,
          recentOutputLines: ['xcodebuild ...', '** BUILD SUCCEEDED **'],
          lineCount: 2,
        }).success,
      ).toBe(true);
    });

    it('PollTaskStatusOutputSchema accepts notFound shape (no kind/startedAt)', () => {
      // notFound responses don't fabricate `kind` or `startedAt` — both are
      // now optional in the schema.
      expect(
        PollTaskStatusOutputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          status: 'failed',
          durationMs: 0,
          recentOutputLines: [],
          lineCount: 0,
          notFound: true,
        }).success,
      ).toBe(true);
    });

    it('GetTaskResultInputSchema requires uuid', () => {
      expect(
        GetTaskResultInputSchema.safeParse({ taskId: 'not-a-uuid' }).success,
      ).toBe(false);
    });

    it('GetTaskResultOutputSchema accepts a completed-build result', () => {
      expect(
        GetTaskResultOutputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          status: 'done',
          result: {
            kind: 'build',
            build: {
              passed: true,
              platform: 'ios',
              appPath: '/tmp/X.app',
              bundleId: 'com.example.app',
              durationMs: 60000,
              output: '** BUILD SUCCEEDED **',
            },
          },
        }).success,
      ).toBe(true);
    });

    it('GetTaskResultOutputSchema accepts notFound and not-yet-done shapes', () => {
      expect(
        GetTaskResultOutputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          status: 'failed',
          notFound: true,
          error: 'Task not found or pruned',
        }).success,
      ).toBe(true);
    });

    it('CancelTaskInputSchema accepts optional reason', () => {
      expect(
        CancelTaskInputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
        }).success,
      ).toBe(true);
      expect(
        CancelTaskInputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          reason: 'user clicked cancel',
        }).success,
      ).toBe(true);
    });

    it('CancelTaskOutputSchema accepts cancelled and notFound shapes', () => {
      expect(
        CancelTaskOutputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          cancelled: true,
          previousStatus: 'running',
          finalStatus: 'cancelled',
        }).success,
      ).toBe(true);
      expect(
        CancelTaskOutputSchema.safeParse({
          taskId: '550e8400-e29b-41d4-a716-446655440000',
          cancelled: false,
          notFound: true,
        }).success,
      ).toBe(true);
    });

    it('ListTasksInputSchema accepts kind/status/since filters', () => {
      expect(
        ListTasksInputSchema.safeParse({
          kind: 'build',
          status: ['done', 'failed'],
          since: '2026-04-27T00:00:00.000Z',
        }).success,
      ).toBe(true);
    });

    it('ListTasksOutputSchema accepts an empty list and a populated list', () => {
      expect(
        ListTasksOutputSchema.safeParse({ tasks: [], totalTasks: 0 }).success,
      ).toBe(true);
      expect(
        ListTasksOutputSchema.safeParse({
          tasks: [
            {
              taskId: '550e8400-e29b-41d4-a716-446655440000',
              kind: 'build',
              status: 'done',
              startedAt: '2026-04-27T00:00:00.000Z',
              finishedAt: '2026-04-27T00:01:00.000Z',
              durationMs: 60000,
              lineCount: 250,
            },
          ],
          totalTasks: 1,
        }).success,
      ).toBe(true);
    });

    it('AuditStateOutputSchema accepts a full snapshot', () => {
      expect(
        AuditStateOutputSchema.safeParse({
          generatedAt: '2026-04-27T00:00:00Z',
          sessions: { total: 2, byStatus: { recording: 1, done: 1 } },
          drivers: { active: 1, sessionIds: ['s-1'] },
          pollers: { active: 1, sessionIds: ['s-1'] },
          proxyman: {
            reachable: true,
            totalRules: 5,
            mcaTaggedRules: 3,
            rulesByTagPrefix: { 'mca:s-1:': 2, 'mca:standalone': 1 },
          },
          orphans: {
            proxymanRulesWithoutSession: ['ORPHAN-1'],
            sessionsWithoutDriver: [],
            pollersWithoutSession: [],
          },
        }).success,
      ).toBe(true);
    });
  });
});
