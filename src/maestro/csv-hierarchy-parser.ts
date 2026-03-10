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
  const parentNum = parseInt(fields[4], 10);

  if (isNaN(elementNum) || isNaN(depth) || isNaN(parentNum)) return null;

  return {
    elementNum,
    depth,
    bounds: fields[2],
    attributes: parseAttributes(fields[3]),
    parentNum,
  };
}

/**
 * Convert a parsed CSV row into a UIHierarchyNode (without children — those are assembled later).
 */
function rowToNode(row: CsvRow): UIHierarchyNode & { _elementNum: number; _parentNum: number } {
  const attrs = row.attributes;

  const id = attrs['resource-id'] || undefined;
  const accessibilityLabel = attrs['accessibilityText'] || attrs['content-desc'] || undefined;
  const text = attrs['text'] || attrs['value'] || undefined;
  const role = attrs['class'] || attrs['type'] || 'Element';

  return {
    id,
    accessibilityLabel,
    text,
    role,
    children: [],
    _elementNum: row.elementNum,
    _parentNum: row.parentNum,
  };
}

/**
 * Parse the full CSV output from `inspect_view_hierarchy` into a UIHierarchyNode tree.
 *
 * The first line is the header row and is skipped.
 * Nodes are assembled into a tree using parent_num references.
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

  // Convert rows to nodes, indexed by element_num
  const nodeMap = new Map<number, UIHierarchyNode & { _elementNum: number; _parentNum: number }>();
  for (const row of rows) {
    nodeMap.set(row.elementNum, rowToNode(row));
  }

  // Build tree by linking children to parents
  let root: UIHierarchyNode | null = null;

  for (const [, node] of nodeMap) {
    const parent = nodeMap.get(node._parentNum);
    if (parent) {
      parent.children.push(node);
    } else {
      // No parent found — this is a root node (or top-level)
      if (!root) {
        root = node;
      }
    }
  }

  // Clean up internal fields before returning
  for (const [, node] of nodeMap) {
    delete (node as unknown as Record<string, unknown>)['_elementNum'];
    delete (node as unknown as Record<string, unknown>)['_parentNum'];
  }

  return root || { role: 'Application', children: [] };
}
