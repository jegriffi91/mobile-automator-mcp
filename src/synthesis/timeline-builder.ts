/**
 * TimelineBuilder — Assembles a unified chronological timeline from
 * session recording data for post-hoc debugging and analysis.
 *
 * This is a pure function module — no side effects, no I/O.
 * All data is provided at build time from the compile pipeline.
 */

import type { Session, UIInteraction, NetworkEvent } from '../types.js';
import type { CorrelatedStep } from './correlator.js';
import type { PollRecord, PollingStatus } from '../session/touch-inferrer.js';
import type { WovenFlowExecution, FlowStep } from './flow-weaver.js';

// ── Timeline data model ──

export type TimelineEntry =
  | TimelineLifecycleEntry
  | TimelinePollEntry
  | TimelineInteractionEntry
  | TimelineNetworkEntry
  | TimelineCorrelationEntry
  | TimelineFlowEntry;

export interface TimelineLifecycleEntry {
  type: 'lifecycle';
  timestamp: string;
  event: string;
  detail?: string;
}

export interface TimelinePollEntry {
  type: 'poll';
  timestamp: string;
  durationMs: number;
  result: PollRecord['result'];
  elementCount?: number;
  inferredTarget?: string;
  error?: string;
}

export interface TimelineInteractionEntry {
  type: 'interaction';
  timestamp: string;
  source: string;
  actionType: string;
  target: string;
  stepIndex?: number;
}

export interface TimelineNetworkEntry {
  type: 'network';
  timestamp: string;
  method: string;
  url: string;
  statusCode: number;
  durationMs?: number;
  correlatedToStep?: number;
}

export interface TimelineCorrelationEntry {
  type: 'correlation';
  timestamp: string;
  stepIndex: number;
  interactionTarget: string;
  matchedEventCount: number;
}

/**
 * Phase 5: a single woven flow execution rendered as a timeline entry.
 * Replaces the synthetic flow_boundary poll pair that Phase 4 emitted.
 */
export interface TimelineFlowEntry {
  type: 'flow';
  timestamp: string;
  endTimestamp: string;
  durationMs: number;
  flowName: string;
  flowPath?: string;
  succeeded: boolean;
  cancelled?: boolean;
  steps: FlowStep[];
}

export interface TimelineGap {
  from: string;
  to: string;
  durationMs: number;
  reason: 'no_polls' | 'poll_starvation' | 'poll_errors';
}

export interface TimelineCoverage {
  totalInteractions: number;
  bySource: Record<string, number>;
  totalNetworkEvents: number;
  matchedNetworkEvents: number;
  unmatchedNetworkEvents: number;
  correlationWindowMs: number;
  pollCoverage: {
    configuredIntervalMs: number;
    actualAverageMs?: number;
    starvationPeriods: number;
    totalPolls: number;
  };
  gaps: TimelineGap[];
}

export interface SessionTimeline {
  sessionId: string;
  appBundleId: string;
  platform: string;
  startedAt: string;
  stoppedAt?: string;
  config: {
    captureMode: string;
    pollingIntervalMs: number;
    settleTimeoutMs: number;
    filterDomains?: string[];
    trackEventPaths?: string[];
  };
  readiness: {
    driverReady: boolean;
    baselineCaptured: boolean;
    pollerStarted: boolean;
  };
  pollingDiagnostics?: PollingStatus;
  entries: TimelineEntry[];
  coverage: TimelineCoverage;
}

export interface TimelineBuildParams {
  session: Session;
  readiness: {
    driverReady: boolean;
    baselineCaptured: boolean;
    pollerStarted: boolean;
  };
  interactions: UIInteraction[];
  networkEvents: NetworkEvent[];
  correlatedSteps: CorrelatedStep[];
  pollRecords: PollRecord[];
  pollingDiagnostics?: PollingStatus;
  correlationWindowMs: number;
  /** Phase 5: woven flow executions to render as 'flow' entries. */
  wovenFlowExecutions?: WovenFlowExecution[];
}

// ── Builder ──

