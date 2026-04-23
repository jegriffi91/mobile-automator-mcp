/**
 * HierarchyParser — Normalizes raw UI hierarchy XML into a typed tree.
 *
 * Phase 3 will implement:
 *   • parse(): XML string → UIHierarchyNode tree
 *   • Selector prioritization: id/testID → accessibilityLabel → text
 *   • Noise filtering: strip framework-internal nodes
 */

import type { UIHierarchyNode } from '../types.js';
import { computeStructuralHash } from './structural-hash.js';
import { parseCsvHierarchy } from './csv-hierarchy-parser.js';

export class HierarchyParser {
    /**
     * Parse raw output from `maestro hierarchy` into a normalized UIHierarchyNode tree.
     *
     * Auto-detects JSON vs CSV: Maestro CLI ≤ 2.3 returned JSON, but 2.4.0+ and
     * the `maestro mcp` daemon return a CSV table (element_num,depth,bounds,...).
     */
    static parse(rawOutput: string): UIHierarchyNode {
        const trimmed = rawOutput.trimStart();

        // Maestro 2.4.0+ CLI and daemon return CSV, not JSON.
        if (trimmed.startsWith('element_num')) {
            const root = parseCsvHierarchy(rawOutput);
            if (!root.structuralHash) {
                root.structuralHash = computeStructuralHash(root);
            }
            return root;
        }

        try {
            const parsed = JSON.parse(rawOutput);
            const root = HierarchyParser.normalizeNode(parsed);
            root.structuralHash = computeStructuralHash(root);
            return root;
        } catch (e) {
            console.error("[HierarchyParser] Failed to parse hierarchy:", e);
            return { role: 'Application', children: [], structuralHash: computeStructuralHash({ role: 'Application', children: [] }) };
        }
    }

    private static normalizeNode(node: any): UIHierarchyNode {
        const attrs = node.attributes || {};

        // Extract common fields for iOS & Android
        const id = attrs['resource-id'] || node.id || node.resourceId;
        const testId = attrs.testID || node.testId;
        const text = attrs.text || node.text;
        const accessibilityLabel = attrs.accessibilityLabel || attrs.accessibilityText || attrs['content-desc'] || attrs['accessibility-id'] || node.accessibilityText || node.contentDesc;
        const role = attrs.class || attrs.type || node.class || node.role || 'Element';

        // Detect secure text fields (password inputs)
        // iOS: secureTextEntry attribute or SecureTextField type
        // Android: password attribute or isPassword flag
        const isSecure = !!(
            attrs.secureTextEntry === true ||
            attrs.secureTextEntry === 'true' ||
            attrs.isPassword === true ||
            attrs.isPassword === 'true' ||
            attrs.password === true ||
            attrs.password === 'true' ||
            role === 'SecureTextField'
        ) || undefined;

        const children = Array.isArray(node.children)
            ? node.children.map((c: any) => HierarchyParser.normalizeNode(c))
            : [];

        return {
            id,
            testId,
            accessibilityLabel,
            text,
            role,
            children,
            ...(isSecure ? { isSecure } : {}),
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

    /**
     * Filter the tree to only nodes that have at least one identifier
     * (id, testId, accessibilityLabel, text) or have interactive descendants.
     * Dramatically reduces output size for LLM consumers.
     */
    static filterInteractive(node: UIHierarchyNode): UIHierarchyNode {
        const filteredChildren = node.children
            .map((c) => HierarchyParser.filterInteractive(c))
            .filter((c) => HierarchyParser.hasIdentifier(c));

        return { ...node, children: filteredChildren };
    }

    /**
     * Compact the tree by collapsing single-child chains of anonymous containers
     * and stripping empty anonymous nodes. Reduces tree depth without losing
     * identifiable elements.
     */
    static compact(node: UIHierarchyNode): UIHierarchyNode {
        // Recursively compact children first
        let compactedChildren = node.children.map((c) => HierarchyParser.compact(c));

        // Collapse single-child chains where the single child is anonymous
        while (
            compactedChildren.length === 1 &&
            !HierarchyParser.hasOwnIdentifier(compactedChildren[0])
        ) {
            compactedChildren = compactedChildren[0].children;
        }

        // Strip empty anonymous containers
        compactedChildren = compactedChildren.filter((c) => HierarchyParser.hasIdentifier(c));

        return { ...node, children: compactedChildren };
    }

    /**
     * Count total nodes in the tree.
     */
    static countNodes(node: UIHierarchyNode): number {
        return 1 + node.children.reduce((sum, c) => sum + HierarchyParser.countNodes(c), 0);
    }

    /**
     * Check if a node or any of its descendants has an identifier.
     */
    private static hasIdentifier(node: UIHierarchyNode): boolean {
        if (node.id || node.testId || node.accessibilityLabel || node.text) return true;
        return node.children.some((c) => HierarchyParser.hasIdentifier(c));
    }

    /**
     * Check if this specific node (not descendants) has an identifier.
     */
    private static hasOwnIdentifier(node: UIHierarchyNode): boolean {
        return !!(node.id || node.testId || node.accessibilityLabel || node.text);
    }
}
