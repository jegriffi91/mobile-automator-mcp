/**
 * ElementQuality — Shared quality filtering for UIElement targets.
 *
 * Centralises the "is this element worth targeting?" logic used by:
 *   - TouchInferrer (upstream rejection during passive inference)
 *   - SelectorQuality (downstream warnings during YAML synthesis)
 *
 * By sharing these patterns, we reject transient/decorative/ambiguous
 * elements early in the inference pipeline rather than only warning
 * about them after the fact.
 */

import type { UIElement } from '../types.js';

/**
 * Regex patterns that indicate transient or loading-state element identifiers.
 * Matches against id or accessibilityLabel.
 */
export const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /shimmer/i,
  /loading/i,
  /placeholder/i,
  /spinner/i,
  /skeleton/i,
  /progress/i,
];

/**
 * Accessibility labels that are typically decorative and non-interactive.
 * Only rejected when the element does NOT have an interactive role.
 */
const DECORATIVE_LABELS = new Set([
  'logo',
  'icon',
  'background',
  'separator',
  'divider',
  'spacer',
  'decoration',
]);

/** Roles that indicate a genuinely interactive element */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'switch',
  'cell',
  'menuitem',
  'textfield',
  'searchfield',
  'slider',
  'checkbox',
  'radio',
]);

/**
 * Check whether a role string represents an interactive element.
 */
export function isInteractiveRole(role?: string): boolean {
  if (!role) return false;
  return INTERACTIVE_ROLES.has(role.toLowerCase());
}

/**
 * Determine whether a UIElement is low-confidence for interaction inference.
 *
 * Low-confidence elements include:
 * - Elements with transient IDs/labels (spinner, shimmer, loading, etc.)
 * - Decorative labels (Logo, Icon) without an interactive role
 * - Text-only selectors that are very short (≤2 chars) or numeric-only
 *
 * Returns `true` if the element should be REJECTED as a tap/interaction target.
 */
export function isLowConfidenceElement(el: UIElement): boolean {
  const idOrLabel = el.id || el.accessibilityLabel;

  // ── Check transient patterns on id/label ──
  if (idOrLabel) {
    for (const pattern of TRANSIENT_PATTERNS) {
      if (pattern.test(idOrLabel)) {
        return true;
      }
    }
  }

  // ── Check decorative labels (only rejected if not interactive) ──
  if (el.accessibilityLabel && !el.id) {
    const normalized = el.accessibilityLabel.toLowerCase().trim();
    if (DECORATIVE_LABELS.has(normalized) && !isInteractiveRole(el.role)) {
      return true;
    }
  }

  // ── Check text-only selectors for ambiguity ──
  if (el.text && !el.id && !el.accessibilityLabel) {
    // Very short text (≤2 chars) is almost always ambiguous
    if (el.text.length <= 2) {
      return true;
    }
    // Numeric-only text is a dynamic value, not a stable target
    if (/^\d+$/.test(el.text)) {
      return true;
    }
  }

  return false;
}
