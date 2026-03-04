/**
 * Maestro sub-package — UI automation via the Maestro CLI.
 *
 * Responsible for:
 *   • Wrapping the Maestro CLI (child_process)
 *   • Dumping and parsing the UI element hierarchy
 *   • Dispatching UI actions (tap, type, scroll, etc.)
 *   • Background polling of manual interactions during recording
 */

export { MaestroWrapper } from './wrapper.js';
export { HierarchyParser } from './hierarchy.js';

import { MaestroWrapper } from './wrapper.js';
export const maestroWrapper = new MaestroWrapper();
