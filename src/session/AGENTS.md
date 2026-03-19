# Session Module — AGENTS.md

## Purpose

Session lifecycle management and SQLite persistence. Owns the recording session state machine and stores all UI interactions and network events captured during a session.

## Architecture Boundaries

- **Owns:** Session CRUD, status transitions (`idle → recording → compiling → done`), UI interaction logging, network event logging, passive touch capture.
- **Must NOT** import from `proxyman/` or `synthesis/`.
- **May import:** `types.ts` for domain models (`Session`, `UIInteraction`, `NetworkEvent`). `maestro/driver.ts` for `AutomationDriver` type (used by `startPolling()`).

## File Inventory

| File | Description |
|---|---|
| `index.ts` | Barrel exports + global `sessionManager` singleton |
| `database.ts` | sql.js wrapper — schema creation, raw SQL queries for sessions, interactions, and network events |
| `manager.ts` | High-level session API — create, start, stop, log interaction, log network event, query. Accepts `AutomationDriver` for polling. |
| `touch-inferrer.ts` | Passive touch capture — diffs consecutive hierarchy snapshots to infer `UIInteraction` records |
| `touch-inferrer.test.ts` | Unit tests for touch inference logic |
| `track-event-extractor.ts` | Extracts tracked interactions from network events posted to `/__track` endpoints |
| `track-event-extractor.test.ts` | Unit tests for track event extraction |

## Key Design Notes

- **`startPolling()` accepts `AutomationDriver`** — the driver provides a `createTreeReader()` method for the `TouchInferrer`. The caller (handlers.ts) is responsible for creating and starting the driver.
- **No daemon management in SessionManager** — daemon lifecycle (start/stop) is managed by the driver itself. SessionManager only needs to call `driver.createTreeReader()`.
- **`PollRecord`** — Each `pollOnce()` call accumulates a `PollRecord` (timestamp, duration, result, element count, inferred target). Accessed via `getPollRecords()` for timeline building and mid-session health checks.

## Coding Standards

- All SQL queries live in `database.ts`, never in `manager.ts`.
- `manager.ts` delegates to `database.ts` and adds business logic (e.g. status transition validation).
- Use parameterized queries (`?` placeholders) — never interpolate values into SQL strings.
- The `proxymanBaseline` field on `Session` is set at recording start and must not be modified after.

## Testing

- **Testable:** Both `database.ts` and `manager.ts` contain pure logic (sql.js is in-process, no external I/O).
- **`touch-inferrer.test.ts`** — Comprehensive test suite (38 tests), including polling status, notifier, suppress, rate tracking, and diagnostic counters.
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns and commands.
- Run tests: `npm test`
