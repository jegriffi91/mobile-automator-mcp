# Copilot Instructions for mobile-automator-mcp

This MCP server orchestrates **Maestro** (UI automation) and **Proxyman** (network interception) to generate self-contained mobile test scripts.

## Tool Selection Guide

Pick the **least-turns** tool for the job. The agent's default instinct is to record-and-replay; that path costs 8–15 turns when 1 will do.

| Goal | Tool | Turns |
|---|---|---|
| Validate a user journey with mocked backend state | `run_feature_test` (inline spec) | **1** |
| Run an existing YAML test | `run_test` | 1 |
| Navigate to a screen via a known flow | `run_flow` | 1 |
| Repeat the same scenario across N mock variants | Bash loop via HTTP bridge — see [generate_mcp_curls](skills/generate_mcp_curls/SKILL.md) and [mock-variant-testing](skills/mock-variant-testing/SKILL.md) | 1–2 |
| Quick visual check | `take_screenshot` | 1 |
| Record a brand-new test from scratch | `start_recording_session` → `execute_ui_action` → `stop_and_compile_test` | 5–15 |
| Exploratory debugging | `start_recording_session` + `execute_ui_action` | varies |

**Rule of thumb:** if the spec is known up-front, use a composite tool (`run_feature_test`, `run_test`, `run_flow`). Reserve recording for *creating* tests, not *running* them.

## Composite & Batch Testing

### `run_feature_test` — one call, full lifecycle

Replaces 8–15 manual tool calls with a single declarative spec. Runs setup flows → installs mocks → executes actions → runs network assertions → tears down.

```yaml
run_feature_test:
  spec:
    name: "Verify OP2_INTERCEPT routing"
    appBundleId: "com.example.App"
    setup:
      - flow: "sign-in"
        params: { USERNAME: "test@example.com", PASSWORD: "pass" }
    mocks:
      - matcher: { graphqlQueryName: "CustomerStatusQuery" }
        responseTransform:
          jsonPatch:
            - op: replace
              path: /data/customerStatusV3/loginStatus
              value: "OP2_INTERCEPT"
    actions:
      - assertVisible: { text: "Identity verification" }
    assertions:
      - type: on_screen
        expectedCalls:
          - { operationMatches: "CustomerStatusQuery" }
```

**Use when:** validating a user journey with controlled backend state. Network assertions live inside the spec, so you don't need a separate `verify_network_*` call.
**Avoid when:** you only need a screenshot — call `take_screenshot` directly.

### Mock variant sweeps (3+ configurations)

When you need to test the same flow against N different mocked values, **do not loop in LLM turns**. Each variant in the LLM loop is ~5–7 tool calls; for 6 variants that's 30–42 turns.

Instead:
1. Create a reusable YAML flow for navigation (e.g. `flows/sign-in.yaml`)
2. Use the [generate_mcp_curls](skills/generate_mcp_curls/SKILL.md) skill to script the loop in bash
3. Run the script once — zero per-variant LLM cost

See [mock-variant-testing](skills/mock-variant-testing/SKILL.md) for the full pattern with decision tree and ready-to-paste bash.

### Decision heuristic

- 1 test, 1 config → `run_feature_test` or `run_test`
- 1 test, N configs (N ≥ 3) → bash loop via HTTP bridge
- Need screenshots only → `set_mock_response` + `run_flow` + `take_screenshot`
- Exploring/debugging → `start_recording_session` + `execute_ui_action`

## Skill index

These skill files are loaded on demand. Reach for them by name when the situation matches.

| Skill | When to load |
|---|---|
| [generate_mcp_curls](skills/generate_mcp_curls/SKILL.md) | You need to call any MCA tool via cURL (HTTP bridge) — script loops, CI steps, or when the MCP client is blocked |
| [mock-variant-testing](skills/mock-variant-testing/SKILL.md) | Validating a flow across multiple mocked API response values |
| [ios-automation-gotchas](skills/ios-automation-gotchas/SKILL.md) | Writing or debugging Maestro YAML for iOS — `clearState`, accessibility IDs, `extendedWaitUntil` timeouts, tab views |

