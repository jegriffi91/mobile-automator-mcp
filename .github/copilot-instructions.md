# Copilot Instructions for mobile-automator-mcp

This MCP server orchestrates **Maestro** (UI automation) and **Proxyman** (network interception) to generate self-contained mobile test scripts.

## Tool Lifecycle

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
- **Selector priority**: `id` > `accessibilityLabel` > `text` > `bounds`
- Always prefer `id` or `accessibilityLabel` over `text` for stable selectors
- Avoid selectors on transient UI (shimmer placeholders, loading spinners)

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

## Architecture Quick Reference

| Module | Purpose |
|---|---|
| `src/session/` | SQLite session store, touch inferrer, track event extractor |
| `src/maestro/` | Maestro CLI wrapper, hierarchy parser, differ |
| `src/proxyman/` | Proxyman CLI wrapper, SDUI validator |
| `src/synthesis/` | Correlator, YAML generator, stub writer, selector quality |
| `src/segments/` | Fingerprinting, registry for flow deduplication |
| `src/wiremock/` | In-process stub server, test runner |
| `src/schemas.ts` | Zod schemas — single source of truth for all tool I/O |
| `src/types.ts` | Domain model interfaces (internal use only) |

## Code Conventions

- **ESM**: All imports use `.js` extensions (`import { X } from './foo.js'`)
- **Zod**: Never duplicate types — derive via `z.infer<>`
- **Tests**: Co-located as `*.test.ts` next to the module
- **No `any`**: ESLint rule `@typescript-eslint/no-explicit-any` is set to warn
- **Prettier**: Single quotes, 2-space indent, trailing commas, 100 char width
