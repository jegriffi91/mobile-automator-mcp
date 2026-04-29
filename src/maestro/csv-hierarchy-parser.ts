/**
 * CsvHierarchyParser — Parses hierarchy CSV from `maestro mcp`'s
 * `inspect_view_hierarchy` tool into a UIHierarchyNode tree.
 *
 * CSV format:
 *   element_num,depth,bounds,attributes,parent_num
 *   7,7,"[68,255][333,312]","accessibilityText=VILLAIN OS; resource-id=login_title; enabled=true",6
 *
 * Attributes are semicolon-separated key=value pairs.
 */

import type { UIHierarchyNode } from '../types.js';
import { computeStructuralHash } from './structural-hash.js';

interface CsvRow {
  elementNum: number;
  depth: number;
  bounds: string;
  attributes: Record<string, string>;
  parentNum: number;
}

/**
 * Parse the semicolon-delimited attributes string into a key-value map.
 *
 * Example input: "accessibilityText=VILLAIN OS; resource-id=login_title; enabled=true"
 * Example output: { accessibilityText: "VILLAIN OS", "resource-id": "login_title", enabled: "true" }
 */
export function parseAttributes(attrStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!attrStr || attrStr.trim() === '') return result;

  // Split on '; ' (semicolon + space), but also handle plain ';'
  const pairs = attrStr.split(/;\s*/);
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key) result[key] = value;
  }

  return result;
}

/**
 * Parse a single CSV row into a structured object.
 * Handles quoted fields (bounds and attributes contain commas).
 */
function parseCsvRow(line: string): CsvRow | null {
  // CSV format: element_num,depth,"bounds","attributes",parent_num
  // We need to handle quoted fields that may contain commas
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current); // push last field

  if (fields.length < 5) return null;

  const elementNum = parseInt(fields[0], 10);
  const depth = parseInt(fields[1], 10);
  // Root nodes (depth 0) have no parent — parent_num is empty → NaN. Default to -1
  // so the row still parses; the tree is assembled from depth, not parent_num.
  const parsedParent = parseInt(fields[4], 10);
  const parentNum = isNaN(parsedParent) ? -1 : parsedParent;

  if (isNaN(elementNum) || isNaN(depth)) return null;

  return {
    elementNum,
    depth,
    bounds: fields[2],
    attributes: parseAttributes(fields[3]),
    parentNum,
  };
}

/**
 * Parses Maestro's bounds format "[x1,y1][x2,y2]" into {x, y, width, height}.
 * Returns undefined on malformed input.
 */
export function parseBoundsString(s: string): { x: number; y: number; width: number; height: number } | undefined {
  if (!s) return undefined;
  const match = s.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return undefined;
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return undefined;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Convert a parsed CSV row into a UIHierarchyNode (without children — those are assembled later).
 */
function rowToNode(row: CsvRow): UIHierarchyNode {
  const attrs = row.attributes;

  const id = attrs['resource-id'] || undefined;
  const accessibilityLabel = attrs['accessibilityText'] || attrs['content-desc'] || undefined;
  const text = attrs['text'] || attrs['value'] || undefined;
  const role = attrs['class'] || attrs['type'] || 'Element';
  const bounds = parseBoundsString(row.bounds);

  return {
    id,
    accessibilityLabel,
    text,
    role,
    children: [],
    ...(bounds ? { bounds } : {}),
  };
}

/**
 * Parse the full CSV output from `inspect_view_hierarchy` into a UIHierarchyNode tree.
 *
 * The first line is the header row and is skipped.
 * Nodes are assembled into a tree using the depth level, because element_num and parent_num
 * are known to be duplicated/reused in Maestro's iOS 18 (XCUITest) hierarchy dumps.
 */
export function parseCsvHierarchy(csv: string): UIHierarchyNode {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');

  if (lines.length === 0) {
    return { role: 'Application', children: [] };
  }

  // Skip header if present
  const headerLine = lines[0];
  const dataLines = headerLine.startsWith('element_num') ? lines.slice(1) : lines;

  // Parse all rows
  const rows = dataLines.map(parseCsvRow).filter((r): r is CsvRow => r !== null);

  if (rows.length === 0) {
    return { role: 'Application', children: [] };
  }

  // Use a stack-based parser to track nesting by depth, completely ignoring
  // element_num and parent_num, which are buggy and not unique on iOS.
  const stack: UIHierarchyNode[] = [];
  let root: UIHierarchyNode | null = null;

  for (const row of rows) {
    const node = rowToNode(row);
    const depth = row.depth;

    if (depth === 0) {
      if (!root) {
        root = node;
      }
      stack[0] = node;
    } else {
      // Find the parent node at depth - 1
      const parent = stack[depth - 1];
      if (parent) {
        parent.children.push(node);
      }
      // Update the stack at current depth with this node
      stack[depth] = node;
    }
  }

  const result = root || { role: 'Application', children: [] };
  result.structuralHash = computeStructuralHash(result);
  return result;
}