## Tool Lifecycle (record → replay)

When you genuinely need a new test from scratch:

1. **Record**: `start_recording_session` → `execute_ui_action` (repeated) → `stop_and_compile_test`
2. **Replay**: `run_test` with the generated YAML + optional WireMock stubs

> ⚠️ `run_test` is **static replay only** — it does NOT connect to live Proxyman or record new traffic.

## Common Patterns

### Starting a Session
```
start_recording_session(appBundleId: "com.example.App", platform: "ios")
```
- Use `captureMode: "polling"` for user-led recording (passive touch detection)
- Use `trackEventPaths: ["/__track"]` when the app has `AutomatorTracker` instrumentation

### Executing Actions
- **Selector priority**: `id` > `accessibilityLabel` > `text` > `bounds` > `point`
- Always prefer `id` or `accessibilityLabel` over `text` for stable selectors
- Avoid selectors on transient UI (shimmer placeholders, loading spinners)
- The hierarchy now reports `bounds: { x, y, width, height }` per node — use it to compute `point` selectors when nothing more stable is available

### Compiling Tests
```
stop_and_compile_test(sessionId: "...", mockingConfig: { mode: "full" })
```
- Use `mockingConfig.mode: "exclude"` with routes to skip analytics endpoints

## Known Pitfalls

### 1. Hierarchy capture requires device_id
When using session-scoped hierarchy capture, `device_id` must be passed to the hierarchy tool. The session stores this automatically from `validateSimulator()`.

### 2. WireMock stubs directory structure
The `stubsDir` parameter must point to the WireMock **root** directory containing `mappings/` and `__files/` subdirectories — not a nested path like `mappings/mappings/`.

### 3. Secure text fields
Synthesized YAML uses `${SECURE_INPUT}` env-var placeholders for password fields. Pass real credentials at runtime:
```
run_test(yamlPath: "test.yaml", env: { "SECURE_INPUT": "actual-password" })
```

### 4. Selector quality warnings
The compiler warns on fragile selectors:
- **Short/numeric text** (`"3"`, `"OK"`) — too ambiguous to match reliably
- **Transient IDs** (`shimmer-placeholder-1`) — only exist during loading
- **Text-only selectors** — prefer accessibility IDs for stability
- **Bounds-only selectors** — break on different screen sizes

### 5. Environment variables for run_test
Use the `env` parameter to pass variables to Maestro:
```
run_test(yamlPath: "test.yaml", env: { "APP_ID": "com.example.App" })
```

### 6. Standalone vs session-scoped mocks
`set_mock_response` with no `sessionId` installs a **standalone** mock that persists across flow runs and screenshots — required when you need a mock to survive between `run_flow` and `take_screenshot`. With `sessionId`, the mock auto-cleans on `stop_and_compile_test`.

## Architecture Quick Reference

| Module | Purpose |
|---|---|
| `src/session/` | SQLite session store, touch inferrer, track event extractor |
| `src/maestro/` | Maestro CLI wrapper + `maestro mcp` daemon, hierarchy parser, differ |
| `src/proxyman/` | Proxyman CLI wrapper, SDUI validator |
| `src/featureTest/` | `run_feature_test` runner — composite spec lifecycle |
| `src/synthesis/` | Correlator, YAML generator, stub writer, selector quality |
| `src/segments/` | Fingerprinting, registry for flow deduplication |
| `src/wiremock/` | In-process stub server, test runner |
| `src/tasks/` | TaskRegistry for long-running async work (build, unit tests, recording) |
| `src/schemas.ts` | Zod schemas — single source of truth for all tool I/O |
| `src/types.ts` | Domain model interfaces (internal use only) |

## Code Conventions

- **ESM**: All imports use `.js` extensions (`import { X } from './foo.js'`)
- **Zod**: Never duplicate types — derive via `z.infer<>`
- **Tests**: Co-located as `*.test.ts` next to the module
- **No `any`**: ESLint rule `@typescript-eslint/no-explicit-any` is set to warn
- **Prettier**: Single quotes, 2-space indent, trailing commas, 100 char width
