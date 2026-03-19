/**
 * TrackEventExtractor — Extracts UIInteractions from network-based tracking events.
 *
 * When an app is instrumented with AutomatorTracker (or similar), it sends HTTP
 * POST requests to a known path (e.g., /__track) with JSON payloads describing
 * user interactions. This module scans captured Proxyman network events for those
 * tracking requests and converts them into UIInteraction records.
 *
 * Architecture note: This is a pure-logic module — no I/O. It receives parsed
 * NetworkEvent arrays and returns UIInteraction arrays.
 */

import type { NetworkEvent, UIInteraction, UIActionType, UIElement } from '../types.js';

/** Canonical event names and their UIActionType mappings */
export const DEFAULT_EVENT_MAPPING: Record<string, UIActionType> = {
  trackLink: 'tap',
  ctaClicked: 'tap',
  tap: 'tap',
  pageDisplayed: 'assertVisible',
  textInput: 'type',
  scroll: 'scroll',
  swipe: 'swipe',
  scrollUntilVisible: 'scrollUntilVisible',
  swipeUntilVisible: 'swipeUntilVisible',
  back: 'back',
};

/** Default URL path patterns to match track events */
export const DEFAULT_TRACK_PATHS = ['/__track'];

/** Shape of the JSON body the app POSTs */
export interface TrackEventPayload {
  /** Event type (e.g., 'trackLink', 'ctaClicked', 'pageDisplayed') */
  event: string;
  /** Element accessibility ID / testID */
  elementId?: string;
  /** Element accessibility label */
  elementLabel?: string;
  /** Element visible text */
  elementText?: string;
  /** Text that was typed (for textInput events) */
  text?: string;
  /** Screen/page name */
  screen?: string;
  /** ISO timestamp from the app */
  timestamp?: string;
}

/** Configuration for the extractor */
export interface TrackEventExtractorConfig {
  /** URL path substrings to match (default: ['/__track']) */
  paths?: string[];
  /** Custom event name → UIActionType mapping (merged with defaults) */
  eventMapping?: Record<string, UIActionType>;
}

/**
 * Extract UIInteraction records from network events that match track event patterns.
 *
 * @param events - All captured network events from Proxyman
 * @param sessionId - Session to associate interactions with
 * @param config - Optional path patterns and event mappings
 * @returns Array of UIInteraction records extracted from matching events
 */
export function extractTrackEvents(
  events: NetworkEvent[],
  sessionId: string,
  config: TrackEventExtractorConfig = {},
): UIInteraction[] {
  const paths = config.paths ?? DEFAULT_TRACK_PATHS;
  const mapping = { ...DEFAULT_EVENT_MAPPING, ...config.eventMapping };

  const interactions: UIInteraction[] = [];

  for (const event of events) {
    // Only look at POSTs with a request body
    if (event.method !== 'POST' || !event.requestBody) continue;

    // Check if the URL matches any configured track paths
    if (!paths.some((p) => event.url.includes(p))) continue;

    // Parse the request body
    const payload = parsePayload(event.requestBody);
    if (!payload) continue;

    // Map the event to a UIActionType
    const actionType = mapping[payload.event];
    if (!actionType) continue;

    // Build the UIElement from the payload
    const element: UIElement = {};
    if (payload.elementId) element.id = payload.elementId;
    if (payload.elementLabel) element.accessibilityLabel = payload.elementLabel;
    if (payload.elementText) element.text = payload.elementText;

    // For pageDisplayed events without an element, use the screen name
    if (actionType === 'assertVisible' && !element.id && !element.accessibilityLabel && !element.text) {
      if (payload.screen) {
        element.text = payload.screen;
      }
    }

    const interaction: UIInteraction = {
      sessionId,
      timestamp: payload.timestamp ?? event.timestamp,
      actionType,
      element,
      source: 'tracked',
    };

    // Include text input for type events
    if (actionType === 'type' && payload.text) {
      interaction.textInput = payload.text;
    }

    interactions.push(interaction);
  }

  return interactions;
}

/**
 * Safely parse a JSON string into a TrackEventPayload.
 * Returns null if the string is not valid JSON or doesn't have the required 'event' field.
 */
function parsePayload(body: string): TrackEventPayload | null {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.event !== 'string' || parsed.event.trim() === '') return null;
    return parsed as TrackEventPayload;
  } catch {
    return null;
  }
}
