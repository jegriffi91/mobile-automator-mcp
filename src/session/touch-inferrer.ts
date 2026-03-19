/**
 * TouchInferrer — Passive touch detection via hierarchy diffing.
 *
 * Periodically snapshots the UI hierarchy during a recording session,
 * diffs consecutive snapshots, and infers UIInteraction records from
 * detected changes. This enables "user-driven" recording sessions where
 * the user taps the simulator manually.
 *
 * Architecture note: This module imports from maestro/ (HierarchyParser,
 * HierarchyDiffer) for read-only hierarchy analysis. It logs inferred
 * interactions through SessionManager.
 */

import type { UIInteraction, UIElement, UIActionType, StateChange, UIHierarchyNode } from '../types.js';
import { HierarchyDiffer, flattenToElements } from '../maestro/hierarchy-differ.js';

/** Health status returned by TouchInferrer.getStatus() */
export interface PollingStatus {
  pollCount: number;
  successCount: number;
  errorCount: number;
  inferredCount: number;
  lastError?: string;
  /** ms since polling started */
  elapsedMs?: number;
  /** Expected poll count based on elapsed time and configured interval */
  expectedPolls?: number;
  /** Average actual interval between polls (ms) */
  actualPollingRateMs?: number;
  /** Configured polling interval (ms) */
  configuredPollingRateMs?: number;
  // ── Diagnostic counters ──
  /** Number of polls where the hierarchy tree was identical to the previous (no diff needed) */
  equalTreeCount?: number;
  /** Number of diffs that exceeded maxChangesThreshold (discarded as full-screen transitions) */
  thresholdExceededCount?: number;
  /** Number of diffs where changes existed but inferInteraction returned null (no identifiable elements) */
  diffButNullInferenceCount?: number;
  /** Number of identifiable elements in the baseline hierarchy snapshot */
  baselineElementCount?: number;
  /** Per-poll records for timeline building (only present when explicitly requested) */
  pollRecords?: PollRecord[];
}

/** Record of a single polling attempt — used to build the session timeline */
export interface PollRecord {
  timestamp: string;
  durationMs: number;
  result: 'baseline' | 'equal' | 'inferred' | 'inferred-transition'
        | 'threshold_exceeded' | 'suppressed' | 'debounced' | 'error';
  elementCount?: number;
  inferredTarget?: string;
  error?: string;
}

/** Callback to send real-time polling log messages to the MCP client */
export type PollingNotifier = (level: string, data: Record<string, unknown>) => void;

/** Callback to persist an inferred interaction */
export type InteractionLogger = (interaction: UIInteraction) => Promise<void>;

/** Callback to read the current UI hierarchy (returns raw string for diffing) */
export type HierarchyReader = () => Promise<UIHierarchyNode>;

/** Configuration for the touch inferrer */
export interface TouchInferrerConfig {
  /** Polling interval in ms (default: 500) */
  pollingIntervalMs: number;
  /** Max elements changed to consider a "single action" vs. a full screen transition */
  maxChangesThreshold: number;
  /** Minimum ms between inferred interactions (debounce) */
  debounceMs: number;
}

const DEFAULT_CONFIG: TouchInferrerConfig = {
  pollingIntervalMs: 2000,
  maxChangesThreshold: 50,
  debounceMs: 300,
};

/** Throttle debug-level notifications to every Nth poll */
const DEBUG_NOTIFY_EVERY = 10;

/**
 * Infer a UIInteraction from a StateChange produced by hierarchy diffing.
 *
 * This is a pure function — it does not depend on timers or external state.
 * Exported separately for testability.
 */
