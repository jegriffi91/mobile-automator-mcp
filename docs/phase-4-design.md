# Phase 4 Design Doc — Decoupling Recording Sessions from Maestro Flow Execution

> **Status:** Open for team review. No code yet. The team's first job is to pick a strategy from §4–§6 and answer the questions in §9.

## 1. TL;DR

Today, calling `run_test`/`run_flow` while a recording session is active is hard-blocked by `assertNoActiveSessions`, because `maestro test` spawns its own XCTRunner on port 7001 and clobbers whatever driver the recording session is using. Phase 4 must replace that hard block with one of three architectural strategies: **(1) share a single port-7001 driver** between the polling loop and Maestro flows, **(2) pause polling around flow execution** and tolerate a timeline gap, or **(3) treat flow execution as a session boundary**. The team's first decision is which strategy to commit to; the rest of the document gives them what they need to pick.

## 2. Background — current architecture

**Driver abstraction** (`src/maestro/driver.ts:28-75`). `AutomationDriver` exposes hierarchy reads, action execution, and `runTest()`. Two implementations:

- `MaestroCliDriver` — every call cold-spawns the Maestro CLI (slow, simple, no port ownership).
- `MaestroDaemonDriver` (`src/maestro/daemon-driver.ts:24-198`) — keeps a `maestro mcp` JSON-RPC daemon alive for fast hierarchy reads (`daemon.ts:112-129`). **Crucially, the daemon only exposes `inspect_view_hierarchy`** (`daemon.ts:117-119`) — actions and `runTest` fall through to `MaestroWrapper`'s cold CLI (`daemon-driver.ts:105-121`).

**Recording session lifecycle** (`src/handlers.ts:212-329`).

1. `DriverFactory.create()` returns a `MaestroDaemonDriver`.
2. `driver.ensureCleanDriverState()` probes port 7001; if no driver is present, it uninstalls + waits the TIME_WAIT cooldown (`wrapper.ts:316-359`).
3. `driver.start(deviceId)` boots the `maestro mcp` daemon.
4. `sessionManager.setActiveDriver(sessionId, driver)` registers the driver.
5. `sessionManager.startPolling(...)` instantiates a `TouchInferrer` (`session/manager.ts:201-220`) that calls `driver.createTreeReader()` — the reader proxies into `daemon.getHierarchyRaw()` (`daemon-driver.ts:149-167`).

**The polling loop** (`src/session/touch-inferrer.ts:277-310`). `setInterval` calls the tree reader every `pollingIntervalMs` (default 2000ms; configurable per session). Each call is a JSON-RPC `tools/call inspect_view_hierarchy` to the daemon, which under the hood drives the XCTRunner on port 7001.

**`run_test` / `run_flow`** (`src/handlers.ts:1542-1666`, `1881-1914`).

1. `assertNoActiveSessions(...)` — fail fast if any recording session has a registered driver (`testing/driver-conflict.ts:22-37`).
2. `DriverFactory.createCliOnly(...)` — fresh CLI driver, no daemon.
3. `driver.ensureCleanDriverState()` — probes 7001, uninstalls if needed.
4. `driver.runTest()` → `MaestroWrapper.runTest()` → `execFile('maestro', ['test', ...])` (`wrapper.ts:508-538`).

## 3. The conflict

Both ends want exclusive control of port 7001.

- The **`maestro mcp` daemon** that backs recording sessions binds 7001 the first time it issues `inspect_view_hierarchy`, and the bound XCTRunner stays installed across daemon calls so the JVM-warm hierarchy path stays sub-second.
- **`maestro test`** unconditionally re-spawns its own XCTRunner on 7001 at the start of each test run. There is no flag to "attach to an existing driver"; this is a Maestro-side assumption.

When a flow runs while a session's daemon is alive, the daemon's next `inspect_view_hierarchy` call lands on a wrong (or torn-down) XCTRunner instance and either hangs, returns garbage, or — in the post-mortem case — crashes the polling loop. Symmetrically, the running test sees its own XCTRunner replaced mid-flow if the daemon's heartbeat re-installs.

