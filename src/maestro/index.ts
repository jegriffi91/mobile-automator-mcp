/**
 * Maestro sub-package — UI automation via the Maestro CLI.
 *
 * Responsible for:
 *   • AutomationDriver interface and DriverFactory for backend abstraction
 *   • Wrapping the Maestro CLI (child_process) via MaestroCliDriver
 *   • Managing the persistent Maestro MCP daemon via MaestroDaemonDriver
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
export { DriverFactory } from './driver.js';
export type { AutomationDriver, TreeHierarchyReader } from './driver.js';
export { MaestroCliDriver } from './cli-driver.js';
export { MaestroDaemonDriver } from './daemon-driver.js';
