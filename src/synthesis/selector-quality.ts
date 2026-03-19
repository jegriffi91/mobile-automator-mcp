/**
 * SelectorQuality — Warns on low-confidence selectors before YAML synthesis.
 *
 * Analyzes UIElement selectors and returns warnings when the selector is likely
 * to be fragile, ambiguous, or transient. Warnings are emitted as YAML comments
 * above the corresponding action in synthesized test scripts.
 */

import type { UIElement } from '../types.js';
import { TRANSIENT_PATTERNS } from '../session/element-quality.js';

export type SelectorWarningKind =
    | 'short-or-numeric'
    | 'transient-id'
    | 'text-only-selector'
    | 'bounds-only';

export interface SelectorWarning {
    kind: SelectorWarningKind;
    message: string;
}

/**
 * Assess the quality of a UIElement's selector and return warnings
 * for any conditions that suggest the selector may be fragile.
 */
export function assessSelectorQuality(element: UIElement): SelectorWarning[] {
    const warnings: SelectorWarning[] = [];

    const activeSelector = element.id || element.accessibilityLabel || element.text;

    // Check for bounds-only fallback (no identifier at all)
    if (!activeSelector) {
        if (element.bounds) {
            warnings.push({
                kind: 'bounds-only',
                message: 'Selector uses screen coordinates — will break on different screen sizes',
            });
        }
        return warnings;
    }

    // Check for transient/generic identifiers in id or label
    const idOrLabel = element.id || element.accessibilityLabel;
    if (idOrLabel) {
        for (const pattern of TRANSIENT_PATTERNS) {
            if (pattern.test(idOrLabel)) {
                warnings.push({
                    kind: 'transient-id',
                    message: `Selector "${idOrLabel}" looks transient (matches ${pattern.source})`,
                });
                break;
            }
        }
    }

    // Check for text-only selector (no id or label)
    if (!element.id && !element.accessibilityLabel && element.text) {
        warnings.push({
            kind: 'text-only-selector',
            message: `No accessibility ID or label — falling back to visible text "${element.text}"`,
        });
    }

    // Check for short or numeric-only text selectors
    const textValue = element.text;
    if (textValue && !element.id && !element.accessibilityLabel) {
        if (textValue.length <= 2) {
            warnings.push({
                kind: 'short-or-numeric',
                message: `Text selector "${textValue}" is very short — likely ambiguous`,
            });
        } else if (/^\d+$/.test(textValue)) {
            warnings.push({
                kind: 'short-or-numeric',
                message: `Text selector "${textValue}" is numeric-only — likely a dynamic value`,
            });
        }
    }

    return warnings;
}
