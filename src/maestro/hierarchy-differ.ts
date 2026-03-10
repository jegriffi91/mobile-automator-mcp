/**
 * HierarchyDiffer — Diffs two parsed hierarchy trees to detect state changes.
 *
 * Compares UIHierarchyNode trees by identity (id, accessibilityLabel, text)
 * and produces a StateChange showing which elements appeared or disappeared.
 */

import type { UIHierarchyNode, UIElement, StateChange } from '../types.js';

/**
 * Flatten a hierarchy tree into a list of leaf-level elements for comparison.
 * Skips container nodes (no identifier) and focuses on identifiable elements.
 */
function flattenToElements(node: UIHierarchyNode): UIElement[] {
    const elements: UIElement[] = [];

    const hasIdentity = node.id || node.accessibilityLabel || node.text;
    if (hasIdentity) {
        elements.push({
            id: node.id,
            accessibilityLabel: node.accessibilityLabel,
            text: node.text,
            role: node.role,
        });
    }

    for (const child of node.children) {
        elements.push(...flattenToElements(child));
    }

    return elements;
}

/**
 * Compute a stable key for a UIElement so we can compare sets.
 */
function elementKey(el: UIElement): string {
    return `${el.id || ''}|${el.accessibilityLabel || ''}|${el.text || ''}|${el.role || ''}`;
}

export class HierarchyDiffer {
    /**
     * Diff two hierarchy trees and return the state change.
     *
     * @param before - Hierarchy snapshot taken before an action
     * @param after - Hierarchy snapshot taken after the action (post-settle)
     * @param actionId - Optional interaction ID that triggered this change
     * @param settleDurationMs - How long the UI took to stabilize
     */
    static diff(
        before: UIHierarchyNode,
        after: UIHierarchyNode,
        actionId?: number,
        settleDurationMs = 0,
    ): StateChange {
        const beforeElements = flattenToElements(before);
        const afterElements = flattenToElements(after);

        const beforeKeys = new Set(beforeElements.map(elementKey));
        const afterKeys = new Set(afterElements.map(elementKey));

        const elementsAdded: UIElement[] = afterElements.filter((el) => !beforeKeys.has(elementKey(el)));
        const elementsRemoved: UIElement[] = beforeElements.filter((el) => !afterKeys.has(elementKey(el)));

        return {
            timestamp: new Date().toISOString(),
            actionId,
            elementsAdded,
            elementsRemoved,
            settleDurationMs,
        };
    }

    /**
     * Compare two raw hierarchy JSON strings for equality.
     * Used for settle detection — two identical snapshots = UI has settled.
     */
    static areEqual(jsonA: string, jsonB: string): boolean {
        // Quick byte-level comparison first (avoid parsing overhead)
        if (jsonA === jsonB) return true;

        // Parse and deep-compare element sets (ignoring ordering differences)
        try {
            const treeA: UIHierarchyNode = JSON.parse(jsonA);
            const treeB: UIHierarchyNode = JSON.parse(jsonB);
            const keysA = new Set(flattenToElements(treeA).map(elementKey));
            const keysB = new Set(flattenToElements(treeB).map(elementKey));
            if (keysA.size !== keysB.size) return false;
            for (const k of keysA) {
                if (!keysB.has(k)) return false;
            }
            return true;
        } catch {
            return false;
        }
    }
}
