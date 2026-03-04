/**
 * HierarchyParser — Normalizes raw UI hierarchy XML into a typed tree.
 *
 * Phase 3 will implement:
 *   • parse(): XML string → UIHierarchyNode tree
 *   • Selector prioritization: id/testID → accessibilityLabel → text
 *   • Noise filtering: strip framework-internal nodes
 */

import type { UIHierarchyNode } from '../types.js';

export class HierarchyParser {
    /**
     * Parse raw output from `maestro hierarchy` into a normalized UIHierarchyNode tree.
     */
    static parse(rawOutput: string): UIHierarchyNode {
        try {
            const parsed = JSON.parse(rawOutput);
            return HierarchyParser.normalizeNode(parsed);
        } catch (e) {
            console.error("[HierarchyParser] Failed to parse hierarchy:", e);
            return { role: 'Application', children: [] };
        }
    }

    private static normalizeNode(node: any): UIHierarchyNode {
        const attrs = node.attributes || {};

        // Extract common fields for iOS & Android
        const id = attrs['resource-id'] || node.id || node.resourceId;
        const testId = attrs.testID || node.testId;
        const text = attrs.text || node.text;
        const accessibilityLabel = attrs.accessibilityLabel || attrs['content-desc'] || attrs['accessibility-id'] || node.accessibilityText || node.contentDesc;
        const role = attrs.class || attrs.type || node.class || node.role || 'Element';

        const children = Array.isArray(node.children)
            ? node.children.map((c: any) => HierarchyParser.normalizeNode(c))
            : [];

        return {
            id,
            testId,
            accessibilityLabel,
            text,
            role,
            children
        };
    }

    /**
     * Flatten a hierarchy tree into a list of leaf elements for easier searching.
     */
    static flatten(node: UIHierarchyNode): UIHierarchyNode[] {
        const result: UIHierarchyNode[] = [node];
        for (const child of node.children) {
            result.push(...HierarchyParser.flatten(child));
        }
        return result;
    }
}
