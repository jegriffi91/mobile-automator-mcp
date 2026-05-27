/**
 * Loupe → canonical UIHierarchyNode converter.
 *
 * The convergence point for the Loupe backend: takes a `LoupeAccessibilityTree`
 * (JSON returned by `GET /accessibility` from the in-process Loupe server) and
 * emits the same `UIHierarchyNode` shape the Maestro `HierarchyParser` produces.
 * Once a tree passes through this function, every downstream consumer
 * (`HierarchyDiffer`, `flattenToElements`, structural hashing, synthesis) works
 * unchanged.
 *
 * Pure function — no I/O, no logging.
 */

import type { UIHierarchyNode } from '../types.js';
import { computeStructuralHash } from '../maestro/structural-hash.js';

/**
 * A single node in Loupe's accessibility tree as returned by GET /accessibility.
 * Shape mirrors upstream LoupeAccessibilityNode in heoblitz/Loupe.
 */
export interface LoupeAccessibilityNode {
    ref: string;
    parentRef?: string | null;
    role?: string;
    label?: string;
    value?: string;
    text?: string;
    placeholder?: string;
    hint?: string;
    testID?: string;
    identifier?: string;
    traits?: string[];
    frame?: { x: number; y: number; width: number; height: number };
    isVisible?: boolean;
    isEnabled?: boolean;
    isInteractive?: boolean;
    children?: string[];
}

export interface LoupeAccessibilityTree {
    rootRefs: string[];
    nodes: Record<string, LoupeAccessibilityNode>;
}

/**
 * Map a UIAccessibilityTrait to the role string Maestro would emit. Kept narrow
 * — the synthesizer only branches on a handful of role names, so anything not
 * in this table falls through to the raw `role` field (or 'Element').
 */
function traitToRole(traits: string[] | undefined): string | undefined {
    if (!traits || traits.length === 0) return undefined;
    if (traits.includes('secureTextEntry')) return 'SecureTextField';
    if (traits.includes('button')) return 'Button';
    if (traits.includes('link')) return 'Link';
    if (traits.includes('image')) return 'Image';
    if (traits.includes('staticText')) return 'StaticText';
    if (traits.includes('searchField')) return 'SearchField';
    if (traits.includes('header')) return 'Header';
    if (traits.includes('tab')) return 'Tab';
    return undefined;
}

function isSecureNode(node: LoupeAccessibilityNode, role: string): boolean {
    if (role === 'SecureTextField') return true;
    if (node.traits?.includes('secureTextEntry')) return true;
    return false;
}

/**
 * Defensive filter — Loupe's upstream `shouldInclude` already drops most
 * non-identifiable hidden nodes, but we re-check here so a stale upstream
 * version can't sneak in noise that perturbs the structural hash.
 */
function shouldDrop(node: LoupeAccessibilityNode): boolean {
    if (node.isVisible === false) {
        const hasIdentity = node.testID || node.identifier || node.label || node.value || node.text || node.placeholder;
        if (!hasIdentity) return true;
    }
    return false;
}

function convertNode(
    node: LoupeAccessibilityNode,
    tree: LoupeAccessibilityTree,
    visited: Set<string>,
): UIHierarchyNode {
    visited.add(node.ref);

    const traitRole = traitToRole(node.traits);
    const role = node.role || traitRole || 'Element';

    const id = node.testID || node.identifier;
    const accessibilityLabel = node.label;
    const text = node.value || node.text || node.placeholder;
    const isSecure = isSecureNode(node, role);
    const bounds = node.frame;

    const children: UIHierarchyNode[] = [];
    for (const childRef of node.children ?? []) {
        if (visited.has(childRef)) continue; // cycle guard
        const childNode = tree.nodes[childRef];
        if (!childNode) continue;
        if (shouldDrop(childNode)) continue;
        children.push(convertNode(childNode, tree, visited));
    }

    return {
        ...(id ? { id } : {}),
        ...(accessibilityLabel ? { accessibilityLabel } : {}),
        ...(text ? { text } : {}),
        role,
        children,
        ...(isSecure ? { isSecure } : {}),
        ...(bounds ? { bounds } : {}),
    };
}

/**
 * Convert a Loupe accessibility tree to the canonical UIHierarchyNode shape.
 *
 * When there's exactly one root (the common iOS case — a single window),
 * the converter uses it directly so the tree shape matches Maestro's
 * `HierarchyParser` output: the returned node IS the Application, not a
 * wrapper around it. With multiple roots, a virtual Application wrapper is
 * synthesized.
 */
export function loupeToHierarchy(tree: LoupeAccessibilityTree): UIHierarchyNode {
    const visited = new Set<string>();
    const roots = (tree.rootRefs ?? [])
        .map((ref) => tree.nodes[ref])
        .filter((n): n is LoupeAccessibilityNode => Boolean(n) && !shouldDrop(n));

    let root: UIHierarchyNode;
    if (roots.length === 1) {
        root = convertNode(roots[0], tree, visited);
    } else {
        root = {
            role: 'Application',
            children: roots.map((r) => convertNode(r, tree, visited)),
        };
    }
    root.structuralHash = computeStructuralHash(root);
    return root;
}
