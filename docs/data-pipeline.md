# Data Processing Pipeline

How data flows from raw captures through the MCP server to final test artifacts. This document is for human developers and contributors.

---

## Design Principle: Protect the LLM

The MCP server's primary role is to **reduce megabytes of raw data into kilobytes of structured signal**. The LLM agent should never see raw hierarchy XML or full HAR exports — it receives compact summaries and makes high-level decisions about what to assert.

```
Raw Data (MB)     → MCP Server (reduce)  → Compact Signal (KB)  → LLM (decide)
──────────────      ──────────────────      ────────────────       ──────────────
Proxyman HAR        Filter, scope, parse    NetworkEvent[]         "Assert 401?"
Hierarchy JSON      Diff, settle, dedup     StateChange[]          "Assert toast?"
Maestro output      Parse pass/fail         { passed, output }     "Retry?"
```

---

## Data Lifecycle

### 1. Capture Phase (`start_recording_session`)

| Data | Source | Storage | Lifetime |
|------|--------|---------|----------|
| Proxyman baseline count | Proxyman CLI | Session row (SQLite) | Until session `done` |
| Domain filters | User input | Session row (SQLite) | Until session `done` |
| Device ID | `validateSimulator()` | In-memory (`MaestroWrapper`) | Server process lifetime |

### 2. Recording Phase (`execute_ui_action`, `get_ui_hierarchy`)

| Data | Source | Storage | Lifetime |
|------|--------|---------|----------|
| UI interactions | Each `execute_ui_action` call | `interactions` table (SQLite) | Until session `done` |
| Network events | `get_network_logs` calls | `network_events` table (SQLite) | Until session `done` |
| Hierarchy snapshots | `get_ui_hierarchy` calls | Returned to LLM only (not persisted) | Ephemeral |

### 3. Compilation Phase (`stop_and_compile_test`)

| Step | Input | Output | Discarded |
|------|-------|--------|-----------|
| Scoped HAR export | Proxyman traffic + baseline | `NetworkEvent[]` | Raw HAR file |
| Correlation | `UIInteraction[]` + `NetworkEvent[]` | `CorrelatedStep[]` | Unmatched events |
| YAML generation | `CorrelatedStep[]` + conditions | Maestro YAML string | — |
| Stub generation | `CorrelatedStep[]` + mocking config | WireMock `mappings/` + `__files/` | — |
| Fingerprinting | `CorrelatedStep[]` | SHA-256 fingerprint | — |

### 4. Output Artifacts (persisted)

```
output-dir/
├── test-{sessionId}.yaml          # Maestro test script
└── session-{sessionId}/
    ├── manifest.json               # Session metadata
    └── wiremock/
        ├── mappings/               # WireMock stub JSONs
        │   ├── stub-001.json
        │   └── stub-002.json
        └── __files/                # Response body fixtures
            ├── response-001.json
            └── response-002.json
```

---

## Processing Boundary

### MCP Server Handles (deterministic, fast)

- **Filtering** — Scope Proxyman traffic by domain and baseline count
- **Parsing** — HAR → NetworkEvent[], hierarchy JSON → UIHierarchyNode tree
- **Correlation** — Match UI actions to network events via sliding time window (default 5s)
- **Diffing** — Compare hierarchy snapshots to detect state changes (future)
- **Code generation** — Produce Maestro YAML and WireMock stubs from correlated steps
- **Deduplication** — Fingerprint action sequences and match against the segment registry

### LLM Agent Handles (reasoning, intent)

- **Deciding what to test** — Which flows to record, which assertions to include
- **Interpreting results** — Understanding test failures and suggesting fixes
- **Natural-language conditions** — Passed to `stop_and_compile_test` as `conditions[]`
- **Mocking strategy** — Choosing `full`, `include`, or `exclude` mode for stubs

---

## Storage: sql.js (In-Process SQLite)

All session data lives in an in-process SQLite database via sql.js. No files, no external database.

| Table | Rows per session | Row size | Retention |
|-------|-----------------|----------|-----------|
| `sessions` | 1 | ~500 bytes | Until `done` |
| `interactions` | 5-50 | ~200 bytes each | Until `done` |
| `network_events` | 5-100 | ~1KB each | Until `done` |

**Total per session**: ~10-100KB. Negligible memory footprint.

> **Future**: Hierarchy snapshots (if persisted for polling mode) would add ~10-50KB per snapshot. At 500ms polling over 30s, that's ~60 snapshots × 30KB = **~1.8MB per session**. Still manageable for in-memory SQLite, but should be GC'd aggressively after compilation.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Ephemeral hierarchy snapshots | Returned to LLM but not persisted — keeps database lean |
| Baseline-scoped HAR export | Only processes traffic captured *during* the session, not all historical traffic |
| Manifest.json per session | Self-describing output — can replay stubs without the database |
| Fingerprint deduplication | Prevents generating duplicate test segments across sessions |
| Domain filtering at session level | Enables concurrent sessions without traffic cross-contamination |