export function inferInteraction(
  sessionId: string,
  stateChange: StateChange,
  config: Pick<TouchInferrerConfig, 'maxChangesThreshold'> = DEFAULT_CONFIG,
): UIInteraction | null {
  const { elementsAdded, elementsRemoved, elementsChanged = [] } = stateChange;
  const totalChanges = elementsAdded.length + elementsRemoved.length + elementsChanged.length;

  if (totalChanges === 0) return null;
  if (totalChanges > config.maxChangesThreshold) {
    // Best-effort: try to find one high-quality interactive element from the transition.
    // This preserves screen-transition navigation (e.g., login → dashboard) that would
    // otherwise be silently discarded.
    const transitionTarget = findBestTapTarget(elementsRemoved)
      ?? findBestTapTarget(elementsAdded);
    if (transitionTarget && (transitionTarget.id || transitionTarget.accessibilityLabel)) {
      return {
        ...buildInteraction(sessionId, 'tap', transitionTarget, stateChange.timestamp),
        source: 'inferred-transition' as const,
      };
    }
    return null;
  }

  // ── Priority 0: Text value changes → infer as 'type' action ──
  // When a text field's value changes (same element id, different text),
  // this is almost certainly the user typing.
  if (elementsChanged.length > 0) {
    const textChange = elementsChanged.find((c) => c.changedAttribute === 'text');
    if (textChange) {
      return {
        sessionId,
        timestamp: stateChange.timestamp,
        actionType: 'type',
        element: textChange.after,
        textInput: textChange.after.text || '',
        source: 'inferred',
      };
    }
  }

  // ── Strategy: Identify the most likely tapped element ──

  // Priority 1: If elements were removed AND added, the user likely navigated.
  // Look for a button/link in the removed set (the thing they tapped).
  if (elementsRemoved.length > 0 && elementsAdded.length > 0) {
    const tappedElement = findBestTapTarget(elementsRemoved);
    if (tappedElement) {
      return buildInteraction(sessionId, 'tap', tappedElement, stateChange.timestamp);
    }
  }

  // Priority 2: If only elements were added (e.g., a modal appeared),
  // the user tapped something on the *previous* screen. We can't know
  // exactly what, but we can infer the first identifiable *new* element
  // as the target of an assertVisible rather than a tap.
  if (elementsAdded.length > 0 && elementsRemoved.length === 0) {
    // This is likely a partial UI update (dropdown, modal, etc.)
    // Look for an identifiable element in the added set
    const addedTarget = findFirstIdentifiable(elementsAdded);
    if (addedTarget) {
      return buildInteraction(sessionId, 'tap', addedTarget, stateChange.timestamp);
    }
  }

  // Priority 3: If only elements were removed (e.g., dismissing a modal),
  // pick the most identifiable removed element as the tap target.
  if (elementsRemoved.length > 0 && elementsAdded.length === 0) {
    const removedTarget = findBestTapTarget(elementsRemoved);
    if (removedTarget) {
      return buildInteraction(sessionId, 'tap', removedTarget, stateChange.timestamp);
    }
  }

  // Fallback: too ambiguous to infer
  return null;
}

/**
 * Find the best candidate for a tap target from a list of elements.
 * Prefers button/link roles, then elements with accessibilityLabel/id.
 */
export function findBestTapTarget(elements: UIElement[]): UIElement | null {
  // Prefer interactive roles
  const interactiveRoles = ['button', 'link', 'tab', 'switch', 'cell', 'menuitem'];
  for (const role of interactiveRoles) {
    const match = elements.find(
      (el) => el.role?.toLowerCase() === role && hasIdentity(el),
    );
    if (match) return match;
  }

  // Fall back to any identifiable element
  return findFirstIdentifiable(elements);
}

/**
 * Find the first element with at least one identifier (id, label, or text).
 */
export function findFirstIdentifiable(elements: UIElement[]): UIElement | null {
  return elements.find(hasIdentity) ?? null;
}

/** Check whether a UIElement has at least one identifier */
function hasIdentity(el: UIElement): boolean {
  return !!(el.id || el.accessibilityLabel || el.text);
}

/** Build a UIInteraction from inferred data */
function buildInteraction(
  sessionId: string,
  actionType: UIActionType,
  element: UIElement,
  timestamp: string,
): UIInteraction {
  return {
    sessionId,
    timestamp,
    actionType,
    element,
    source: 'inferred',
  };
}

/**
 * TouchInferrer — Manages the polling lifecycle for passive touch capture.
 *
 * Call `start()` when a recording session begins and `stop()` when it ends.
 * The inferrer polls the hierarchy at a fixed interval, diffs snapshots,
 * and logs inferred interactions.
 */
export class TouchInferrer {
  private logger: InteractionLogger;
  private hierarchyReader: HierarchyReader;
  private config: TouchInferrerConfig;
  private notifier?: PollingNotifier;
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousHierarchy: UIHierarchyNode | null = null;
  private lastInferredAt = 0;
  private polling = false;
  private suppressed = false;

  // ── Polling health counters ──
  private pollCount = 0;
  private successCount = 0;
  private errorCount = 0;
  private inferredCount = 0;
  private lastError?: string;
  private startedAt?: number;

  // ── Diagnostic counters ──
  private equalTreeCount = 0;
  private thresholdExceededCount = 0;
  private diffButNullInferenceCount = 0;
  private baselineElementCount = 0;
  private pollRecords: PollRecord[] = [];

  constructor(
    logger: InteractionLogger,
    hierarchyReader: HierarchyReader,
    config: Partial<TouchInferrerConfig> = {},
    notifier?: PollingNotifier,
  ) {
    this.logger = logger;
    this.hierarchyReader = hierarchyReader;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.notifier = notifier;
  }

