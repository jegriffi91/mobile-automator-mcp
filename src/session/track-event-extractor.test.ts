import { describe, it, expect } from 'vitest';
import { extractTrackEvents, DEFAULT_EVENT_MAPPING, DEFAULT_TRACK_PATHS } from './track-event-extractor.js';
import type { NetworkEvent } from '../types.js';

function makeNetworkEvent(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
  return {
    sessionId: 'test-session',
    timestamp: '2026-03-10T13:45:00.000Z',
    method: 'POST',
    url: 'http://localhost.proxyman.io:3031/__track',
    statusCode: 200,
    requestBody: undefined,
    ...overrides,
  };
}

function makeTrackBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'trackLink',
    elementId: 'login_submit_button',
    elementLabel: 'Submit',
    elementText: 'Submit',
    timestamp: '2026-03-10T13:45:00.000Z',
    screen: 'LoginScreen',
    ...overrides,
  });
}

describe('extractTrackEvents', () => {
  const sessionId = 'test-session';

  it('should extract a trackLink event as a tap interaction', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({ requestBody: makeTrackBody() }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0].actionType).toBe('tap');
    expect(result[0].element.id).toBe('login_submit_button');
    expect(result[0].element.accessibilityLabel).toBe('Submit');
    expect(result[0].source).toBe('tracked');
  });

  it('should extract a ctaClicked event as a tap interaction', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        requestBody: makeTrackBody({ event: 'ctaClicked', elementId: 'cta_signup' }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0].actionType).toBe('tap');
    expect(result[0].element.id).toBe('cta_signup');
  });

  it('should extract a textInput event as a type interaction with textInput', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        requestBody: makeTrackBody({
          event: 'textInput',
          elementId: 'login_username_field',
          text: 'admin',
        }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0].actionType).toBe('type');
    expect(result[0].textInput).toBe('admin');
    expect(result[0].element.id).toBe('login_username_field');
  });

  it('should extract a pageDisplayed event as assertVisible', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        requestBody: makeTrackBody({
          event: 'pageDisplayed',
          elementId: undefined,
          elementLabel: undefined,
          elementText: undefined,
          screen: 'HomeScreen',
        }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0].actionType).toBe('assertVisible');
    expect(result[0].element.text).toBe('HomeScreen');
  });

  it('should skip non-POST requests', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({ method: 'GET', requestBody: makeTrackBody() }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(0);
  });

  it('should skip events without a request body', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({ requestBody: undefined }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(0);
  });

  it('should skip events whose URL does not match any track path', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        url: 'http://api.example.com/login',
        requestBody: makeTrackBody(),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(0);
  });

  it('should skip events with invalid JSON body', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({ requestBody: 'not-json{' }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(0);
  });

  it('should skip events with unknown event type (no mapping)', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        requestBody: makeTrackBody({ event: 'unknownEvent' }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(0);
  });

  it('should skip events with empty event field', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        requestBody: makeTrackBody({ event: '' }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(0);
  });

  it('should skip events where body is not an object', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({ requestBody: '"just a string"' }),
      makeNetworkEvent({ requestBody: '42' }),
      makeNetworkEvent({ requestBody: 'null' }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(0);
  });

  it('should extract multiple events from a mixed list', () => {
    const events: NetworkEvent[] = [
      // Valid track event
      makeNetworkEvent({ requestBody: makeTrackBody() }),
      // Non-track API call
      makeNetworkEvent({
        url: 'http://api.example.com/data',
        requestBody: '{"key": "value"}',
      }),
      // Another valid track event
      makeNetworkEvent({
        requestBody: makeTrackBody({
          event: 'pageDisplayed',
          screen: 'SettingsScreen',
          elementId: undefined,
          elementLabel: undefined,
          elementText: undefined,
        }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result).toHaveLength(2);
    expect(result[0].actionType).toBe('tap');
    expect(result[1].actionType).toBe('assertVisible');
  });

  it('should use app timestamp when available, fall back to network event timestamp', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        timestamp: '2026-03-10T14:00:00.000Z',
        requestBody: makeTrackBody({ timestamp: '2026-03-10T13:59:59.500Z' }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId);
    expect(result[0].timestamp).toBe('2026-03-10T13:59:59.500Z');

    // Without app timestamp
    const events2: NetworkEvent[] = [
      makeNetworkEvent({
        timestamp: '2026-03-10T14:00:00.000Z',
        requestBody: makeTrackBody({ timestamp: undefined }),
      }),
    ];

    const result2 = extractTrackEvents(events2, sessionId);
    expect(result2[0].timestamp).toBe('2026-03-10T14:00:00.000Z');
  });
});

describe('extractTrackEvents with custom config', () => {
  const sessionId = 'config-test';

  it('should match custom path patterns', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        url: 'http://localhost:8080/api/events/track',
        requestBody: makeTrackBody(),
      }),
    ];

    // Default paths won't match
    expect(extractTrackEvents(events, sessionId)).toHaveLength(0);

    // Custom path matches
    const result = extractTrackEvents(events, sessionId, {
      paths: ['/api/events/track'],
    });
    expect(result).toHaveLength(1);
  });

  it('should support multiple custom paths', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        url: 'http://localhost:8080/analytics/v2/event',
        requestBody: makeTrackBody(),
      }),
      makeNetworkEvent({
        url: 'http://localhost:8080/tracking/click',
        requestBody: makeTrackBody({ event: 'ctaClicked' }),
      }),
    ];

    const result = extractTrackEvents(events, sessionId, {
      paths: ['/analytics/v2/event', '/tracking/click'],
    });
    expect(result).toHaveLength(2);
  });

  it('should support custom event mappings merged with defaults', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        requestBody: makeTrackBody({ event: 'menuItemSelected' }),
      }),
    ];

    // Not in default mapping
    expect(extractTrackEvents(events, sessionId)).toHaveLength(0);

    // Custom mapping adds it
    const result = extractTrackEvents(events, sessionId, {
      eventMapping: { menuItemSelected: 'tap' },
    });
    expect(result).toHaveLength(1);
    expect(result[0].actionType).toBe('tap');
  });

  it('should allow overriding default event mappings', () => {
    const events: NetworkEvent[] = [
      makeNetworkEvent({
        requestBody: makeTrackBody({ event: 'trackLink' }),
      }),
    ];

    // Override trackLink to map to assertVisible instead of tap
    const result = extractTrackEvents(events, sessionId, {
      eventMapping: { trackLink: 'assertVisible' },
    });
    expect(result).toHaveLength(1);
    expect(result[0].actionType).toBe('assertVisible');
  });
});

describe('DEFAULT_EVENT_MAPPING', () => {
  it('should include all canonical event types', () => {
    expect(DEFAULT_EVENT_MAPPING.trackLink).toBe('tap');
    expect(DEFAULT_EVENT_MAPPING.ctaClicked).toBe('tap');
    expect(DEFAULT_EVENT_MAPPING.tap).toBe('tap');
    expect(DEFAULT_EVENT_MAPPING.pageDisplayed).toBe('assertVisible');
    expect(DEFAULT_EVENT_MAPPING.textInput).toBe('type');
    expect(DEFAULT_EVENT_MAPPING.scroll).toBe('scroll');
    expect(DEFAULT_EVENT_MAPPING.swipe).toBe('swipe');
    expect(DEFAULT_EVENT_MAPPING.back).toBe('back');
  });
});

describe('DEFAULT_TRACK_PATHS', () => {
  it('should default to /__track', () => {
    expect(DEFAULT_TRACK_PATHS).toEqual(['/__track']);
  });
});
