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
        stubsDir: '/tmp/session-abc123/wiremock/mappings',
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
});
