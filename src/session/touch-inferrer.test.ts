import { describe, it, expect, vi } from 'vitest';
import { inferInteraction, findBestTapTarget, findFirstIdentifiable, TouchInferrer } from './touch-inferrer.js';
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

describe('TouchInferrer.getStatus', () => {
  const sessionId = 'status-test';

  function makeTree(id: string) {
    return { role: 'view', id, children: [] };
  }

  it('should report zero counters before any polling', () => {
    const reader = vi.fn();
    const logger = vi.fn();
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000 });

    const status = inferrer.getStatus();
    expect(status.pollCount).toBe(0);
    expect(status.successCount).toBe(0);
    expect(status.errorCount).toBe(0);
    expect(status.inferredCount).toBe(0);
    expect(status.lastError).toBeUndefined();
  });

  it('should increment pollCount and successCount on successful poll', async () => {
    const reader = vi.fn().mockResolvedValue(makeTree('root'));
    const logger = vi.fn().mockResolvedValue(undefined);
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000 });

    await inferrer.pollOnce(sessionId);

    const status = inferrer.getStatus();
    expect(status.pollCount).toBe(1);
    expect(status.successCount).toBe(1);
    expect(status.errorCount).toBe(0);
  });

  it('should increment errorCount and set lastError on reader failure', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('daemon crashed'));
    const logger = vi.fn();
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000 });

    await expect(inferrer.pollOnce(sessionId)).rejects.toThrow('daemon crashed');

    const status = inferrer.getStatus();
    expect(status.pollCount).toBe(1);
    expect(status.successCount).toBe(0);
    expect(status.errorCount).toBe(1);
    expect(status.lastError).toBe('daemon crashed');
  });

  it('should track inferredCount when interactions are detected', async () => {
    // First call returns baseline, second returns a changed tree
    const tree1 = { role: 'view', id: 'root', children: [{ role: 'button', id: 'login-btn', children: [] }] };
    const tree2 = { role: 'view', id: 'root', children: [{ role: 'view', id: 'dashboard', children: [] }] };
    const reader = vi.fn()
      .mockResolvedValueOnce(tree1)
      .mockResolvedValueOnce(tree2);
    const logger = vi.fn().mockResolvedValue(undefined);
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000, debounceMs: 0 });

    // First poll — baseline only
    await inferrer.pollOnce(sessionId);
    expect(inferrer.getStatus().inferredCount).toBe(0);

    // Second poll — diff should infer an interaction
    await inferrer.pollOnce(sessionId);
    expect(inferrer.getStatus().inferredCount).toBe(1);
    expect(inferrer.getStatus().pollCount).toBe(2);
    expect(inferrer.getStatus().successCount).toBe(2);
  });
});

describe('TouchInferrer.notifier', () => {
  const sessionId = 'notifier-test';

  function makeTree(id: string, childId?: string) {
    const children = childId ? [{ role: 'button', id: childId, children: [] }] : [];
    return { role: 'view', id, children };
  }

  it('should call notifier with info level on baseline capture', async () => {
    const reader = vi.fn().mockResolvedValue(makeTree('root'));
    const logger = vi.fn().mockResolvedValue(undefined);
    const notifier = vi.fn();
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000 }, notifier);

    await inferrer.pollOnce(sessionId);

    const baselineCall = notifier.mock.calls.find(
      (c: [string, Record<string, unknown>]) => c[1].event === 'baseline_captured',
    );
    expect(baselineCall).toBeDefined();
    expect(baselineCall![0]).toBe('info');
  });

  it('should call notifier with info level when interaction inferred', async () => {
    const tree1 = makeTree('root', 'login-btn');
    const tree2 = makeTree('root', 'dashboard');
    const reader = vi.fn().mockResolvedValueOnce(tree1).mockResolvedValueOnce(tree2);
    const logger = vi.fn().mockResolvedValue(undefined);
    const notifier = vi.fn();
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000, debounceMs: 0 }, notifier);

    await inferrer.pollOnce(sessionId); // baseline
    await inferrer.pollOnce(sessionId); // diff → infer

    const inferCall = notifier.mock.calls.find(
      (c: [string, Record<string, unknown>]) => c[1].event === 'interaction_inferred',
    );
    expect(inferCall).toBeDefined();
    expect(inferCall![0]).toBe('info');
    expect(inferCall![1].actionType).toBe('tap');
  });

  it('should call notifier with warning level on reader error', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('daemon crashed'));
    const logger = vi.fn();
    const notifier = vi.fn();
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000 }, notifier);

    await expect(inferrer.pollOnce(sessionId)).rejects.toThrow('daemon crashed');

    const errorCall = notifier.mock.calls.find(
      (c: [string, Record<string, unknown>]) => c[1].event === 'poll_error',
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0]).toBe('warning');
    expect(errorCall![1].error).toBe('daemon crashed');
  });

  it('should work without notifier (backward compatibility)', async () => {
    const reader = vi.fn().mockResolvedValue(makeTree('root'));
    const logger = vi.fn().mockResolvedValue(undefined);
    // No notifier passed — should not throw
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000 });

    await inferrer.pollOnce(sessionId);
    expect(inferrer.getStatus().successCount).toBe(1);
  });
});