  /**
   * Start periodic polling and hierarchy diffing.
   */
  start(sessionId: string): void {
    if (this.timer) return; // already running

    this.startedAt = Date.now();
    console.error(
      `[TouchInferrer] start: polling every ${this.config.pollingIntervalMs}ms for session ${sessionId}`,
    );
    this.notify('info', {
      event: 'polling_started',
      sessionId,
      pollingIntervalMs: this.config.pollingIntervalMs,
    });

    // Capture baseline immediately — don't wait for first interval tick.
    // This eliminates the time-zero blind spot where user interactions are
    // invisible because no prior hierarchy exists to diff against.
    this.pollOnce(sessionId).catch((err) => {
      console.error('[TouchInferrer] immediate baseline poll failed (non-fatal):', err);
    });

    this.timer = setInterval(() => {
      // Guard against overlapping polls
      if (this.polling) {
        console.error('[TouchInferrer] skipping poll — previous poll still running');
        return;
      }
      this.pollOnce(sessionId).catch((err) => {
        console.error('[TouchInferrer] pollOnce error (non-fatal):', err);
      });
    }, this.config.pollingIntervalMs);
  }

  /**
   * Stop polling. Safe to call multiple times.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.previousHierarchy = null;
      this.polling = false;
      console.error(
        `[TouchInferrer] stop: polling stopped (polls: ${this.pollCount}, success: ${this.successCount}, errors: ${this.errorCount}, inferred: ${this.inferredCount})`,
      );
    }
  }

  /**
   * Get current polling health status.
   */
  /**
   * Suppress the next inferred interaction.
   * Used by execute_ui_action to prevent double-logging.
   * The poller will still update its baseline hierarchy but skip logging.
   */
  suppress(): void {
    this.suppressed = true;
  }

  /**
   * Get current polling health status, including rate metrics.
   */
  getStatus(): PollingStatus {
    const status: PollingStatus = {
      pollCount: this.pollCount,
      successCount: this.successCount,
      errorCount: this.errorCount,
      inferredCount: this.inferredCount,
      lastError: this.lastError,
      configuredPollingRateMs: this.config.pollingIntervalMs,
      equalTreeCount: this.equalTreeCount,
      thresholdExceededCount: this.thresholdExceededCount,
      diffButNullInferenceCount: this.diffButNullInferenceCount,
      baselineElementCount: this.baselineElementCount,
    };
    if (this.startedAt && this.pollCount > 0) {
      const elapsed = Date.now() - this.startedAt;
      status.elapsedMs = elapsed;
      status.expectedPolls = Math.floor(elapsed / this.config.pollingIntervalMs);
      status.actualPollingRateMs = Math.round(elapsed / this.pollCount);
    }
    return status;
  }

  /**
   * Get the per-poll timeline records.
   * Returns a copy to prevent external mutation.
   */
  getPollRecords(): PollRecord[] {
    return [...this.pollRecords];
  }

