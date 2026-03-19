# Testing Strategy

Global testing rules for the mobile-automator-mcp project. All submodule `AGENTS.md` files link here.

---

## Test Pyramid

The project uses a three-layer test pyramid:

```
        ┌─────────────────┐
        │   Smoke Tests   │  Real simulator + Maestro
        │  (tests/smoke/) │  Slow, requires device
        └────────┬────────┘
        ┌────────▼────────┐
        │  Integration    │  Mocked I/O, full handler pipeline
        │  (tests/*.ts)   │  Medium speed, no device needed
        └────────┬────────┘
        ┌────────▼────────┐
        │   Unit Tests    │  Pure logic modules
        │  (src/**/*.ts)  │  Fast, fully hermetic
        └─────────────────┘
```

---

## Framework & Configuration

- **Test runner:** [Vitest](https://vitest.dev/) v1.x
- **Config:** `vitest.config.ts` at the project root
- **Globals:** `globals: true` — `describe`, `it`, `expect` are available without imports
- **Patterns:** `src/**/*.test.ts` + `tests/**/*.test.ts`

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Single run — CI and pre-PR verification (unit + integration) |
| `npm run test:watch` | Watch mode — interactive development |
| `npm run test:smoke` | Smoke tests — requires booted simulator + installed app |

---

## Layer 1: Unit Tests (pure logic)

### ✅ Test (pure logic)

| Module | Testable Files | Existing Tests |
|---|---|---|
| `synthesis/` | `correlator.ts`, `generator.ts`, `stub-writer.ts`, `timeline-builder.ts` | `correlator.test.ts`, `generator.test.ts`, `timeline-builder.test.ts` |
| `proxyman/` | `validator.ts` | `validator.test.ts` |
| `maestro/` | `csv-hierarchy-parser.ts`, `hierarchy-differ.ts`, `driver.ts` | `csv-hierarchy-parser.test.ts`, `hierarchy-differ.test.ts`, `driver.test.ts` |
| `session/` | `touch-inferrer.ts`, `track-event-extractor.ts` | `touch-inferrer.test.ts`, `track-event-extractor.test.ts` |
| `segments/` | `fingerprint.ts` | `fingerprint.test.ts` |
| `profiling/` | `metric-parser.ts` | `metric-parser.test.ts` |
| `wiremock/` | `runner.ts` | `runner.test.ts` |

### 🚫 Do NOT unit test (external I/O)

- `maestro/wrapper.ts` — shells out to the Maestro CLI via `child_process`
- `proxyman/wrapper.ts` — shells out to `proxyman-cli`
- `handlers.ts` — orchestration layer; tested via integration tests instead
- `index.ts` — server bootstrap wiring

---

## Layer 2: Integration Tests (handler pipeline)

**Location:** `tests/handlers.integration.test.ts`

Integration tests exercise the full handler pipeline with mocked external I/O:
- `DriverFactory` → returns a mock `AutomationDriver`
- `proxymanWrapper` → returns synthetic HAR data
- `child_process.execFile` → returns canned simctl output

**Scenarios covered:**
- Full lifecycle: `startRecording` → `executeUIAction` → `stopAndCompile`
- Hierarchy capture with mock driver
- `runTest` with pass/fail outcomes
- Error paths: missing sessions, failed actions, no simulator

---

## Layer 3: Smoke Tests (real simulator)

**Location:** `tests/smoke/`

Curated Maestro YAML scripts that run against a real booted simulator via the `run_test` handler. These are the tool "testing itself."

| Test | What it validates |
|---|---|
| `hierarchy-smoke.yaml` | App launches, login screen elements visible |
| `login-and-navigate-smoke.yaml` | Full login → tab nav → detail → back flow |
| `stub-replay-smoke.yaml` | WireMock stub server lifecycle during test run |

**Runner:** `tests/smoke/run-smoke.ts` — orchestrates tests, reports results, writes JSON report.

**Requirements:**
- Booted iOS simulator
- Doombot app installed (`com.doombot.ios`)
- Maestro CLI in PATH

---

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

## Bug Reporting

When client LLMs encounter issues, use the [Bug Report Template](./BUG_REPORT_TEMPLATE.md) to provide structured diagnostic information including session IDs, polling diagnostics, timeline data, and stderr logs.

