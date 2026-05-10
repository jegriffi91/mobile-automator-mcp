/**
 * Baseline compactor wrapper.
 *
 * Wraps the existing `HierarchyParser.parse → filterInteractive → compact`
 * pipeline plus a deterministic string renderer. This is the "compactor under
 * test" today; when the real spatial-semantic compactor lands it swaps in
 * behind the same interface (same input, same `RenderedScreen` output).
 */

import { HierarchyParser } from '../../src/maestro/hierarchy.js';
import type { UIHierarchyNode } from '../../src/types.js';
import { gridLabel, type Bounds } from './spatial.js';
import type { GridLabel } from './types.js';

export interface RenderedNode {
    /** Stable identifier preferred order: id → testId → accessibilityLabel → text. */
    key: string;
    /** Source field that filled `key`, for diagnostics. */
    keySource: 'id' | 'testId' | 'accessibilityLabel' | 'text';
    role: string;
    text?: string;
    accessibilityLabel?: string;
    bounds?: Bounds;
    /** 3x3 grid label computed against the device root bounds. */
    spatial?: GridLabel;
}

export interface RenderedScreen {
    /** One line per node, in deterministic depth-first order. */
    text: string;
    /** Flat list mirroring the lines in `text`. Indexed by line number. */
    nodes: RenderedNode[];
    /** Original parsed root (carries device bounds). */
    parsedRoot: UIHierarchyNode;
    /** Compacted root after filterInteractive + compact. */
    compactedRoot: UIHierarchyNode;
    /** Byte counts for compaction-ratio scoring. */
    rawBytes: number;
    compactedBytes: number;
    nodesBefore: number;
    nodesAfter: number;
}

export interface CompactOptions {
    /** Raw hierarchy XML/CSV string from `driver.dumpHierarchy()`. */
    raw: string;
}

/**
 * Run the baseline compactor pipeline and emit a deterministic rendered
 * string suitable for inclusion in an LLM prompt.
 */
export function compactBaseline({ raw }: CompactOptions): RenderedScreen {
    const parsedRoot = HierarchyParser.parse(raw);
    const filtered = HierarchyParser.filterInteractive(parsedRoot);
    const compactedRoot = HierarchyParser.compact(filtered);

    const root = parsedRoot.bounds;
    const renderedNodes: RenderedNode[] = [];
    const lines: string[] = [];

    walk(compactedRoot, root, renderedNodes, lines);

    const text = lines.join('\n');
    const compactedBytes = Buffer.byteLength(text, 'utf8');
    const rawBytes = Buffer.byteLength(raw, 'utf8');
    const nodesBefore = HierarchyParser.countNodes(parsedRoot);
    const nodesAfter = HierarchyParser.countNodes(compactedRoot);

    return { text, nodes: renderedNodes, parsedRoot, compactedRoot, rawBytes, compactedBytes, nodesBefore, nodesAfter };
}

function walk(
    node: UIHierarchyNode,
    root: Bounds | undefined,
    out: RenderedNode[],
    lines: string[],
): void {
    const key = pickKey(node);
    if (key) {
        const spatial = node.bounds && root ? gridLabel(node.bounds, root) : undefined;
        const rendered: RenderedNode = {
            key: key.value,
            keySource: key.source,
            role: node.role,
            text: node.text,
            accessibilityLabel: node.accessibilityLabel,
            bounds: node.bounds,
            spatial,
        };
        out.push(rendered);
        lines.push(formatLine(rendered));
    }
    for (const child of node.children) {
        walk(child, root, out, lines);
    }
}

function pickKey(node: UIHierarchyNode): { value: string; source: RenderedNode['keySource'] } | null {
    if (node.id) return { value: node.id, source: 'id' };
    if (node.testId) return { value: node.testId, source: 'testId' };
    if (node.accessibilityLabel) return { value: node.accessibilityLabel, source: 'accessibilityLabel' };
    if (node.text) return { value: node.text, source: 'text' };
    return null;
}

function formatLine(n: RenderedNode): string {
    const parts: string[] = [];
    if (n.spatial) parts.push(`[${n.spatial}]`);
    parts.push(n.role);
    parts.push(`id="${escape(n.key)}"`);
    if (n.text && n.text !== n.key) parts.push(`text="${escape(n.text)}"`);
    if (n.accessibilityLabel && n.accessibilityLabel !== n.key && n.accessibilityLabel !== n.text) {
        parts.push(`label="${escape(n.accessibilityLabel)}"`);
    }
    return parts.join(' ');
}

function escape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}
