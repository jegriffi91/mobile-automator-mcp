# Proxyman Module — AGENTS.md

## Purpose

Network interception via the Proxyman CLI and SDUI payload validation. Wraps `proxyman-cli` to export HTTP traffic logs and provides a deep-compare validator for server-driven UI payloads.

## Architecture Boundaries

- **Owns:** Proxyman CLI invocation (export logs, count entries), HAR parsing, SDUI payload deep-comparison.
- **Must NOT** import from `session/`, `maestro/`, or `synthesis/`.
- **May import:** `types.ts` for domain models (`NetworkEvent`).

## File Inventory

| File | Description |
|---|---|
| `index.ts` | Barrel exports + global `proxymanWrapper` singleton |
| `wrapper.ts` | Proxyman CLI wrapper — `execFile` calls for `proxyman-cli export-log`, traffic count, domain filtering |
| `validator.ts` | SDUI payload validator — deep-compares actual JSON response against expected field shapes |
| `validator.test.ts` | Unit tests for the validator |

## Coding Standards

- CLI calls in `wrapper.ts` must use `execFile` (not `exec`) to avoid shell injection.
- All CLI calls must be wrapped in `try/catch` — capture `stderr` and rethrow with context.
- The `proxyman-cli` binary path is `/Applications/Proxyman.app/Contents/MacOS/proxyman-cli`. Do not hardcode alternative paths without checking.
- `validator.ts` is pure logic — no I/O. It receives parsed JSON objects and returns match results.
- See [Proxyman Setup](../../docs/proxyman-setup.md) for simulator and localhost configuration.

## Testing

- **`wrapper.ts`** — NOT unit-testable (shells out to proxyman-cli).
- **`validator.ts`** — Pure and testable. **Has existing tests** in `validator.test.ts`.
- When modifying `validator.ts`, run existing tests first: `npm test`
- See [Testing Strategy](../../docs/testing-strategy.md) for patterns and commands.