  /**
   * Single poll iteration: snapshot → diff → infer → log.
   * Exported for testing but normally called by the timer.
   */
  async pollOnce(sessionId: string): Promise<UIInteraction | null> {
    this.polling = true;
    this.pollCount++;
    const pollStart = Date.now();
    try {
      const currentHierarchy = await this.hierarchyReader();
      this.successCount++;
      const readDuration = Date.now() - pollStart;

      // Periodic debug notification (throttled)
      if (this.pollCount % DEBUG_NOTIFY_EVERY === 0) {
        this.notify('debug', {
          event: 'poll_status',
          pollCount: this.pollCount,
          successCount: this.successCount,
          errorCount: this.errorCount,
          inferredCount: this.inferredCount,
        });
      }

      if (!this.previousHierarchy) {
        // First snapshot — no diff possible yet
        this.previousHierarchy = currentHierarchy;
        this.baselineElementCount = flattenToElements(currentHierarchy).length;
        console.error(`[TouchInferrer] pollOnce: captured initial baseline snapshot (${this.baselineElementCount} identifiable elements)`);
        this.notify('info', { event: 'baseline_captured', pollCount: this.pollCount, identifiableElements: this.baselineElementCount });
        this.pollRecords.push({
          timestamp: new Date(pollStart).toISOString(),
          durationMs: readDuration,
          result: 'baseline',
          elementCount: this.baselineElementCount,
        });
        return null;
      }

      // Quick equality check using tree comparison
      if (HierarchyDiffer.areEqualTrees(this.previousHierarchy, currentHierarchy)) {
        this.equalTreeCount++;
        this.pollRecords.push({
          timestamp: new Date(pollStart).toISOString(),
          durationMs: readDuration,
          result: 'equal',
        });
        return null;
      }

      // Diff the parsed trees directly
      const stateChange = HierarchyDiffer.diff(this.previousHierarchy, currentHierarchy);

      // Update previous for next iteration
      this.previousHierarchy = currentHierarchy;

      // If suppressed (AI-led action already logged this), skip inference but keep baseline
      if (this.suppressed) {
        this.suppressed = false;
        console.error('[TouchInferrer] pollOnce: diff detected but suppressed (AI-led action)');
        this.pollRecords.push({
          timestamp: new Date(pollStart).toISOString(),
          durationMs: readDuration,
          result: 'suppressed',
        });
        return null;
      }

      // Debounce: skip if we just inferred an interaction
      const now = Date.now();
      if (now - this.lastInferredAt < this.config.debounceMs) {
        this.pollRecords.push({
          timestamp: new Date(pollStart).toISOString(),
          durationMs: readDuration,
          result: 'debounced',
        });
        return null;
      }

      // Log diff summary for diagnostics
      const totalChanges = stateChange.elementsAdded.length + stateChange.elementsRemoved.length + (stateChange.elementsChanged?.length ?? 0);
      console.error(
        `[TouchInferrer] pollOnce: diff detected — +${stateChange.elementsAdded.length} / -${stateChange.elementsRemoved.length} / ~${stateChange.elementsChanged?.length ?? 0} (total: ${totalChanges}, threshold: ${this.config.maxChangesThreshold})`,
      );

      // Check if threshold was exceeded (inferInteraction will return null)
      if (totalChanges > this.config.maxChangesThreshold) {
        this.thresholdExceededCount++;
        console.error(`[TouchInferrer] pollOnce: threshold exceeded (${totalChanges} > ${this.config.maxChangesThreshold}), skipping`);
        this.notify('debug', {
          event: 'threshold_exceeded',
          totalChanges,
          threshold: this.config.maxChangesThreshold,
        });
      }

      // Infer interaction from the diff
      const interaction = inferInteraction(sessionId, stateChange, this.config);
      if (interaction) {
        this.lastInferredAt = now;
        this.inferredCount++;
        await this.logger(interaction);
        const target =
          interaction.element.id ||
          interaction.element.accessibilityLabel ||
          interaction.element.text ||
          'unknown';
        console.error(`[TouchInferrer] inferred: ${interaction.actionType} on "${target}"`);
        this.notify('info', {
          event: 'interaction_inferred',
          actionType: interaction.actionType,
          target,
          inferredCount: this.inferredCount,
        });
      } else if (totalChanges > 0 && totalChanges <= this.config.maxChangesThreshold) {
        // Diff had changes within threshold, but inferInteraction returned null
        // (no identifiable elements in the changed set)
        this.diffButNullInferenceCount++;
        console.error(
          `[TouchInferrer] pollOnce: diff had ${totalChanges} changes but no identifiable elements — inference returned null`,
        );
        this.notify('debug', {
          event: 'diff_no_identity',
          totalChanges,
          addedSample: stateChange.elementsAdded.slice(0, 3).map((el) => el.role || 'unknown'),
          removedSample: stateChange.elementsRemoved.slice(0, 3).map((el) => el.role || 'unknown'),
        });
      }

      // Record the poll result
      if (interaction) {
        const target =
          interaction.element.id ||
          interaction.element.accessibilityLabel ||
          interaction.element.text ||
          'unknown';
        this.pollRecords.push({
          timestamp: new Date(pollStart).toISOString(),
          durationMs: readDuration,
          result: interaction.source === 'inferred-transition' ? 'inferred-transition' : 'inferred',
          inferredTarget: target,
        });
      } else if (totalChanges > this.config.maxChangesThreshold) {
        this.pollRecords.push({
          timestamp: new Date(pollStart).toISOString(),
          durationMs: readDuration,
          result: 'threshold_exceeded',
        });
      } else {
        // Diff had changes but no interaction could be inferred
        this.pollRecords.push({
          timestamp: new Date(pollStart).toISOString(),
          durationMs: readDuration,
          result: 'equal', // no actionable diff — treat like no-change
        });
      }

      return interaction;
    } catch (err) {
      this.errorCount++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.pollRecords.push({
        timestamp: new Date(pollStart).toISOString(),
        durationMs: Date.now() - pollStart,
        result: 'error',
        error: this.lastError,
      });
      this.notify('warning', {
        event: 'poll_error',
        errorCount: this.errorCount,
        error: this.lastError,
      });
      throw err; // re-throw so the caller's catch handler still logs it
    } finally {
      this.polling = false;
    }
  }

  /** Send a notification to the MCP client if a notifier is configured */
  private notify(level: string, data: Record<string, unknown>): void {
    if (this.notifier) {
      try {
        this.notifier(level, data);
      } catch {
        // Notifications are best-effort — never crash the poller
      }
    }
  }
}
