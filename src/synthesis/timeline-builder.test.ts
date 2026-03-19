import { describe, it, expect } from 'vitest';
import { TimelineBuilder } from './timeline-builder.js';
import type { TimelineBuildParams } from './timeline-builder.js';
import type { Session, UIInteraction, NetworkEvent } from '../types.js';
import type { CorrelatedStep } from './correlator.js';
import type { PollRecord } from '../session/touch-inferrer.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session',
    appBundleId: 'com.example.app',
    platform: 'ios',
    status: 'compiling',
    startedAt: '2024-01-01T00:00:00.000Z',
    stoppedAt: '2024-01-01T00:01:00.000Z',
    captureMode: 'polling',
    pollingIntervalMs: 500,
    settleTimeoutMs: 3000,
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<UIInteraction> = {}): UIInteraction {
  return {
    sessionId: 'test-session',
    timestamp: '2024-01-01T00:00:05.000Z',
    actionType: 'tap',
    element: { id: 'login-btn', role: 'button' },
    source: 'inferred',
    ...overrides,
  };
}

function makeNetworkEvent(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
  return {
    sessionId: 'test-session',
    timestamp: '2024-01-01T00:00:06.000Z',
    method: 'POST',
    url: 'https://api.example.com/login',
    statusCode: 200,
    ...overrides,
  };
}

function makePollRecord(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    timestamp: '2024-01-01T00:00:01.000Z',
    durationMs: 120,
    result: 'equal',
    ...overrides,
  };
}

function makeCorrelatedStep(
  index: number,
  interaction: UIInteraction,
  networkEvents: NetworkEvent[] = [],
): CorrelatedStep {
  return {
    index,
    interaction,
    networkEvents,
    networkCaptures: networkEvents.map((e) => ({
      event: e,
      requestPattern: { method: e.method, pathPattern: '/login' },
      fixtureId: 'post_login',
    })),
  };
}