The Phase 1 mitigation in `driver-conflict.ts` does not solve this; it just makes the conflict an explicit error.

## 4. Strategy 1 — Share the driver

**Description.** Have one driver instance bound to port 7001 for the lifetime of the recording session. The polling loop and `run_test` both go through it. Flow execution becomes a daemon command (rather than a fresh `maestro test` subprocess). A mutex inside the driver serializes hierarchy reads and flow runs so they never overlap on the underlying XCTRunner.

**Happy path.**

```
TouchInferrer ──poll──▶ ┐
                        ├──▶ DriverMutex ──▶ MaestroDaemon (port 7001 owner)
run_test handler ───────▶ ┘                       │
                                                  └─ XCTRunner (XCUITest)
```

**Pros.**
- Zero polling gap; the timeline retains hierarchy snapshots before and after the flow as one continuous sequence.
- One owner of port 7001 — no install/uninstall churn between flow runs (this is what `ensureCleanDriverState` had to manage).
- Simple guarantee for callers: anything that talks to the simulator goes through one queue; conflicts vanish at the API level, not just the policy level.

**Cons.**
- **Blocked upstream.** The current `maestro mcp` daemon only exposes `inspect_view_hierarchy` (`daemon.ts:117-119`). It does **not** expose `run_test` or any flow-execution tool. We cannot multiplex flows through the daemon today.
- Even if Maestro added that tool, hierarchy polling would still have to pause for the duration of the flow because the daemon serializes one operation at a time on the JVM. The "no gap" pro is partially illusory unless Maestro exposes streaming hierarchy during flow execution.
- We'd own a Maestro upstream dependency on our critical path.

