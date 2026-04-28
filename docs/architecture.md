# System Architecture

Reference document for AI agents and human contributors. Follow the link from the root [AGENTS.md](../AGENTS.md) when you need to understand system design before making changes.

---

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MCP Client (AI Agent)                        │
└────────────┬──────────────────────────────────────┬─────────────────┘
             │  stdio (JSON-RPC)                    │
┌────────────▼──────────────────────────────────────▼─────────────────┐
│  index.ts — MCP Server Bootstrap                                    │
│  Registers 8 tools via McpServer.registerTool()                     │
└────────────┬────────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────────────┐
│  handlers.ts — Tool Handler Implementations                         │
│  Orchestrates submodules; each handler maps 1:1 to an MCP tool      │
└──┬──────────┬──────────────┬───────────────┬──────────┬─────────────┘
   │          │              │               │          │
   ▼          ▼              ▼               ▼          ▼
┌─────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐ ┌────────────┐
│session/ │ │ maestro/   │ │ proxyman/  │ │synthesis/│ │segments/   │ │profiling/  │
│         │ │            │ │            │ │          │ │wiremock/   │ │            │
│database │ │ wrapper    │ │ wrapper    │ │correlator│ │            │ │ios-profiler│
│manager  │ │ daemon     │ │ validator  │ │generator │ │fingerprint │ │android-    │
│touch-   │ │ hierarchy  │ │            │ │stub-     │ │registry    │ │ profiler   │
│inferrer │ │ hier-differ│ │            │ │writer    │ │stub-server │ │metric-     │
│         │ │            │ │            │ │          │ │            │ │ parser     │
└─────────┘ └────────────┘ └────────────┘ └──────────┘ └────────────┘ └────────────┘
```

---

## Recording Session Lifecycle

1. **`start_recording_session`** — Creates a session row in SQLite, snapshots the Proxyman traffic count as `proxymanBaseline`, stores session metadata.
2. **`execute_ui_action`** (repeated) — Dispatches a UI action via Maestro CLI, logs the `UIInteraction` with timestamp to the session database.
3. **`get_ui_hierarchy`** (optional) — Dumps the current accessibility tree from the simulator via Maestro, returns normalized `UIHierarchyNode` tree.
4. **`get_network_logs`** (optional) — Exports current Proxyman traffic (scoped by baseline), filters by domain/path, returns `NetworkEvent[]`.
5. **`stop_and_compile_test`** — Finalizes the session:
   - Exports only the Proxyman entries captured **after** the baseline (session-scoped HAR).
   - Runs the **Correlator** to match UI interactions → network requests via a sliding time window.
   - Runs the **YamlGenerator** to produce a Maestro YAML test script with network context comments.
   - Runs the **StubWriter** to produce WireMock `mappings/` + `__files/` for network replay.
   - Supports **selective mocking** (`full`, `include`, `exclude` modes).

---

## Module Contracts

### `src/schemas.ts` — Single Source of Truth

All MCP tool input and output shapes are defined as Zod schemas here. TypeScript types are derived via `z.infer<>`. **Never** create parallel type definitions — always import from `schemas.ts`.

### `src/types.ts` — Domain Models

Internal business entities (`Session`, `UIInteraction`, `UIElement`, `UIHierarchyNode`, `NetworkEvent`). These are used inside submodules and the database layer, NOT as tool I/O shapes.

### `src/handlers.ts` — Orchestration Layer

Each exported handler function accepts a typed input (from Zod) and returns a typed output. Handlers orchestrate submodules but contain no business logic themselves.

### `src/index.ts` — Server Wiring

Registers all 8 tools with the MCP SDK. Should only change when adding/removing tools or modifying tool metadata.

---

## Cross-Module Dependency Rules

```
handlers.ts ──imports──▶ session/, maestro/, proxyman/, synthesis/, segments/, wiremock/, profiling/
synthesis/  ──imports──▶ types.ts (for UIInteraction, NetworkEvent)
session/    ──imports──▶ types.ts (for Session, UIInteraction, NetworkEvent)
maestro/    ──imports──▶ types.ts (for UIHierarchyNode, UIElement)
proxyman/   ──imports──▶ types.ts (for NetworkEvent)
segments/   ──imports──▶ types.ts (for CorrelatedStep)
profiling/  ──imports──▶ types.ts (for MobilePlatform)
wiremock/   ──imports──▶ (standalone — no cross-module deps)
```

**Prohibited imports:**
- Submodules must NOT import from `handlers.ts` or `index.ts` (no circular deps).
- `session/` must NOT import from `maestro/`, `proxyman/`, or `synthesis/`.
- `synthesis/` must NOT import from `maestro/` or `proxyman/` (it works on already-fetched data).
- No submodule should import from another submodule's internal files — use barrel exports (`index.ts`) only.

---

## Concurrency Model

The server supports **concurrent recording sessions** via per-session domain filtering. When `start_recording_session` is called with `filterDomains`, the domain list is:

1. **Stored on the `Session` model** (persisted as JSON in SQLite).
2. **Used for baseline snapshot** — only counts matching Proxyman entries, so each session's baseline is independent.
3. **Used for scoped HAR export** — `exportHarScoped()` filters by domain before slicing by baseline, preventing cross-session traffic leakage.
4. **Inherited by downstream tools** — `get_network_logs` and `verify_sdui_payload` fall back to the session's `filterDomains` when not explicitly overridden.

### Port-Isolation Pattern

For concurrent CI runners on a Mac Studio, each runner targets a different test server port:

```
Runner 1: filterDomains=["localhost.proxyman.io:3031"] → test-server :3031
Runner 2: filterDomains=["localhost.proxyman.io:3032"] → test-server :3032
```

Since Proxyman captures the full URL including port, domain filtering effectively isolates traffic per session.

---

## Recording sessions and Maestro flow execution

When `MCA_FLOW_PAUSE_RESUME=on` and a recording session is active, calling
`run_test`/`run_flow` pauses the session's hierarchy poller, tears down the
daemon driver to release port 7001, runs the flow via the CLI, then
restarts the daemon and resumes polling. Synthetic `flow_boundary` markers
in `pollRecords` mark the gap; the flow's stdout is captured on
`Session.flowExecutions[]` for compile-time consumption.

When the flag is unset/`off` (default), the legacy `assertNoActiveSessions`
guard throws — current behavior preserved.

See `docs/phase-4-design.md` for strategy comparison and decision context.

### Compile-time event weaving (Phase 5)

Phase 4 left the `flow_boundary` interval opaque — the timeline knew *when*
a flow ran but not *what* it did. Phase 5 closes that gap at compile time:

- `executeFlowWithPause` allocates a per-flow `--debug-output` directory
  under `os.tmpdir()`. Maestro writes `commands-<flowName>.json` artifacts
  there — the only stable, structured per-step source Maestro emits
  (`--format` only supports JUNIT/HTML; no JSON stdout exists).
- The directory path, source flow YAML path, and a `cancelled` flag are
  carried on `FlowExecutionRecord` alongside the captured stdout.
- `parseMaestroDebugOutput` (`src/synthesis/flow-weaver.ts`) reads and
  normalises those artifacts into `FlowStep[]`. It is defensive by design:
  missing dirs, malformed JSON, or unknown command shapes all degrade to
  empty/unknown rather than throwing — a bad artifact must not fail the
  compile.
- `weaveFlowExecutions` is a pure function that pairs each `flow_start` /
  `flow_end` boundary with a matching `FlowExecutionRecord` and the parsed
  steps, emitting `WovenFlowExecution[]` and `RunFlowYamlBlock[]`. It also
  strips the boundary records from the returned `pollRecords` stream — the
  woven entries take ownership of that range.
- `YamlGenerator.toYaml` emits `- runFlow: <relativePath>` directives
  (with summary comments) at the right chronological position rather than
  inlining the steps. Re-using the source YAML preserves intent.
- `TimelineBuilder` renders woven entries as `type: 'flow'` timeline
  entries, each carrying its parsed `FlowStep[]` for post-hoc debugging.
- `handleStopAndCompile` orchestrates the above and surfaces a per-flow
  summary on `StopAndCompileOutput.flowExecutions`.

See `docs/phase-4-design.md` for the original design discussion.

---

## Recording vs. Replay

> **Important:** `run_test` is a **replay-only** tool. It executes a static Maestro YAML script against a booted simulator, optionally serving pre-recorded WireMock stubs. It does **not** connect to live Proxyman or capture new network traffic during execution.
>
> To record new test scripts, use the full recording lifecycle (`start_recording_session` → interactions → `stop_and_compile_test`). To replay them, use `run_test` with the generated YAML and optional stubs directory.

---

## Async Execution: TaskRegistry Migration Pattern

Long-running operations (`build_app`, `run_test`, `run_flow`) can exceed the MCP transport timeout (~5min). To avoid this and to enable mid-flight cancellation, these handlers route through `TaskRegistry` (Phase 2 introduced the registry for `build_app`; Phase 5 extends it to flows). Each long-running tool now has two surfaces:

- **Sync** (`run_test`, `run_flow`, `build_app`): delegate to `taskRegistry.run`, await the terminal state, and re-throw on failure/cancellation. Schemas are unchanged — purely a refactor under the hood.
- **Async** (`start_test`, `start_flow`, `start_build`): call `taskRegistry.start` and return a `taskId` immediately. Agents poll via `poll_task_status`, fetch the typed payload via `get_task_result` (which uses a discriminated union keyed by `kind`), and abort via `cancel_task`.

`cancel_task` propagates an `AbortSignal` through the runner closure into `MaestroWrapper.runTest` (Phase 4 plumbing), which translates it into SIGTERM on the Maestro CLI subprocess. When the cancelled flow had paused an active recording session, the resume cleanup runs automatically via `runHandler`'s LIFO cleanup stack — so cancellation never strands a session in `paused` state. See `phase-4-design.md` for the recording↔Maestro decoupling and signal-propagation details.

---

## Key Technical Decisions

| Decision | Rationale |
|---|---|
| **sql.js** (not better-sqlite3) | Pure JS, no native compilation — works in any VM without build tools |
| **child_process for CLIs** | Maestro and Proxyman are external binaries; wrapping via `execFile` is the simplest integration |
| **Sliding time window correlation** | UI actions trigger network requests with variable latency; a configurable window (default 5s) catches async effects |
| **Zod as single source of truth** | Compile-time types + runtime validation from one definition; prevents schema drift |
| **Co-located tests** | `*.test.ts` next to the module — easier discovery, no mirrored `__tests__` tree |
| **ESM throughout** | `"type": "module"` in package.json; all imports use `.js` extensions per Node16 module resolution |