export class TimelineBuilder {
  /**
   * Build the complete timeline from compile-time data.
   */
  build(params: TimelineBuildParams): SessionTimeline {
    const {
      session,
      readiness,
      interactions,
      networkEvents,
      correlatedSteps,
      pollRecords,
      pollingDiagnostics,
      correlationWindowMs,
      wovenFlowExecutions,
    } = params;

    // Build reverse lookup: network event URL|timestamp → correlated step index
    const networkToStep = new Map<string, number>();
    for (const step of correlatedSteps) {
      for (const event of step.networkEvents) {
        networkToStep.set(`${event.url}|${event.timestamp}`, step.index);
      }
    }

    // Build reverse lookup: interaction timestamp → correlated step index
    const interactionToStep = new Map<string, number>();
    for (const step of correlatedSteps) {
      interactionToStep.set(step.interaction.timestamp, step.index);
    }

    // Assemble all entries
    const entries: TimelineEntry[] = [
      ...this.buildLifecycleEntries(session),
      ...this.buildPollEntries(pollRecords),
      ...this.buildInteractionEntries(interactions, interactionToStep),
      ...this.buildNetworkEntries(networkEvents, networkToStep),
      ...this.buildCorrelationEntries(correlatedSteps),
      ...this.buildFlowEntries(wovenFlowExecutions ?? []),
    ];

    // Sort chronologically
    entries.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // Compute coverage
    const coverage = this.buildCoverage(
      interactions,
      networkEvents,
      networkToStep,
      pollRecords,
      correlationWindowMs,
      session.pollingIntervalMs ?? 500,
    );

    return {
      sessionId: session.id,
      appBundleId: session.appBundleId,
      platform: session.platform,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      config: {
        captureMode: session.captureMode ?? 'event-triggered',
        pollingIntervalMs: session.pollingIntervalMs ?? 500,
        settleTimeoutMs: session.settleTimeoutMs ?? 3000,
        filterDomains: session.filterDomains,
        trackEventPaths: session.trackEventPaths,
      },
      readiness,
      pollingDiagnostics,
      entries,
      coverage,
    };
  }

  // ── Private builders ──

  private buildLifecycleEntries(session: Session): TimelineLifecycleEntry[] {
    const entries: TimelineLifecycleEntry[] = [
      {
        type: 'lifecycle',
        timestamp: session.startedAt,
        event: 'session_started',
        detail: `App: ${session.appBundleId}, Platform: ${session.platform}`,
      },
    ];
    if (session.stoppedAt) {
      entries.push({
        type: 'lifecycle',
        timestamp: session.stoppedAt,
        event: 'session_stopped',
      });
    }
    return entries;
  }

  private buildPollEntries(pollRecords: PollRecord[]): TimelinePollEntry[] {
    // Phase 5: skip flow_boundary records — Woven flow entries replace them.
    // The weaver typically strips these already; this is a defensive filter
    // for callers that pass the raw stream.
    return pollRecords
      .filter((r) => r.result !== 'flow_boundary')
      .map((r) => ({
        type: 'poll' as const,
        timestamp: r.timestamp,
        durationMs: r.durationMs,
        result: r.result,
        elementCount: r.elementCount,
        inferredTarget: r.inferredTarget,
        error: r.error,
      }));
  }

  private buildFlowEntries(woven: WovenFlowExecution[]): TimelineFlowEntry[] {
    return woven.map((w) => ({
      type: 'flow' as const,
      timestamp: w.startedAt,
      endTimestamp: w.endedAt,
      durationMs: w.durationMs,
      flowName: w.flowName,
      ...(w.flowPath !== undefined ? { flowPath: w.flowPath } : {}),
      succeeded: w.succeeded,
      ...(w.cancelled !== undefined ? { cancelled: w.cancelled } : {}),
      steps: w.steps,
    }));
  }

  private buildInteractionEntries(
    interactions: UIInteraction[],
    interactionToStep: Map<string, number>,
  ): TimelineInteractionEntry[] {
    return interactions.map((i) => ({
      type: 'interaction' as const,
      timestamp: i.timestamp,
      source: i.source ?? 'dispatched',
      actionType: i.actionType,
      target: i.element.id || i.element.accessibilityLabel || i.element.text || 'unknown',
      stepIndex: interactionToStep.get(i.timestamp),
    }));
  }

