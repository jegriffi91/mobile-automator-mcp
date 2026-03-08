# Testing Strategy

Global testing rules for the mobile-automator-mcp project. All submodule `AGENTS.md` files link here.

---

## Framework & Configuration

- **Test runner:** [Vitest](https://vitest.dev/) v1.x
- **Config:** `vitest.config.ts` at the project root
- **Globals:** `globals: true` — `describe`, `it`, `expect` are available without imports
- **Pattern:** `src/**/*.test.ts` — co-located next to the module they test

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Single run — CI and pre-PR verification |
| `npm run test:watch` | Watch mode — interactive development |

## What to Test

### ✅ Test (pure logic)

| Module | Testable Files | Existing Tests |
|---|---|---|
| `synthesis/` | `correlator.ts`, `generator.ts`, `stub-writer.ts` | `correlator.test.ts`, `generator.test.ts` |
| `proxyman/` | `validator.ts` | `validator.test.ts` |
| `maestro/` | `hierarchy.ts` | — (candidate for new tests) |
| `session/` | `database.ts`, `manager.ts` | — (candidate for new tests) |

### 🚫 Do NOT unit test (external I/O)

- `maestro/wrapper.ts` — shells out to the Maestro CLI via `child_process`
- `proxyman/wrapper.ts` — shells out to `proxyman-cli`
- `handlers.ts` — orchestration layer; test the submodules it calls instead
- `index.ts` — server bootstrap wiring

## Test Structure

Use the **Given / When / Then** pattern with `describe` and `it` blocks:

```typescript
describe('Correlator', () => {
  describe('correlate()', () => {
    it('should attach network events within the time window to the preceding UI action', () => {
      // Given: a UI interaction and a network event 2s later
      // When: correlate() is called with a 5s window
      // Then: the network event is attached to the UI interaction
    });
  });
});
```

## Coverage Expectations

- **New pure-logic modules** must include a co-located `*.test.ts` file covering happy path + at least one edge case.
- **Bug fixes** in testable modules should include a regression test that fails without the fix.
- There is no formal coverage threshold enforced, but aim for meaningful coverage of branching logic.

## Mocking Guidelines

- Use Vitest's built-in `vi.fn()` and `vi.mock()` for dependency isolation.
- Avoid mocking internal module functions — prefer testing through the public API.
- For CLI wrappers, integration tests (if needed) should run against a real simulator — these are out of scope for unit tests.