describe('TouchInferrer.suppress', () => {
  const sessionId = 'suppress-test';

  it('should skip inference when suppressed but still update baseline', async () => {
    const tree1 = { role: 'view', id: 'root', children: [{ role: 'button', id: 'login-btn', children: [] }] };
    const tree2 = { role: 'view', id: 'root', children: [{ role: 'view', id: 'dashboard', children: [] }] };
    const tree3 = { role: 'view', id: 'root', children: [{ role: 'view', id: 'settings', children: [] }] };
    const reader = vi.fn()
      .mockResolvedValueOnce(tree1)
      .mockResolvedValueOnce(tree2)
      .mockResolvedValueOnce(tree3);
    const logger = vi.fn().mockResolvedValue(undefined);
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 10000, debounceMs: 0 });

    // Poll 1: baseline
    await inferrer.pollOnce(sessionId);
    expect(inferrer.getStatus().inferredCount).toBe(0);

    // Suppress before poll 2
    inferrer.suppress();
    await inferrer.pollOnce(sessionId);
    // Should NOT have inferred (suppressed)
    expect(inferrer.getStatus().inferredCount).toBe(0);
    expect(logger).not.toHaveBeenCalled();

    // Poll 3: should infer normally (suppress was one-shot)
    await inferrer.pollOnce(sessionId);
    expect(inferrer.getStatus().inferredCount).toBe(1);
    expect(logger).toHaveBeenCalledOnce();
  });
});

describe('TouchInferrer.rateTracking', () => {
  const sessionId = 'rate-test';

  it('should include rate metrics in getStatus after polling', async () => {
    const reader = vi.fn().mockResolvedValue({ role: 'view', id: 'root', children: [] });
    const logger = vi.fn().mockResolvedValue(undefined);
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 1000 });

    // Simulate start to set startedAt
    inferrer.start(sessionId);

    // Run a manual poll
    await inferrer.pollOnce(sessionId);

    const status = inferrer.getStatus();
    expect(status.configuredPollingRateMs).toBe(1000);
    expect(status.elapsedMs).toBeDefined();
    expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(status.expectedPolls).toBeDefined();
    expect(status.actualPollingRateMs).toBeDefined();

    inferrer.stop();
  });

  it('should not include rate metrics before any polls', () => {
    const reader = vi.fn();
    const logger = vi.fn();
    const inferrer = new TouchInferrer(logger, reader, { pollingIntervalMs: 1000 });

    const status = inferrer.getStatus();
    expect(status.configuredPollingRateMs).toBe(1000);
    expect(status.elapsedMs).toBeUndefined();
    expect(status.expectedPolls).toBeUndefined();
    expect(status.actualPollingRateMs).toBeUndefined();
  });
});