  private buildNetworkEntries(
    networkEvents: NetworkEvent[],
    networkToStep: Map<string, number>,
  ): TimelineNetworkEntry[] {
    return networkEvents.map((e) => ({
      type: 'network' as const,
      timestamp: e.timestamp,
      method: e.method,
      url: e.url,
      statusCode: e.statusCode,
      durationMs: e.durationMs,
      correlatedToStep: networkToStep.get(`${e.url}|${e.timestamp}`),
    }));
  }

  private buildCorrelationEntries(
    correlatedSteps: CorrelatedStep[],
  ): TimelineCorrelationEntry[] {
    return correlatedSteps
      .filter((s) => s.networkEvents.length > 0)
      .map((s) => ({
        type: 'correlation' as const,
        timestamp: s.interaction.timestamp,
        stepIndex: s.index,
        interactionTarget:
          s.interaction.element.id ||
          s.interaction.element.accessibilityLabel ||
          s.interaction.element.text ||
          'unknown',
        matchedEventCount: s.networkEvents.length,
      }));
  }

  /**
   * Build coverage stats and gap analysis.
   */
  private buildCoverage(
    interactions: UIInteraction[],
    networkEvents: NetworkEvent[],
    networkToStep: Map<string, number>,
    pollRecords: PollRecord[],
    correlationWindowMs: number,
    configuredIntervalMs: number,
  ): TimelineCoverage {
    // Count interactions by source
    const bySource: Record<string, number> = {};
    for (const i of interactions) {
      const src = i.source ?? 'dispatched';
      bySource[src] = (bySource[src] ?? 0) + 1;
    }

    // Count matched vs unmatched network events
    let matchedCount = 0;
    for (const e of networkEvents) {
      if (networkToStep.has(`${e.url}|${e.timestamp}`)) {
        matchedCount++;
      }
    }

    // Detect poll starvation and gaps
    const { starvationPeriods, gaps } = this.detectGaps(
      pollRecords,
      configuredIntervalMs,
    );

    // Compute average poll rate
    let actualAverageMs: number | undefined;
    if (pollRecords.length >= 2) {
      const first = new Date(pollRecords[0].timestamp).getTime();
      const last = new Date(pollRecords[pollRecords.length - 1].timestamp).getTime();
      actualAverageMs = Math.round((last - first) / (pollRecords.length - 1));
    }

    return {
      totalInteractions: interactions.length,
      bySource,
      totalNetworkEvents: networkEvents.length,
      matchedNetworkEvents: matchedCount,
      unmatchedNetworkEvents: networkEvents.length - matchedCount,
      correlationWindowMs,
      pollCoverage: {
        configuredIntervalMs,
        actualAverageMs,
        starvationPeriods,
        totalPolls: pollRecords.length,
      },
      gaps,
    };
  }

  /**
   * Detect gaps in polling where the interval between consecutive polls
   * exceeds 2× the configured interval. These represent periods where
   * user interactions may have been missed.
   */
  private detectGaps(
    pollRecords: PollRecord[],
    configuredIntervalMs: number,
  ): { starvationPeriods: number; gaps: TimelineGap[] } {
    const gaps: TimelineGap[] = [];
    let starvationPeriods = 0;
    const threshold = configuredIntervalMs * 2;

    for (let i = 1; i < pollRecords.length; i++) {
      const prevTime = new Date(pollRecords[i - 1].timestamp).getTime();
      const currTime = new Date(pollRecords[i].timestamp).getTime();
      const delta = currTime - prevTime;

      if (delta > threshold) {
        starvationPeriods++;

        // Determine the most likely reason
        const prevRecord = pollRecords[i - 1];
        let reason: TimelineGap['reason'] = 'poll_starvation';
        if (prevRecord.result === 'error') {
          reason = 'poll_errors';
        } else if (prevRecord.durationMs > configuredIntervalMs) {
          reason = 'poll_starvation';
        } else {
          reason = 'no_polls';
        }

        gaps.push({
          from: pollRecords[i - 1].timestamp,
          to: pollRecords[i].timestamp,
          durationMs: delta,
          reason,
        });
      }
    }

    return { starvationPeriods, gaps };
  }
}
