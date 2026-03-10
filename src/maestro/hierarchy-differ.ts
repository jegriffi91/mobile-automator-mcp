/**
 * HierarchyDiffer — Diffs two parsed hierarchy trees to detect state changes.
 *
 * Compares UIHierarchyNode trees by identity (id, accessibilityLabel, text)
 * and produces a StateChange showing which elements appeared, disappeared,
 * or changed attributes.
 */

import type { UIHierarchyNode, UIElement, StateChange, ElementChange } from '../types.js';

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

/**
 * Compute a stable identity key that ignores mutable attributes (text).
 * Two elements with the same identityKey are the "same" element — we can then
 * detect their attribute changes.
 */
function identityKey(el: UIElement): string {
    // Prefer id, then accessibilityLabel. Text is mutable so it's not a stable identity.
    if (el.id) return `id:${el.id}`;
    if (el.accessibilityLabel) return `label:${el.accessibilityLabel}`;
    return '';
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

        // Raw adds/removes based on full element key (including text)
        const rawAdded = afterElements.filter((el) => !beforeKeys.has(elementKey(el)));
        const rawRemoved = beforeElements.filter((el) => !afterKeys.has(elementKey(el)));

        // Detect attribute changes: elements with the same identity but different full key
        const elementsChanged: ElementChange[] = [];
        const matchedAddedIndices = new Set<number>();
        const matchedRemovedIndices = new Set<number>();

        for (let ri = 0; ri < rawRemoved.length; ri++) {
            const removed = rawRemoved[ri];
            const removedId = identityKey(removed);
            if (!removedId) continue; // can't track elements without stable identity

            for (let ai = 0; ai < rawAdded.length; ai++) {
                if (matchedAddedIndices.has(ai)) continue;
                const added = rawAdded[ai];
                if (identityKey(added) === removedId) {
                    // Same element, different attributes — this is a change, not add/remove
                    const changedAttr = removed.text !== added.text ? 'text' as const
                        : removed.accessibilityLabel !== added.accessibilityLabel ? 'accessibilityLabel' as const
                        : 'role' as const;

                    elementsChanged.push({
                        identityKey: removedId,
                        before: removed,
                        after: added,
                        changedAttribute: changedAttr,
                    });

                    matchedRemovedIndices.add(ri);
                    matchedAddedIndices.add(ai);
                    break;
                }
            }
        }

        // Filter out matched pairs from added/removed
        const elementsAdded = rawAdded.filter((_, i) => !matchedAddedIndices.has(i));
        const elementsRemoved = rawRemoved.filter((_, i) => !matchedRemovedIndices.has(i));

        return {
            timestamp: new Date().toISOString(),
            actionId,
            elementsAdded,
            elementsRemoved,
            elementsChanged,
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

