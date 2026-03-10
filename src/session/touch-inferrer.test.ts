import { describe, it, expect } from 'vitest';
import { inferInteraction, findBestTapTarget, findFirstIdentifiable } from './touch-inferrer.js';
import type { UIElement, StateChange } from '../types.js';

function makeStateChange(overrides: Partial<StateChange> = {}): StateChange {
  return {
    timestamp: '2024-01-01T00:00:00.000Z',
    elementsAdded: [],
    elementsRemoved: [],
    elementsChanged: [],
    settleDurationMs: 0,
    ...overrides,
  };
}

function makeElement(overrides: Partial<UIElement> = {}): UIElement {
  return {
    id: undefined,
    accessibilityLabel: undefined,
    text: undefined,
    role: undefined,
    ...overrides,
  };
}

describe('inferInteraction', () => {
  const sessionId = 'test-session';

  it('should return null for an empty diff (no changes)', () => {
    const change = makeStateChange();
    expect(inferInteraction(sessionId, change)).toBeNull();
  });

  it('should return null for a noisy diff (> threshold)', () => {
    const manyElements = Array.from({ length: 60 }, (_, i) =>
      makeElement({ id: `el-${i}`, role: 'staticText' }),
    );
    const change = makeStateChange({ elementsAdded: manyElements });
    expect(inferInteraction(sessionId, change, { maxChangesThreshold: 50 })).toBeNull();
  });

  it('should infer a tap when elements are removed and added (navigation)', () => {
    const change = makeStateChange({
      elementsRemoved: [makeElement({ id: 'login-btn', role: 'button' })],
      elementsAdded: [makeElement({ id: 'dashboard-title', role: 'staticText' })],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('tap');
    expect(result!.element.id).toBe('login-btn');
    expect(result!.source).toBe('inferred');
  });

  it('should prefer button roles over other roles when finding tap target', () => {
    const change = makeStateChange({
      elementsRemoved: [
        makeElement({ text: 'Some text', role: 'staticText' }),
        makeElement({ accessibilityLabel: 'Submit', role: 'button' }),
      ],
      elementsAdded: [makeElement({ id: 'new-screen', role: 'view' })],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).not.toBeNull();
    expect(result!.element.accessibilityLabel).toBe('Submit');
    expect(result!.element.role).toBe('button');
  });

  it('should infer a tap when only elements are added (e.g. modal appears)', () => {
    const change = makeStateChange({
      elementsAdded: [
        makeElement({ id: 'modal-title', role: 'staticText' }),
        makeElement({ id: 'close-btn', role: 'button' }),
      ],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('tap');
    expect(result!.source).toBe('inferred');
  });

  it('should infer a tap when only elements are removed (e.g. modal dismissed)', () => {
    const change = makeStateChange({
      elementsRemoved: [
        makeElement({ id: 'dismiss-btn', role: 'button' }),
        makeElement({ text: 'Are you sure?', role: 'staticText' }),
      ],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('tap');
    expect(result!.element.id).toBe('dismiss-btn');
  });

  it('should return null when no elements have identifiers', () => {
    const change = makeStateChange({
      elementsRemoved: [makeElement({ role: 'view' })], // no id, label, or text
      elementsAdded: [makeElement({ role: 'view' })],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).toBeNull();
  });

  it('should set sessionId and timestamp on inferred interactions', () => {
    const change = makeStateChange({
      timestamp: '2024-06-15T12:30:00.000Z',
      elementsRemoved: [makeElement({ id: 'btn', role: 'button' })],
      elementsAdded: [makeElement({ id: 'new-screen' })],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('test-session');
    expect(result!.timestamp).toBe('2024-06-15T12:30:00.000Z');
  });

  it('should respect custom maxChangesThreshold', () => {
    const elements = Array.from({ length: 5 }, (_, i) =>
      makeElement({ id: `el-${i}`, role: 'button' }),
    );
    const change = makeStateChange({ elementsAdded: elements });

    // Threshold = 3 → too many changes
    expect(inferInteraction(sessionId, change, { maxChangesThreshold: 3 })).toBeNull();

    // Threshold = 10 → fine
    const result = inferInteraction(sessionId, change, { maxChangesThreshold: 10 });
    expect(result).not.toBeNull();
  });

  it('should infer a type action when elementsChanged includes a text change', () => {
    const change = makeStateChange({
      elementsChanged: [
        {
          identityKey: 'id:login_username_field',
          before: makeElement({ id: 'login_username_field', role: 'Element' }),
          after: makeElement({ id: 'login_username_field', text: 'admin', role: 'Element' }),
          changedAttribute: 'text',
        },
      ],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('type');
    expect(result!.textInput).toBe('admin');
    expect(result!.element.id).toBe('login_username_field');
    expect(result!.source).toBe('inferred');
  });

  it('should prefer text change over tap inference when both are present', () => {
    const change = makeStateChange({
      elementsAdded: [makeElement({ id: 'keyboard', role: 'view' })],
      elementsChanged: [
        {
          identityKey: 'id:input_field',
          before: makeElement({ id: 'input_field', role: 'Element' }),
          after: makeElement({ id: 'input_field', text: 'hello', role: 'Element' }),
          changedAttribute: 'text',
        },
      ],
    });

    const result = inferInteraction(sessionId, change);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('type');
    expect(result!.textInput).toBe('hello');
  });
});

describe('findBestTapTarget', () => {
  it('should prefer button role elements', () => {
    const elements: UIElement[] = [
      makeElement({ text: 'Hello', role: 'staticText' }),
      makeElement({ id: 'my-btn', role: 'button' }),
      makeElement({ text: 'World', role: 'staticText' }),
    ];

    const result = findBestTapTarget(elements);
    expect(result?.id).toBe('my-btn');
  });

  it('should try link, tab, switch, cell roles in order', () => {
    const elements: UIElement[] = [
      makeElement({ text: 'A cell', role: 'cell' }),
      makeElement({ accessibilityLabel: 'Settings tab', role: 'tab' }),
    ];

    const result = findBestTapTarget(elements);
    expect(result?.accessibilityLabel).toBe('Settings tab');
  });

  it('should fall back to any identifiable element when no interactive roles', () => {
    const elements: UIElement[] = [
      makeElement({ role: 'view' }), // no identity
      makeElement({ text: 'Some text', role: 'staticText' }),
    ];

    const result = findBestTapTarget(elements);
    expect(result?.text).toBe('Some text');
  });

  it('should return null for empty array', () => {
    expect(findBestTapTarget([])).toBeNull();
  });

  it('should skip interactive-role elements without identity', () => {
    const elements: UIElement[] = [
      makeElement({ role: 'button' }), // button but no id/label/text
      makeElement({ text: 'Fallback', role: 'staticText' }),
    ];

    const result = findBestTapTarget(elements);
    expect(result?.text).toBe('Fallback');
  });
});

describe('findFirstIdentifiable', () => {
  it('should find element with id', () => {
    const elements: UIElement[] = [
      makeElement({ role: 'view' }),
      makeElement({ id: 'found-it', role: 'button' }),
    ];

    expect(findFirstIdentifiable(elements)?.id).toBe('found-it');
  });

  it('should find element with accessibilityLabel', () => {
    const elements: UIElement[] = [
      makeElement({ accessibilityLabel: 'Close', role: 'button' }),
    ];

    expect(findFirstIdentifiable(elements)?.accessibilityLabel).toBe('Close');
  });

  it('should find element with text', () => {
    const elements: UIElement[] = [
      makeElement({ text: 'Hello World', role: 'staticText' }),
    ];

    expect(findFirstIdentifiable(elements)?.text).toBe('Hello World');
  });

  it('should return null when no elements have identity', () => {
    const elements: UIElement[] = [
      makeElement({ role: 'view' }),
      makeElement({ role: 'container' }),
    ];

    expect(findFirstIdentifiable(elements)).toBeNull();
  });

  it('should return null for empty array', () => {
    expect(findFirstIdentifiable([])).toBeNull();
  });
});
