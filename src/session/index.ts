/**
 * Session sub-package — Recording session lifecycle and persistence.
 *
 * Responsible for:
 *   • sql.js database initialization and schema creation
 *   • Session CRUD (create, query, transition status)
 *   • Logging UI interactions and network events to the session
 */

export { SessionDatabase } from './database.js';
export { SessionManager } from './manager.js';
export { TouchInferrer, inferInteraction } from './touch-inferrer.js';
export type { PollingStatus } from './touch-inferrer.js';

import { SessionManager } from './manager.js';

// Global singleton instance for the MCP server
export const sessionManager = new SessionManager();
