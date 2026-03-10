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

import type { UIInteraction, UIElement, UIActionType, StateChange } from '../types.js';
import { HierarchyParser } from '../maestro/hierarchy.js';
import { HierarchyDiffer } from '../maestro/hierarchy-differ.js';

/** Callback to persist an inferred interaction */
export type InteractionLogger = (interaction: UIInteraction) => Promise<void>;

/** Callback to read the current UI hierarchy (returns raw string for diffing) */
export type HierarchyReader = () => Promise<string>;

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

  // Skip empty diffs (no user action) or noisy diffs (full screen transition)
  if (totalChanges === 0) return null;
  if (totalChanges > config.maxChangesThreshold) return null;

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
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousHierarchy: string | null = null;
  private lastInferredAt = 0;
  private polling = false;

  constructor(
    logger: InteractionLogger,
    hierarchyReader: HierarchyReader,
    config: Partial<TouchInferrerConfig> = {},
  ) {
    this.logger = logger;
    this.hierarchyReader = hierarchyReader;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start periodic polling and hierarchy diffing.
   */
  start(sessionId: string): void {
    if (this.timer) return; // already running

    console.error(
      `[TouchInferrer] start: polling every ${this.config.pollingIntervalMs}ms for session ${sessionId}`,
    );

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
      console.error('[TouchInferrer] stop: polling stopped');
    }
  }

  /**
   * Single poll iteration: snapshot → diff → infer → log.
   * Exported for testing but normally called by the timer.
   */
  async pollOnce(sessionId: string): Promise<UIInteraction | null> {
    this.polling = true;
    try {
      const currentHierarchy = await this.hierarchyReader();

      if (!this.previousHierarchy) {
        // First snapshot — no diff possible yet
        this.previousHierarchy = currentHierarchy;
        console.error('[TouchInferrer] pollOnce: captured initial baseline snapshot');
        return null;
      }

      // Quick equality check before parsing
      if (HierarchyDiffer.areEqual(this.previousHierarchy, currentHierarchy)) {
        console.error('[TouchInferrer] pollOnce: no change detected');
        return null;
      }

      // Parse and diff
      const beforeTree = HierarchyParser.parse(this.previousHierarchy);
      const afterTree = HierarchyParser.parse(currentHierarchy);
      const stateChange = HierarchyDiffer.diff(beforeTree, afterTree);

      // Update previous for next iteration
      this.previousHierarchy = currentHierarchy;

      // Debounce: skip if we just inferred an interaction
      const now = Date.now();
      if (now - this.lastInferredAt < this.config.debounceMs) {
        return null;
      }

      // Infer interaction from the diff
      const interaction = inferInteraction(sessionId, stateChange, this.config);
      if (interaction) {
        this.lastInferredAt = now;
        await this.logger(interaction);
        console.error(
          `[TouchInferrer] inferred: ${interaction.actionType} on "${interaction.element.id || interaction.element.accessibilityLabel || interaction.element.text || 'unknown'}"`,
        );
      }

      return interaction;
    } finally {
      this.polling = false;
    }
  }
}
