# Session Module — AGENTS.md

## Purpose

Session lifecycle management and SQLite persistence. Owns the recording session state machine and stores all UI interactions and network events captured during a session.

## Architecture Boundaries

- **Owns:** Session CRUD, status transitions (`idle → recording → compiling → done`), UI interaction logging, network event logging.
- **Must NOT** import from `maestro/`, `proxyman/`, or `synthesis/`. This module is a dependency of `handlers.ts`, not of other submodules.
- **May import:** `types.ts` for domain models (`Session`, `UIInteraction`, `NetworkEvent`).

## File Inventory

| File | Description |
|---|---|
| `index.ts` | Barrel exports + global `sessionManager` singleton |
| `database.ts` | sql.js wrapper — schema creation, raw SQL queries for sessions, interactions, and network events |
| `manager.ts` | High-level session API — create, start, stop, log interaction, log network event, query |

## Coding Standards

- All SQL queries live in `database.ts`, never in `manager.ts`.
- `manager.ts` delegates to `database.ts` and adds business logic (e.g. status transition validation).
- Use parameterized queries (`?` placeholders) — never interpolate values into SQL strings.
- The `proxymanBaseline` field on `Session` is set at recording start and must not be modified after.

## Testing

- **Testable:** Both `database.ts` and `manager.ts` contain pure logic (sql.js is in-process, no external I/O).
- **No existing tests** — candidate for new test coverage.
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns and commands.
- Run tests: `npm test`