**Risks.** If Maestro accepts the feature request but ships it slowly or behind a flag, Phase 4 stalls. If we work around with a homegrown shim (e.g. parsing `maestro test`'s log stream for hierarchy events), we own a brittle screen-scraping integration that breaks on every Maestro release.

**Size.** Large — assuming upstream support exists. Without upstream support, **infeasible**. Recommendation: rule this out for Phase 4 unless the team wants to commit to filing and waiting on a Maestro RFE.

**Upstream dependency.** Requires `maestro mcp` to expose flow execution as a tool call (something like `tools/call run_flow`). Confirm against current Maestro docs before further consideration.

## 5. Strategy 2 — Pause polling around flows

**Description.** When `run_test`/`run_flow` is invoked during an active session, look up the session's driver, pause the `TouchInferrer`, stop the `MaestroDaemonDriver` (releasing port 7001 cleanly), run `maestro test` via the CLI, then restart the daemon and resume polling. Annotate the timeline with a "flow boundary" marker so downstream consumers can see the gap.

**Happy path.**

```
run_test invoked
   │
   ▼
sessionManager.pauseSession(sessionId)
   │
   ├── inferrer.pause()          ← stops setInterval
   ├── driver.stop()             ← daemon dies, port 7001 freed
   ├── timeline.markGapStart()
   │
   ▼
maestro test ... (spawns own XCTRunner on 7001)
   │
   ▼
sessionManager.resumeSession(sessionId)
   ├── timeline.markGapEnd()
   ├── driver.start(deviceId)    ← daemon respawns
   └── inferrer.resume()         ← polling restarts with fresh baseline
```

**Pros.**
- Works **today** with no Maestro changes.
- Semantically honest: the user knows the recording can't observe state while a scripted flow runs, because the scripted flow is the source of truth for that window.
- Reuses existing primitives: `daemon-driver.ts` already has start/stop, `touch-inferrer.ts:312-322` has `stop()`, the daemon respawns cleanly (`daemon-driver.ts:43-62`).

**Cons.**
- A 30-90s gap in the timeline during a typical flow. The recording session's `pollRecords` will have a hole.
- Daemon cold-start adds ~5s to flow completion (JVM warmup on respawn — `daemon.ts:103-105`). Tolerable, but visible.
- Failure modes proliferate: daemon respawn failure leaves the session wedged with no driver. Need a watchdog and a clear "session is now read-only / aborted" error.

**Risks.** If `maestro test` hangs and we never reach the resume step, the session is stuck without a driver and `execute_ui_action` starts failing silently. Mitigation: tie the resume into `runHandler`'s cleanup stack and add a watchdog that aborts the session if resume fails.

**Size.** Medium. Most of the work is plumbing pause/resume through `SessionManager`, `TouchInferrer`, and `MaestroDaemonDriver`, plus the timeline marker. No upstream dependencies.

**Upstream dependency.** None.

## 6. Strategy 3 — Session hand-off

**Description.** `run_test`/`run_flow` ends the active recording session (full `stop_and_compile_test` or a lighter shutdown), runs the flow as it does today, and optionally starts a fresh recording session afterward. The recording session and the flow live in disjoint timelines.

**Happy path.**

```
run_test invoked while session S is active
   │
   ▼
handleStopAndCompile(S)        ← or new "stop without compile" handler
   │
   ▼
maestro test ...
   │
   ▼
[optional] handleStartRecording(...)  → new session S'
```

**Pros.**
- Smallest implementation footprint — mostly composes existing handlers.
- Cleanest mental model for agents: "if you want to run a flow, you're between sessions."
- No driver lifecycle complexity, no concurrency.

**Cons.**
- Loses session continuity. If a feature flow expects a 5-minute interactive recording with one programmatic "log in" flow in the middle, that becomes three artifacts (session A, flow run, session B) the user has to stitch together.
- Compile-on-stop side effects (segment registry, fixtures, manifest) fire even when the user just wanted a flow boundary, not an artifact. We'd need a "soft stop" path — adding new public surface area.
- Network capture (Proxyman baseline) restarts each new session; cumulative session metrics are not comparable.

**Risks.** Agent confusion. The MCP contract today implies sessions are long-lived; making them implicitly end on flow execution invalidates assumptions in the system prompt and in any agent prompts written against the current behavior.

**Size.** Small for the basic version (compose existing handlers). Medium if we add a "soft stop without compile" path.

**Upstream dependency.** None.

## 7. Cross-cutting concerns

| Concern | Strategy 1 | Strategy 2 | Strategy 3 |
|---|---|---|---|
| **Timeline gap during flow** | Theoretically none; in practice still a gap | Real gap, must annotate (`PollRecord` with `result: 'flow_boundary'` recommended) | N/A — sessions don't span the flow |
| **Network capture during flow** | Proxyman keeps capturing (it's session-independent) | Proxyman keeps capturing — this is one reason the gap is tolerable | Proxyman session ends; restart loses correlation |
| **Flow hang / failure recovery** | Mutex deadlock risk; need timeout + force-release | **Critical** — resume must run on every error path. Recommend wrapping in `runHandler` cleanup with a watchdog that marks session aborted if resume fails after N seconds | Cleanest — flow failure doesn't affect session state because there is no session |
| **`cancel_task` mid-flow** | Cancel through the mutex; polling resumes after | Cancel kills the `maestro test` subprocess, then the cleanup runs resume. Recommend: leave the recording session intact and resume polling | Flow cancel doesn't affect post-flow session start (which hasn't happened yet) |
| **CLI vs daemon for flows** | Requires daemon-side flow support | CLI as today (`wrapper.ts:508-538`) | CLI as today |
| **`assertNoActiveSessions` fate** | Removed — replaced by mutex | Replaced by "pause if active" coordination, no error to caller | Removed — replaced by automatic stop |
| **Backwards compatibility** | Tools currently relying on the explicit error message break (low risk; only agents reading errors) | Same | Same; plus session lifecycle changes — agents that expect their session ID to remain valid after a flow will break |

**Recommended defaults for Strategy 2 specifics** (only if the team picks 2):
- Timeline gap annotation: synthetic `PollRecord` entries with `result: 'flow_boundary'` and `inferredTarget: <flow name>` at gap start and end. Not silent.
- Resume failure: mark the session aborted (existing `markAborted` path at `handlers.ts:248`) and surface the error to the `run_test` caller — they should know the session is gone.
- Cancellation: `cancel_task` on a flow-running task should kill the flow subprocess and trigger the resume path; the session survives.

## 8. Sequencing — what's actually in Phase 4

Phase 4 is at minimum three sub-tasks:

1. **The decoupling itself** — picked strategy. **Land first**, behind a feature flag if the team wants A/B (recommended for Strategy 2).
2. **Removing or relaxing `assertNoActiveSessions`** — should ship in the *same PR* as task 1. The guard exists precisely because the conflict exists; removing it before the fix lands re-introduces the post-mortem bug. Removing it after leaves dead-code drift.
3. **Updating tool descriptions and docs** — `getting-started.md`, `architecture.md`, MCP tool description strings for `run_test`/`run_flow`/`start_recording_session`. Land separately, after the behavior is verified in practice. The docs describe a contract; the contract should be observed working before it's documented.

Recommended order: **(1+2 together) → soak in real usage → (3)**.

## 9. Decision points for the team

1. **Strategy 1 vs 2 vs 3.** Strategy 1 is realistically blocked on Maestro upstream support; if the team wants 1, the first action is to file the RFE and decide whether to ship 2 as an interim. Default-recommended for Phase 4: 2, with the option to migrate to 1 later if upstream lands. Strategy 3 is acceptable if the team values simplicity over session continuity.
2. **If Strategy 2: how do we annotate the timeline gap?** Synthetic `PollRecord` markers at boundaries, drop hierarchy entries silently, or emit a separate "session events" stream?
3. **If Strategy 2: what is the resume-failure contract?** Abort the session (recommended) vs leave it in a degraded state and let the caller decide.
4. **Feature flag for first release?** Recommended for Strategy 2 — toggle between "old behavior: hard error" and "new behavior: pause/resume" for one release so we can fall back without a code change if pause/resume destabilizes recordings.
5. **Cancellation semantics during flow.** Should `cancel_task` on a flow-running task automatically abort the recording session, or should it leave the session intact and resume polling? (Default-recommended: leave session intact.)
6. **Soft vs hard stop for Strategy 3.** If the team chooses 3, do we add a "stop without compile" handler to keep the artifact set lean, or always run the full compile?
7. **Should `execute_ui_action`'s contract change?** Today it's the workaround the error message at `driver-conflict.ts:33-34` recommends. After Phase 4, is `execute_ui_action` still the preferred mid-session tool, or should `run_flow` be promoted as equally valid?

## 10. Open research questions

- **Does `maestro mcp` expose flow execution as a tool?** Code shows only `inspect_view_hierarchy` is wired (`daemon.ts:117-119`); confirm against the current Maestro docs and changelog before fully ruling out Strategy 1.
- **Can `maestro test` attach to an already-running XCTRunner?** Comment at `driver-conflict.ts:10-12` says no, but it's worth a fresh check — Maestro may have added an `--attach` or driver-reuse flag we haven't seen.
- **What's the actual cold-respawn cost** for the daemon mid-session on the team's typical hardware? Logged at `daemon.ts:104-105` ("warm in ~Xms"); collect numbers from a few real machines to budget the gap accurately for Strategy 2.
- **Does Proxyman keep capturing through the gap?** Strongly believed yes (Proxyman is a system proxy, independent of the XCTest driver), but we should confirm with one manual test before we promise it in docs.
- **Android parity.** Everything above is iOS port-7001 specific. Android UiAutomator doesn't have the port-contention problem (`wrapper.ts:328-329`), but `assertNoActiveSessions` blocks both platforms. Does Phase 4 need to do anything for Android, or is the fix iOS-only and Android keeps working as it does today?
