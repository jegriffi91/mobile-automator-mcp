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
});
