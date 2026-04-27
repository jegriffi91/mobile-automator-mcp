/**
 * Guard against running `maestro test` / `maestro flow` while a recording
 * session is active.
 *
 * Root cause: `run_test` / `run_flow` call `ensureCleanDriverState`, which
 * uninstalls the iOS XCTest driver on port 7001. If a recording session owns
 * that driver, the session's hierarchy poller drops and subsequent `maestro`
 * commands hit `Connection refused :7001` mid-flow.
 *
 * The maestro test CLI unconditionally spawns its own XCTRunner on port 7001,
 * so there's no way to share the port with an active daemon driver — fail fast
 * with a clear pointer instead.
 */

/**
 * Throws a descriptive error if any recording sessions are currently active.
 *
 * @param activeSessionIds - List of session IDs with active drivers (from
 *   SessionManager.listActiveDrivers()).
 * @param toolName - Name of the calling tool (for the error message)
 */
export function assertNoActiveSessions(
    activeSessionIds: readonly string[],
    toolName: string,
): void {
    if (activeSessionIds.length === 0) return;

    const sessionIds = [...activeSessionIds];
    throw new Error(
        `Cannot run '${toolName}' while a recording session is active ` +
        `(sessions: ${sessionIds.join(', ')}). ` +
        `'${toolName}' uninstalls the XCTest driver on port 7001, which would ` +
        `terminate the session's hierarchy poller mid-flow. ` +
        `Either call 'stop_and_compile_test' first, or use 'execute_ui_action' ` +
        `to drive UI steps through the existing session's driver.`,
    );
}
