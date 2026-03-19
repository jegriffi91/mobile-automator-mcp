import { describe, it, expect } from 'vitest';
import { isLowConfidenceElement, isInteractiveRole, TRANSIENT_PATTERNS } from './element-quality.js';
import type { UIElement } from '../types.js';

describe('isLowConfidenceElement', () => {
  // ── Transient pattern rejection ──

  it('should reject element with spinner in id', () => {
    const el: UIElement = { id: 'ExperianLogoSpinner' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject element with shimmer in id', () => {
    const el: UIElement = { id: 'shimmer-block' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject element with loading in label', () => {
    const el: UIElement = { accessibilityLabel: 'Loading spinner' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject element with skeleton in id', () => {
    const el: UIElement = { id: 'skeleton-row-2' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject element with placeholder in id', () => {
    const el: UIElement = { id: 'content-placeholder' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject element with progress in label', () => {
    const el: UIElement = { accessibilityLabel: 'progress-indicator' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject full_screen_spinner', () => {
    const el: UIElement = { id: 'full_screen_spinner' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  // ── Decorative label rejection ──

  it('should reject "Logo" label without interactive role', () => {
    const el: UIElement = { accessibilityLabel: 'Logo', role: 'image' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject "logo" label (case-insensitive)', () => {
    const el: UIElement = { accessibilityLabel: 'logo', role: 'staticText' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should NOT reject "Logo" label when element has interactive role', () => {
    const el: UIElement = { accessibilityLabel: 'Logo', role: 'button' };
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  it('should NOT reject decorative label if element also has an id', () => {
    const el: UIElement = { id: 'main-logo', accessibilityLabel: 'Logo', role: 'image' };
    // id takes priority — not treated as decorative-only label
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  it('should reject "icon" label without interactive role', () => {
    const el: UIElement = { accessibilityLabel: 'Icon' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  // ── Short/numeric text rejection ──

  it('should reject text-only selector "1" (too short)', () => {
    const el: UIElement = { text: '1' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject text-only selector "" (empty)', () => {
    const el: UIElement = { text: '' };
    // Empty text won't reach the length check because `el.text` is falsy
    // This verifies no crash
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  it('should reject text-only numeric selector "42"', () => {
    const el: UIElement = { text: '42' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should reject text-only numeric selector "12345"', () => {
    const el: UIElement = { text: '12345' };
    expect(isLowConfidenceElement(el)).toBe(true);
  });

  it('should NOT reject short text if element has an id', () => {
    const el: UIElement = { id: 'counter', text: '1' };
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  it('should NOT reject short text if element has an accessibilityLabel', () => {
    const el: UIElement = { accessibilityLabel: 'Score', text: '1' };
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  // ── Valid elements should pass ──

  it('should accept element with clean id', () => {
    const el: UIElement = { id: 'login-button', role: 'button' };
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  it('should accept element with informative label', () => {
    const el: UIElement = { accessibilityLabel: 'Submit Payment' };
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  it('should accept element with meaningful text', () => {
    const el: UIElement = { text: 'See cards matched to your credit' };
    expect(isLowConfidenceElement(el)).toBe(false);
  });

  it('should accept element with no identity (not low-confidence, just unidentifiable)', () => {
    const el: UIElement = { role: 'view' };
    expect(isLowConfidenceElement(el)).toBe(false);
  });
});

describe('isInteractiveRole', () => {
  it('should recognise button as interactive', () => {
    expect(isInteractiveRole('button')).toBe(true);
  });

  it('should recognise Button (case-insensitive) as interactive', () => {
    expect(isInteractiveRole('Button')).toBe(true);
  });

  it('should recognise link, tab, switch, cell, menuitem', () => {
    for (const role of ['link', 'tab', 'switch', 'cell', 'menuitem']) {
      expect(isInteractiveRole(role)).toBe(true);
    }
  });

  it('should not recognise staticText as interactive', () => {
    expect(isInteractiveRole('staticText')).toBe(false);
  });

  it('should not recognise image as interactive', () => {
    expect(isInteractiveRole('image')).toBe(false);
  });

  it('should handle undefined', () => {
    expect(isInteractiveRole(undefined)).toBe(false);
  });
});

describe('TRANSIENT_PATTERNS', () => {
  it('should be exported for reuse by selector-quality', () => {
    expect(TRANSIENT_PATTERNS).toBeDefined();
    expect(TRANSIENT_PATTERNS.length).toBeGreaterThan(0);
  });

  it('should all be case-insensitive regexps', () => {
    for (const pattern of TRANSIENT_PATTERNS) {
      expect(pattern.flags).toContain('i');
    }
  });
});
