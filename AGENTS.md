# AGENTS.md — Global Context

## Project Overview

**mobile-automator-mcp** is a TypeScript MCP (Model Context Protocol) server that orchestrates [Maestro](https://maestro.mobile.dev/) UI automation and [Proxyman](https://proxyman.io/) network interception to generate self-contained mobile test scripts — Maestro YAML + WireMock stubs.

- **Runtime:** Node.js ≥ 20, ESM (`"type": "module"`)
- **Language:** TypeScript 5, strict mode
- **Schema layer:** [Zod](https://github.com/colinhacks/zod) — single source of truth for all tool I/O shapes
- **Persistence:** sql.js (in-process SQLite)
- **Transport:** stdio (MCP SDK)

## Global Boundaries & Constraints

✅ **Always do:**
- Run `npm test` and fix any failing tests before presenting a Plan or Pull Request.
- Run `npm run build` to verify TypeScript compilation succeeds.
- Derive tool input/output TypeScript types from Zod schemas in `src/schemas.ts` — never duplicate them manually.
- Use domain model interfaces from `src/types.ts` for internal business logic only.
- Co-locate test files as `*.test.ts` next to the module they test.
- Follow the existing Prettier config (`.prettierrc`): single quotes, 2-space tabs, trailing commas, 100 char print width.

🚫 **Never do:**
- Modify `.github/workflows/` or CI configuration.
- Commit hardcoded file paths, secrets, or API keys.
- Use `any` in TypeScript — the ESLint rule `@typescript-eslint/no-explicit-any` is set to `warn`.
- Bypass Zod validation by casting or using raw `JSON.parse` without schema parsing.
- Import across submodule boundaries incorrectly (see [Architecture](./docs/architecture.md)).
- Create throwaway scripts in the project root.
- **Hallucinate properties on Maestro commands.** The `scroll` command does NOT accept `from:` or `to:` (it takes no arguments). The `swipe` command ONLY accepts `start`, `end`, `direction`, and `duration`.
- Avoid executing or editing code without auto-allow if it's outside the `tests/` directory (the `tests/` directory is whitelisted for safe autonomous changes).

⚠️ **Ask first:**
- Before adding new npm dependencies.
- Before changing the MCP tool contract (input/output schemas).
- Before modifying the SQLite database schema.

## Package Routing

Depending on your assigned task, refer to the **nearest** `AGENTS.md` for module-specific rules:

| Task Area | AGENTS.md Location | Covers |
|---|---|---|
| Session lifecycle, database | [`src/session/AGENTS.md`](./src/session/AGENTS.md) | sql.js schema, CRUD, status transitions |
| UI automation, hierarchy | [`src/maestro/AGENTS.md`](./src/maestro/AGENTS.md) | Maestro CLI wrapper, XML hierarchy parser |
| Network capture, validation | [`src/proxyman/AGENTS.md`](./src/proxyman/AGENTS.md) | Proxyman CLI wrapper, SDUI payload validator |
| Test synthesis, correlation | [`src/synthesis/AGENTS.md`](./src/synthesis/AGENTS.md) | Correlator, YAML generator, WireMock stub writer |
| Segment registry, dedup | [`src/segments/AGENTS.md`](./src/segments/AGENTS.md) | Fingerprinting, registry CRUD, segment matching |
| Test orchestration, stubs | [`src/wiremock/AGENTS.md`](./src/wiremock/AGENTS.md) | In-process WireMock stub server, run-test flow |
| Performance profiling | [`src/profiling/AGENTS.md`](./src/profiling/AGENTS.md) | xctrace (iOS), dumpsys (Android), metric parsing |
| Top-level server wiring | This file + `src/index.ts`, `src/handlers.ts`, `src/schemas.ts` | |

For deep-dive context, follow these links:
- **System Design:** [Architecture Docs](./docs/architecture.md)
- **Testing Rules:** [Testing Strategy](./docs/testing-strategy.md)
- **Proxyman Setup:** [Proxyman Setup](./docs/proxyman-setup.md)

## Executable Verification Commands

Run these exact commands in your VM terminal to verify your work:

- Install dependencies: `npm install`
- Compile TypeScript: `npm run build`
- Run linter: `npm run lint`
- Format code: `npm run format`
- Run unit tests: `npm test`
- Run tests in watch mode: `npm run test:watch`

## Concurrent Sessions (Port-Isolation)

When running multiple recording sessions simultaneously (e.g., from parallel CI runners), use the `filterDomains` parameter on `start_recording_session` to isolate each session's Proxyman traffic by server port:

```
Runner 1 → start_recording_session(filterDomains: ["localhost.proxyman.io:3031"])
Runner 2 → start_recording_session(filterDomains: ["localhost.proxyman.io:3032"])
Runner 3 → start_recording_session(filterDomains: ["localhost.proxyman.io:3033"])
```

The domain filter is stored on the session and automatically applied to:
- Baseline snapshot (counts only matching traffic)
- Scoped HAR export (slices only matching entries)
- `get_network_logs` (falls back to session filter if not overridden)
- `verify_sdui_payload` (falls back to session filter if not overridden)

This parameter is **optional** — omitting it preserves the existing all-traffic behavior for single-session usage.

## PR Pre-Flight Checklist

Before finalizing your branch, verify each item:

- [ ] `npm run build` exits with code 0 (no compilation errors)
- [ ] `npm test` exits with code 0 (all tests pass)
- [ ] `npm run lint` exits with code 0 (no lint violations)
- [ ] New pure-logic modules include co-located `*.test.ts` files
- [ ] Zod schemas in `src/schemas.ts` are updated if tool I/O changed
- [ ] No `any` types introduced
- [ ] No hardcoded paths or secrets
- [ ] Commit messages are clear and descriptive