describe('TimelineBuilder', () => {
  const builder = new TimelineBuilder();

  function buildParams(overrides: Partial<TimelineBuildParams> = {}): TimelineBuildParams {
    return {
      session: makeSession(),
      readiness: { driverReady: true, baselineCaptured: true, pollerStarted: true },
      interactions: [],
      networkEvents: [],
      correlatedSteps: [],
      pollRecords: [],
      pollingDiagnostics: undefined,
      correlationWindowMs: 3000,
      ...overrides,
    };
  }

  describe('basic structure', () => {
    it('should produce a valid timeline for an empty session', () => {
      const timeline = builder.build(buildParams());

      expect(timeline.sessionId).toBe('test-session');
      expect(timeline.appBundleId).toBe('com.example.app');
      expect(timeline.platform).toBe('ios');
      expect(timeline.startedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(timeline.stoppedAt).toBe('2024-01-01T00:01:00.000Z');
      expect(timeline.readiness.driverReady).toBe(true);
      expect(timeline.entries.length).toBeGreaterThanOrEqual(2); // start + stop lifecycle
    });

    it('should include session config', () => {
      const timeline = builder.build(buildParams({
        session: makeSession({
          filterDomains: ['api.example.com'],
          trackEventPaths: ['/__track'],
        }),
      }));

      expect(timeline.config.captureMode).toBe('polling');
      expect(timeline.config.pollingIntervalMs).toBe(500);
      expect(timeline.config.filterDomains).toEqual(['api.example.com']);
      expect(timeline.config.trackEventPaths).toEqual(['/__track']);
    });
  });

  describe('entries', () => {
    it('should include lifecycle entries for session start and stop', () => {
      const timeline = builder.build(buildParams());
      const lifecycle = timeline.entries.filter((e) => e.type === 'lifecycle');

      expect(lifecycle.length).toBe(2);
      expect(lifecycle[0].event).toBe('session_started');
      expect(lifecycle[1].event).toBe('session_stopped');
    });

    it('should include poll entries from PollRecords', () => {
      const pollRecords: PollRecord[] = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z', result: 'baseline', elementCount: 25 }),
        makePollRecord({ timestamp: '2024-01-01T00:00:02.000Z', result: 'equal' }),
        makePollRecord({ timestamp: '2024-01-01T00:00:03.000Z', result: 'inferred', inferredTarget: 'login-btn' }),
      ];

      const timeline = builder.build(buildParams({ pollRecords }));
      const polls = timeline.entries.filter((e) => e.type === 'poll');

      expect(polls.length).toBe(3);
      expect(polls[0].result).toBe('baseline');
      expect(polls[0].elementCount).toBe(25);
      expect(polls[2].result).toBe('inferred');
      expect(polls[2].inferredTarget).toBe('login-btn');
    });

    it('should include interaction entries with step index', () => {
      const interaction = makeInteraction();
      const step = makeCorrelatedStep(0, interaction);

      const timeline = builder.build(buildParams({
        interactions: [interaction],
        correlatedSteps: [step],
      }));

      const interactions = timeline.entries.filter((e) => e.type === 'interaction');
      expect(interactions.length).toBe(1);
      expect(interactions[0].target).toBe('login-btn');
      expect(interactions[0].stepIndex).toBe(0);
      expect(interactions[0].source).toBe('inferred');
    });

    it('should include network entries with correlation', () => {
      const interaction = makeInteraction();
      const networkEvent = makeNetworkEvent();
      const step = makeCorrelatedStep(0, interaction, [networkEvent]);

      const timeline = builder.build(buildParams({
        interactions: [interaction],
        networkEvents: [networkEvent],
        correlatedSteps: [step],
      }));

      const networks = timeline.entries.filter((e) => e.type === 'network');
      expect(networks.length).toBe(1);
      expect(networks[0].url).toBe('https://api.example.com/login');
      expect(networks[0].correlatedToStep).toBe(0);
    });

    it('should mark uncorrelated network events', () => {
      const networkEvent = makeNetworkEvent();

      const timeline = builder.build(buildParams({
        networkEvents: [networkEvent],
        correlatedSteps: [], // no correlated steps
      }));

      const networks = timeline.entries.filter((e) => e.type === 'network');
      expect(networks[0].correlatedToStep).toBeUndefined();
    });

    it('should include correlation summary entries', () => {
      const interaction = makeInteraction();
      const networkEvent = makeNetworkEvent();
      const step = makeCorrelatedStep(0, interaction, [networkEvent]);

      const timeline = builder.build(buildParams({
        interactions: [interaction],
        networkEvents: [networkEvent],
        correlatedSteps: [step],
      }));

      const correlations = timeline.entries.filter((e) => e.type === 'correlation');
      expect(correlations.length).toBe(1);
      expect(correlations[0].stepIndex).toBe(0);
      expect(correlations[0].matchedEventCount).toBe(1);
    });

    it('should sort all entries chronologically', () => {
      const interaction = makeInteraction({ timestamp: '2024-01-01T00:00:05.000Z' });
      const networkEvent = makeNetworkEvent({ timestamp: '2024-01-01T00:00:06.000Z' });
      const pollRecord = makePollRecord({ timestamp: '2024-01-01T00:00:03.000Z' });

      const timeline = builder.build(buildParams({
        interactions: [interaction],
        networkEvents: [networkEvent],
        pollRecords: [pollRecord],
      }));

      // Verify entries are sorted
      for (let i = 1; i < timeline.entries.length; i++) {
        const prev = new Date(timeline.entries[i - 1].timestamp).getTime();
        const curr = new Date(timeline.entries[i].timestamp).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });
  });

  describe('coverage', () => {
    it('should count interactions by source', () => {
      const interactions = [
        makeInteraction({ source: 'dispatched', timestamp: '2024-01-01T00:00:02.000Z' }),
        makeInteraction({ source: 'inferred', timestamp: '2024-01-01T00:00:03.000Z' }),
        makeInteraction({ source: 'inferred', timestamp: '2024-01-01T00:00:04.000Z' }),
        makeInteraction({ source: 'inferred-transition', timestamp: '2024-01-01T00:00:05.000Z' }),
        makeInteraction({ source: 'tracked', timestamp: '2024-01-01T00:00:06.000Z' }),
      ];

      const timeline = builder.build(buildParams({ interactions }));

      expect(timeline.coverage.totalInteractions).toBe(5);
      expect(timeline.coverage.bySource).toEqual({
        dispatched: 1,
        inferred: 2,
        'inferred-transition': 1,
        tracked: 1,
      });
    });

    it('should count matched vs unmatched network events', () => {
      const interaction = makeInteraction();
      const matched = makeNetworkEvent({ url: 'https://api.example.com/login' });
      const unmatched = makeNetworkEvent({
        url: 'https://cdn.example.com/image.png',
        timestamp: '2024-01-01T00:00:30.000Z',
      });
      const step = makeCorrelatedStep(0, interaction, [matched]);

      const timeline = builder.build(buildParams({
        interactions: [interaction],
        networkEvents: [matched, unmatched],
        correlatedSteps: [step],
      }));

      expect(timeline.coverage.matchedNetworkEvents).toBe(1);
      expect(timeline.coverage.unmatchedNetworkEvents).toBe(1);
    });

    it('should report poll coverage stats', () => {
      const pollRecords = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z' }),
        makePollRecord({ timestamp: '2024-01-01T00:00:02.000Z' }),
        makePollRecord({ timestamp: '2024-01-01T00:00:03.000Z' }),
      ];

      const timeline = builder.build(buildParams({ pollRecords }));

      expect(timeline.coverage.pollCoverage.configuredIntervalMs).toBe(500);
      expect(timeline.coverage.pollCoverage.totalPolls).toBe(3);
      expect(timeline.coverage.pollCoverage.actualAverageMs).toBe(1000);
    });
  });

  describe('gap detection', () => {
    it('should detect no gaps in tightly-spaced polls', () => {
      const pollRecords = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z' }),
        makePollRecord({ timestamp: '2024-01-01T00:00:01.500Z' }),
        makePollRecord({ timestamp: '2024-01-01T00:00:02.000Z' }),
      ];

      const timeline = builder.build(buildParams({ pollRecords }));
      expect(timeline.coverage.gaps.length).toBe(0);
      expect(timeline.coverage.pollCoverage.starvationPeriods).toBe(0);
    });

    it('should detect a gap when poll interval exceeds 2x configured', () => {
      const pollRecords = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z' }),
        // 3-second gap (6x the 500ms configured interval)
        makePollRecord({ timestamp: '2024-01-01T00:00:04.000Z' }),
      ];

      const timeline = builder.build(buildParams({ pollRecords }));
      expect(timeline.coverage.gaps.length).toBe(1);
      expect(timeline.coverage.gaps[0].durationMs).toBe(3000);
      expect(timeline.coverage.pollCoverage.starvationPeriods).toBe(1);
    });

    it('should detect poll starvation when read duration exceeds interval', () => {
      const pollRecords = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z', durationMs: 600 }),
        // Gap because previous poll took longer than interval
        makePollRecord({ timestamp: '2024-01-01T00:00:03.000Z', durationMs: 120 }),
      ];

      const timeline = builder.build(buildParams({ pollRecords }));
      expect(timeline.coverage.gaps.length).toBe(1);
      expect(timeline.coverage.gaps[0].reason).toBe('poll_starvation');
    });

    it('should detect error-caused gaps', () => {
      const pollRecords = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z', result: 'error', error: 'daemon crashed' }),
        makePollRecord({ timestamp: '2024-01-01T00:00:04.000Z' }),
      ];

      const timeline = builder.build(buildParams({ pollRecords }));
      expect(timeline.coverage.gaps.length).toBe(1);
      expect(timeline.coverage.gaps[0].reason).toBe('poll_errors');
    });

    it('should detect multiple gaps', () => {
      const pollRecords = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z' }),
        makePollRecord({ timestamp: '2024-01-01T00:00:04.000Z' }), // gap 1
        makePollRecord({ timestamp: '2024-01-01T00:00:05.000Z' }),  // normal
        makePollRecord({ timestamp: '2024-01-01T00:00:10.000Z' }), // gap 2
      ];

      const timeline = builder.build(buildParams({ pollRecords }));
      expect(timeline.coverage.gaps.length).toBe(2);
      expect(timeline.coverage.pollCoverage.starvationPeriods).toBe(2);
    });
  });

  describe('full scenario: login flow', () => {
    it('should capture a complete login recording scenario', () => {
      const pollRecords: PollRecord[] = [
        makePollRecord({ timestamp: '2024-01-01T00:00:01.000Z', result: 'baseline', elementCount: 25, durationMs: 480 }),
        makePollRecord({ timestamp: '2024-01-01T00:00:03.500Z', result: 'equal', durationMs: 510 }),
        makePollRecord({ timestamp: '2024-01-01T00:00:06.900Z', result: 'inferred-transition', inferredTarget: 'login-btn', durationMs: 490 }),
        makePollRecord({ timestamp: '2024-01-01T00:00:10.300Z', result: 'inferred', inferredTarget: 'dashboard', durationMs: 520 }),
      ];

      const interaction1 = makeInteraction({
        timestamp: '2024-01-01T00:00:06.900Z',
        element: { id: 'login-btn', role: 'button' },
        source: 'inferred-transition',
      });
      const interaction2 = makeInteraction({
        timestamp: '2024-01-01T00:00:10.300Z',
        element: { id: 'dashboard', role: 'view' },
        source: 'inferred',
      });

      const networkEvent = makeNetworkEvent({
        timestamp: '2024-01-01T00:00:07.500Z',
        method: 'POST',
        url: 'https://api.example.com/login',
      });

      const step1 = makeCorrelatedStep(0, interaction1, [networkEvent]);
      const step2 = makeCorrelatedStep(1, interaction2, []);

      const timeline = builder.build(buildParams({
        pollRecords,
        interactions: [interaction1, interaction2],
        networkEvents: [networkEvent],
        correlatedSteps: [step1, step2],
      }));

      // Verify comprehensive coverage
      expect(timeline.coverage.totalInteractions).toBe(2);
      expect(timeline.coverage.bySource['inferred-transition']).toBe(1);
      expect(timeline.coverage.bySource['inferred']).toBe(1);
      expect(timeline.coverage.matchedNetworkEvents).toBe(1);
      expect(timeline.coverage.unmatchedNetworkEvents).toBe(0);

      // poll gaps visible (2.5s and 3.4s gaps with 500ms config)
      expect(timeline.coverage.gaps.length).toBe(3);

      // All entries sorted
      for (let i = 1; i < timeline.entries.length; i++) {
        const prev = new Date(timeline.entries[i - 1].timestamp).getTime();
        const curr = new Date(timeline.entries[i].timestamp).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });
  });
});
