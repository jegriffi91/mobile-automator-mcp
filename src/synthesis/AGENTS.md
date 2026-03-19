# Synthesis Module — AGENTS.md

## Purpose

Test script generation from recorded session data. Correlates UI interactions with network events, generates Maestro YAML test scripts, and writes WireMock stubs for network replay. This module contains the **highest concentration of pure, testable logic** in the codebase.

## Architecture Boundaries

- **Owns:** Timestamp-based correlation, YAML generation, WireMock stub + fixture writing, selective mocking logic.
- **Must NOT** import from `maestro/`, `proxyman/`, or `session/`. It operates on already-fetched data (arrays of `UIInteraction` and `NetworkEvent`).
- **Must NOT** shell out to external processes — all logic is pure.
- **May import:** `types.ts` for domain models (`UIInteraction`, `NetworkEvent`).

## File Inventory

| File | Description |
|---|---|
| `index.ts` | Barrel exports for `Correlator`, `YamlGenerator`, `StubWriter`, and associated types |
| `correlator.ts` | Matches UI interactions → network events using a sliding time window (default 5s) |
| `correlator.test.ts` | Unit tests for the correlator |
| `generator.ts` | Produces Maestro YAML from correlated steps, with inline network context comments |
| `generator.test.ts` | Unit tests for the YAML generator |
| `stub-writer.ts` | Produces WireMock `mappings/*.json` + `__files/*_response.json` and supports selective mocking (`full`, `include`, `exclude` modes) |
| `timeline-builder.ts` | Assembles a unified chronological timeline from session data for post-hoc debugging — lifecycle, per-poll records, interactions, network events, correlation decisions, and gap analysis |
| `timeline-builder.test.ts` | Unit tests for the timeline builder |

## Coding Standards

- **Correlator:** The time window is configurable. Default is 3000ms. A network event is attached to the most recent preceding UI action if `event.timestamp - action.timestamp <= windowMs`.
- **Generator:** Output must be valid Maestro YAML. Use string concatenation, not a YAML library, to maintain full control over formatting and comments.
- **StubWriter:** WireMock stub filenames are derived from `METHOD_path.json` (e.g. `post_api_login.json`). Response fixtures go in `__files/`. For `include`/`exclude` mocking modes, a `_proxy_fallback.json` stub is generated.
- **TimelineBuilder:** Pure function — no I/O, no side effects. Accepts `PollRecord[]`, interactions, network events, and correlated steps. May import `types.ts` and `PollRecord` from `session/touch-inferrer.ts` (exception to the no-session-imports rule — importing only a type).
- All three files export a single class with a clear public API. Keep internal helpers as private methods.

## Testing

- **All three core files are testable** — pure logic, no I/O.
- **Existing tests:** `correlator.test.ts`, `generator.test.ts`, `timeline-builder.test.ts`.
- **Missing tests:** `stub-writer.ts` — strong candidate for new test coverage.
- When modifying any file in this module, always run: `npm test`
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns and commands.
