/**
 * Maestro sub-package — UI automation via the Maestro CLI.
 *
 * Responsible for:
 *   • Wrapping the Maestro CLI (child_process)
 *   • Managing the persistent Maestro MCP daemon for fast hierarchy polling
 *   • Dumping and parsing the UI element hierarchy (JSON + CSV formats)
 *   • Dispatching UI actions (tap, type, scroll, etc.)
 *   • Background polling of manual interactions during recording
 */

export { MaestroWrapper } from './wrapper.js';
export { HierarchyParser } from './hierarchy.js';
export { HierarchyDiffer } from './hierarchy-differ.js';
export { MaestroDaemon } from './daemon.js';
export { parseCsvHierarchy, parseAttributes } from './csv-hierarchy-parser.js';
export { resolveMaestroBin, getExecEnv } from './env.js';

import { MaestroWrapper } from './wrapper.js';
export const maestroWrapper = new MaestroWrapper();
