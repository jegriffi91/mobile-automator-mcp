/**
 * Structural hash computation for UIHierarchyNode trees.
 *
 * Produces a short hex hash from the sorted set of identifiable elements in
 * a hierarchy tree. Used by HierarchyDiffer.areEqualTrees for O(1) equality
 * comparison instead of O(n) flatten + set difference on every poll cycle.
 *
 * Hash algorithm: FNV-1a 32-bit (fast, non-cryptographic, zero dependencies).
 */

import type { UIHierarchyNode } from '../types.js';

/**
 * Compute the element key used for identity comparison.
 * Must match the key logic in hierarchy-differ.ts.
 */
function elementKey(node: UIHierarchyNode): string {
  return `${node.id || ''}|${node.accessibilityLabel || ''}|${node.text || ''}|${node.role || ''}`;
}

/**
 * Recursively collect element keys from identifiable nodes.
 */
function collectKeys(node: UIHierarchyNode, keys: string[]): void {
  const hasIdentity = node.id || node.accessibilityLabel || node.text;
  if (hasIdentity) {
    keys.push(elementKey(node));
  }
  for (const child of node.children) {
    collectKeys(child, keys);
  }
}

/**
 * FNV-1a 32-bit hash. Fast, non-cryptographic, perfect for structural comparison.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as uint32
  }
  return hash;
}

/**
 * Compute a structural hash for a UIHierarchyNode tree.
 *
 * Flattens the tree to identifiable elements, sorts their keys for
 * order-independence, then hashes the concatenated key string.
 *
 * Returns an 8-character hex string.
 */
export function computeStructuralHash(root: UIHierarchyNode): string {
  const keys: string[] = [];
  collectKeys(root, keys);
  keys.sort();
  const combined = keys.join('\n');
  return fnv1a32(combined).toString(16).padStart(8, '0');
}
