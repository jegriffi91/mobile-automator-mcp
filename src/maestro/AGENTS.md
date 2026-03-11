# Maestro Module — AGENTS.md

## Purpose

UI automation via the Maestro CLI, abstracted through the **AutomationDriver** interface. Provides pluggable driver backends (CLI subprocess and MCP daemon) with centralized timeout configuration.

## Architecture Boundaries

- **Owns:** AutomationDriver interface, DriverFactory, Maestro CLI invocation, MCP daemon lifecycle, UI hierarchy parsing, UI action dispatch, centralized `TimeoutConfig`.
- **Must NOT** import from `session/`, `proxyman/`, or `synthesis/`.
- **May import:** `types.ts` for domain models (`UIHierarchyNode`, `UIElement`, `UIActionType`, `TimeoutConfig`, `DEFAULT_TIMEOUTS`).

## Architecture: Driver Interface

The `AutomationDriver` interface abstracts all Maestro interactions behind a unified API. Handlers and SessionManager depend only on this interface — they never import `MaestroWrapper` or `MaestroDaemon` directly.

```
DriverFactory.create(timeouts?)
    └─▶ MaestroDaemonDriver (preferred — warm JVM, sub-second hierarchy)
         ├── hierarchy ops → MaestroDaemon (JSON-RPC)
         └── actions/tests → MaestroWrapper (CLI subprocess)
    └─▶ MaestroCliDriver (fallback — cold JVM per call)
         └── all ops → MaestroWrapper (CLI subprocess)
```

**Key rules:**
- Drivers are created **per-session** by `DriverFactory.create()` in `handlers.ts`.
- The fallback decision (daemon → CLI) is encapsulated in `DriverFactory` — not in handlers or SessionManager.
- `TimeoutConfig` flows through the factory → drivers → wrapper/daemon.

## File Inventory

| File | Description |
|---|---|
| `driver.ts` | `AutomationDriver` interface, `TreeHierarchyReader` type, `DriverFactory` |
| `cli-driver.ts` | `MaestroCliDriver` — adapter wrapping `MaestroWrapper` |
| `daemon-driver.ts` | `MaestroDaemonDriver` — daemon for hierarchy, wrapper for actions |
| `driver.test.ts` | Unit tests for `AutomationDriver`, `TimeoutConfig`, `DEFAULT_TIMEOUTS` |
| `index.ts` | Barrel exports for all module types and classes |
| `wrapper.ts` | Maestro CLI wrapper — `execFile` calls for hierarchy, tap, type, scroll, swipe, back |
| `hierarchy.ts` | JSON → `UIHierarchyNode[]` parser — normalizes the raw Maestro hierarchy dump |
| `env.ts` | Shared environment utilities — `resolveMaestroBin()` and `getExecEnv()` |
| `daemon.ts` | `MaestroDaemon` — persistent `maestro mcp` child process for sub-second hierarchy via JSON-RPC |
| `csv-hierarchy-parser.ts` | CSV → `UIHierarchyNode` parser for `inspect_view_hierarchy` output from Maestro MCP |
| `hierarchy-differ.ts` | Diffs two `UIHierarchyNode[]` trees — computes `StateChange` with added/removed elements |
| `hierarchy-differ.test.ts` | Unit tests for hierarchy diffing logic |
| `csv-hierarchy-parser.test.ts` | Unit tests for CSV hierarchy parser |

## Centralized Timeout Config

All Maestro timeouts are defined in `types.ts` as `TimeoutConfig` with `DEFAULT_TIMEOUTS`:

| Timeout | Default | Used By |
|---|---|---|
| `hierarchyDumpMs` | 15,000ms | `wrapper.dumpHierarchy()` |
| `hierarchyLiteMs` | 10,000ms | `wrapper.dumpHierarchyLite()` |
| `actionMs` | 15,000ms | `wrapper.executeAction()` |
| `testRunMs` | 120,000ms | `wrapper.runTest()` |
| `setupValidationMs` | 5,000ms | `wrapper.validateSetup()` |
| `daemonRequestMs` | 15,000ms | `daemon.request()` |
| `daemonShutdownMs` | 3,000ms | `daemon.stop()` |

Per-session overrides are accepted via `start_recording_session` input → `timeouts` field.

## Coding Standards

- CLI calls in `wrapper.ts` must use `execFile` (not `exec`) to avoid shell injection.
- All CLI calls must be wrapped in `try/catch` — capture `stderr` and rethrow with context.
- `hierarchy.ts` is a pure function (XML string in → `UIHierarchyNode[]` out). Do not add side effects.
- Selector priority for UI actions: `id` > `accessibilityLabel` > `text` > `bounds` (fallback).
- **Never hardcode timeout values** — use `this.timeouts.<field>` from the injected `TimeoutConfig`.
- New driver implementations must implement the full `AutomationDriver` interface from `driver.ts`.

## Testing

- **`driver.test.ts`** — Tests `AutomationDriver` interface implementability, `TimeoutConfig` merge behavior, and `DEFAULT_TIMEOUTS` constants.
- **`wrapper.ts`** — NOT unit-testable (shells out to Maestro CLI). Integration tests only if a simulator is available.
- **`hierarchy.ts`** — Pure and testable.
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns and commands.
- Run tests: `npm test`
