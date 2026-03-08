# Segments Module — AGENTS.md

## Purpose

Flow deduplication via deterministic fingerprinting. Computes content-addressable hashes from correlated recording data and manages a persistent registry of named, reusable flow segments.

## Architecture Boundaries

- **Owns:** Fingerprint computation, registry CRUD, segment matching.
- **Must NOT** import from `session/`, `maestro/`, `proxyman/`, or `handlers.ts`.
- **May import:** `synthesis/correlator.ts` for the `CorrelatedStep` type.
- **All logic is pure** (except registry file I/O). No CLI calls, no database access.

## File Inventory

| File | Description |
|---|---|
| `index.ts` | Barrel exports |
| `fingerprint.ts` | SHA-256 fingerprint computation from `CorrelatedStep[]`, Jaccard similarity scoring |
| `fingerprint.test.ts` | Unit tests for fingerprinting |
| `registry.ts` | JSON file-based registry — load, save, query, add, remove segment entries |

## Coding Standards

- Fingerprints are 12-character hex strings (first 12 chars of SHA-256).
- The fingerprint input sequence intentionally excludes timestamps and response bodies — only `actionType`, `target element`, and `endpoint patterns` contribute.
- Registry entries are identified by `name` (unique). Adding an entry with an existing name replaces it.
- The registry file path defaults to `segments/registry.json` relative to the project root.

## Testing

- **`fingerprint.ts`** — Pure and testable. Has tests in `fingerprint.test.ts`.
- **`registry.ts`** — File I/O, but can be tested with temp directories.
- Run tests: `npm test`
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns.
