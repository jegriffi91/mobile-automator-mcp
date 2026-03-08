# WireMock Module — AGENTS.md

## Purpose

In-process HTTP stub server for zero-config test replay. Loads WireMock-compatible `mappings/` and `__files/` and serves responses via Node's built-in `http` module. No external WireMock JAR required.

## Architecture Boundaries

- **Owns:** Stub loading, HTTP request matching, response serving, port allocation.
- **Must NOT** import from `session/`, `maestro/`, `proxyman/`, `synthesis/`, or `segments/`.
- **No external dependencies** — uses only Node built-in modules (`http`, `fs`, `net`, `path`).

## File Inventory

| File | Description |
|---|---|
| `index.ts` | Barrel exports |
| `runner.ts` | `StubServer` class — load mappings, start/stop HTTP server, request matching |

## Coding Standards

- The server binds to `0.0.0.0` (not `localhost`) so simulators on the same host can reach it.
- Port `0` means auto-select an available port — always support this for concurrent execution.
- Request matching follows WireMock priority order (lower `priority` value = higher precedence).
- `urlPathPattern` does exact path matching; `urlPattern` uses regex (for catch-all proxy stubs).

## Testing

- **`runner.ts`** — Testable with in-process HTTP clients. No existing tests — candidate for coverage.
- Run tests: `npm test`
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns.
