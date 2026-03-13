import { describe, it, expect } from 'vitest';
import { assessSelectorQuality } from './selector-quality.js';
import type { UIElement } from '../types.js';

describe('assessSelectorQuality', () => {
    it('should return no warnings for a well-identified element', () => {
        const el: UIElement = { id: 'login-button', text: 'Login' };
        expect(assessSelectorQuality(el)).toEqual([]);
    });

    it('should warn on text-only selector (no id or label)', () => {
        const el: UIElement = { text: 'Submit' };
        const warnings = assessSelectorQuality(el);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].kind).toBe('text-only-selector');
    });

    it('should warn on short text-only selector', () => {
        const el: UIElement = { text: '1' };
        const warnings = assessSelectorQuality(el);
        const kinds = warnings.map((w) => w.kind);
        expect(kinds).toContain('text-only-selector');
        expect(kinds).toContain('short-or-numeric');
    });

    it('should warn on numeric-only text selector', () => {
        const el: UIElement = { text: '12345' };
        const warnings = assessSelectorQuality(el);
        const kinds = warnings.map((w) => w.kind);
        expect(kinds).toContain('short-or-numeric');
    });

    it('should not warn on numeric text if element has an id', () => {
        const el: UIElement = { id: 'counter', text: '42' };
        expect(assessSelectorQuality(el)).toEqual([]);
    });

    it('should warn on transient id containing "shimmer"', () => {
        const el: UIElement = { id: 'shimmer-placeholder-1' };
        const warnings = assessSelectorQuality(el);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].kind).toBe('transient-id');
    });

    it('should warn on transient label containing "loading"', () => {
        const el: UIElement = { accessibilityLabel: 'Loading spinner' };
        const warnings = assessSelectorQuality(el);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].kind).toBe('transient-id');
    });

    it('should warn on transient id containing "skeleton"', () => {
        const el: UIElement = { id: 'skeleton-row-2' };
        const warnings = assessSelectorQuality(el);
        expect(warnings[0].kind).toBe('transient-id');
    });

    it('should warn on bounds-only selector', () => {
        const el: UIElement = { bounds: { x: 100, y: 200, width: 50, height: 50 } };
        const warnings = assessSelectorQuality(el);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].kind).toBe('bounds-only');
    });

    it('should return empty for element with only accessibilityLabel', () => {
        const el: UIElement = { accessibilityLabel: 'Settings button' };
        expect(assessSelectorQuality(el)).toEqual([]);
    });

    it('should return empty for completely empty element', () => {
        const el: UIElement = {};
        // No bounds, no text — function returns early with no warnings
        expect(assessSelectorQuality(el)).toEqual([]);
    });
});
