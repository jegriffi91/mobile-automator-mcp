# Maestro Module — AGENTS.md

## Purpose

UI automation via the Maestro CLI. Wraps the `maestro` binary to dispatch UI actions on iOS/Android simulators and to dump + parse the accessibility element tree.

## Architecture Boundaries

- **Owns:** Maestro CLI invocation, UI hierarchy XML parsing, UI action dispatch.
- **Must NOT** import from `session/`, `proxyman/`, or `synthesis/`.
- **May import:** `types.ts` for domain models (`UIHierarchyNode`, `UIElement`, `UIActionType`).

## File Inventory

| File | Description |
|---|---|
| `index.ts` | Barrel exports + global `maestroWrapper` singleton |
| `wrapper.ts` | Maestro CLI wrapper — `execFile` calls for `maestro hierarchy`, tap, type, scroll, swipe, back |
| `hierarchy.ts` | JSON → `UIHierarchyNode[]` parser — normalizes the raw Maestro hierarchy dump into the domain model |
| `env.ts` | Shared environment utilities — `resolveMaestroBin()` and `getExecEnv()` for JAVA_HOME/PATH resolution |
| `daemon.ts` | `MaestroDaemon` — persistent `maestro mcp` child process for sub-second hierarchy polling via JSON-RPC |
| `csv-hierarchy-parser.ts` | CSV → `UIHierarchyNode` parser for `inspect_view_hierarchy` output from Maestro MCP |
| `hierarchy-differ.ts` | Diffs two `UIHierarchyNode[]` trees — computes `StateChange` with added/removed elements |
| `hierarchy-differ.test.ts` | Unit tests for hierarchy diffing logic |

## Coding Standards

- CLI calls in `wrapper.ts` must use `execFile` (not `exec`) to avoid shell injection.
- All CLI calls must be wrapped in `try/catch` — capture `stderr` and rethrow with context.
- `hierarchy.ts` is a pure function (XML string in → `UIHierarchyNode[]` out). Do not add side effects.
- Selector priority for UI actions: `id` > `accessibilityLabel` > `text` > `bounds` (fallback).

## Testing

- **`wrapper.ts`** — NOT unit-testable (shells out to Maestro CLI). Integration tests only if a simulator is available.
- **`hierarchy.ts`** — Pure and testable. No existing tests — strong candidate for new test coverage.
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns and commands.
- Run tests: `npm test`
