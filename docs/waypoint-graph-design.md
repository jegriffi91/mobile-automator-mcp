# Waypoint Graph — Design

Status: **Evaluation / pre-implementation**
Owner: James Griffin
Started: 2026-05-11

## Problem

LLM execution agents waste tokens exploring an app to locate the starting screen for a ticket, and they routinely hallucinate navigation paths because they assume standard app conventions ("tap profile, then settings"). The mobile-automator-mcp exposes Maestro flow primitives, but there is no first-class way for an agent to ask *"how do I get to feature X?"* and receive a deterministic, single CLI command back.

The Waypoint Graph closes this loop. It bridges the iOS-GraphRAG AST (sibling project at `/Users/jamesgriffin/dev/iOS-GraphRAG`) to the Maestro YAML sub-flows in this repo, so that navigation becomes a closed-loop API call rather than open-ended exploration.

## Goals

- Agents call `get_waypoint(target_feature) → CLI_Command` and never guess navigation.
- Composition: a waypoint is a *stack of reusable subflows* (login → dismiss interstitials → navigate), not a single bespoke flow.
- Scalable under feature-flag and dynamic-entry-state pressure (DAG-shaped metadata, see §6).
- Zero invasive changes to the iOS source codebase in v1.
- Graceful degradation when iOS-GraphRAG enrichment is unavailable.

## Non-goals (v1)

- Swift attribute / doc-comment extraction in iOS-GraphRAG (reverse lookup is v2+).
- Full DAG pathfinder. v1 ships a trivially-flat path resolver against DAG-shaped metadata.
- Multi-target waypoint resolution (one feature → multiple flows). v1 picks the first match; ambiguity rules are tightened in v2.

## Architecture

### Coupling model: materialized index (Option A)

iOS-GraphRAG continues to write its SQLite knowledge graph; a `waypoints.json` sidecar artifact is the agreed file-level interface. mobile-automator-mcp reads it directly. The two MCPs share a file format, nothing else — no runtime cross-MCP calls.

Justification: a launchctl-managed re-indexer keeps iOS-GraphRAG's index fresh within seconds, so the staleness window is bounded by an automated cadence rather than a manual re-run. File coupling is simpler and faster than live MCP-to-MCP RPC.

### v1 source of truth: flow side

In v1, the **`_manifest.json` flow manifest** owns waypoint metadata. iOS-GraphRAG provides optional enrichment only (resolving `destination_symbol` → file:line for the agent). No Swift source modification is required.

The v2/v3 graduation path adds Swift annotation extraction so the symbol side can declare its own waypoint identity, enabling reverse lookup ("given this file I'm editing, what flows reach it?").

## 1. Manifest schema (waypoint section)

The existing flow manifest at `_manifest.json` (read by `FlowRegistry.list()` in [src/handlers.ts](../src/handlers.ts)) gains a `waypoint` block per entry:

```json
{
  "flows": {
    "checkout_start": {
      "description": "Waypoint: lands on the checkout entry screen for a returning authenticated user",
      "tags": ["checkout", "waypoint"],
      "waypoint": {
        "tag": "checkout_start",
        "goal_state": "at_checkout",
        "destination_symbol": "CheckoutView",
        "stack": [
          "subflows/login_returning_user",
          "subflows/dismiss_post_login_interstitials",
          "subflows/navigate_to_checkout"
        ]
      }
    }
  }
}
```

Field meanings:

| Field | Required | Meaning |
|---|---|---|
| `tag` | yes | Stable identifier for this waypoint. Agents query by tag or feature keyword. |
| `goal_state` | yes | The DAG goal-state name (see §5). Used by v2+ pathfinder; v1 informational. |
| `destination_symbol` | no | Swift symbol name (`CheckoutView`). Used for optional iOS-GraphRAG enrichment. |
| `stack` | yes (v1) | Ordered list of subflow paths. v1 executes verbatim. v2+ derives from goal_state + pathfinder. |
| `description` | recommended | One-line human-readable summary. |

## 2. Subflow metadata convention

Subflows live in `subflows/` and are atomic, reusable, idempotent. Each subflow YAML carries a header block (machine-readable YAML comment or front-matter — convention TBD on implementation):

```yaml
# waypoint-meta:
#   name: login_returning_user
#   requires: [logged_out]
#   provides: [logged_in_returning_user]
#   when: {}                          # active under any flag combination
#   applies_when: null                # always applies once `requires` are met
```

Additional fields:

| Field | Purpose |
|---|---|
| `requires: [state]` | Preconditions — what must be true for this subflow to be valid. |
| `provides: [state]` | Postconditions — what is true after the subflow completes successfully. |
| `when: {flag: value}` | Static applicability — gated on feature-flag values passed in via context. |
| `applies_when: <probe>` | Dynamic applicability — gated on a runtime probe predicate. |

### Subflow authoring rule (enforce from day one)

**Subflows must be idempotent or precondition-checked.** If `dismiss_post_login_interstitials` crashes when no interstitial is showing, every waypoint that includes it fails. Use Maestro's `optional:` matchers or guard with `assertVisible` checks. Without this discipline, composability degrades to bespoke per-waypoint variants of every common subflow.

## 3. `get_waypoint` MCP tool contract

Registered in [src/index.ts](../src/index.ts) alongside `list_flows`. Tool name: `get_waypoint`.

### Input

```ts
{
  target_feature: string;            // tag or feature keyword
  context?: {
    flags?: Record<string, unknown>; // active feature flags
    current_state?: string;          // optional agent-supplied entry state
  };
  trace?: boolean;                   // include diagnostic trace in response
}
```

### Output

```ts
{
  command: string;                   // deterministic Maestro CLI command
  flow_path: string;                 // path to the (possibly generated) composed YAML
  composition: string[];             // ordered subflow names that will run
  destination_symbol?: string;       // mirrored from manifest
  destination_location?: {           // optional, only if iOS-GraphRAG resolved it
    file: string;
    line: number;
  };
  trace?: {
    matched_waypoint: string;
    rejected_alternatives: Array<{ name: string; reason: string }>;
  };
}
```

### Error modes

| Condition | Response |
|---|---|
| No waypoint matches `target_feature` | Error: `WAYPOINT_NOT_FOUND` with a list of nearest tags by Levenshtein/keyword. |
| Multiple waypoints match equally | v1: pick first sorted by tag, include warning. v2: ambiguity-resolution rules. |
| Subflow referenced in `stack` not on disk | Error: `SUBFLOW_MISSING` with path. |
| iOS-GraphRAG enrichment failed | Silent — omit `destination_location`, keep returning `command`. |

## 4. Composer

The composer turns a resolved waypoint into a single executable artifact.

- **Input**: an ordered subflow list (from `stack` in v1, from pathfinder in v2+).
- **Output**: an ephemeral YAML written to `flows/_generated/waypoint_<tag>.yaml` that uses Maestro's native `runFlow:` directive to invoke each subflow in order.
- **Returned command**: `maestro test flows/_generated/waypoint_<tag>.yaml` (or the equivalent invocation via the existing `MaestroWrapper` / `AutomationDriver` abstraction at [src/maestro/driver.ts](../src/maestro/driver.ts)).
- **Caching**: the generated YAML can be deterministically hashed by `(tag, stack, context)`; identical regenerations are no-ops.

Example generated YAML for `checkout_start`:

```yaml
# Auto-generated by Waypoint composer — do not edit.
# Source waypoint: checkout_start
appId: ${MAESTRO_APP_ID}
---
- runFlow: ../subflows/login_returning_user.yaml
- runFlow: ../subflows/dismiss_post_login_interstitials.yaml
- runFlow: ../subflows/navigate_to_checkout.yaml
```

The agent only ever sees a single command. Composition is invisible to the caller — exactly the closed-loop API call the design exists to enable.

## 5. State vocabulary

The state vocabulary is the foundation of the DAG. Subflows reference these names in `requires:` / `provides:`. Naming discipline matters: inconsistency causes pathfinding to fail silently.

### Admission rule — a state must be probe-observable

A state earns a vocabulary entry only if (1) the agent can reliably probe it — i.e., it persists long enough for a UI / network / storage check to complete — AND (2) at least one subflow either originates from it or terminates at it as a non-transient resting point.

**Probe-invisible transients** (the iOS splash screen, brief loading flashes, in-flight nav transitions) are absorbed into a parent subflow rather than modeled as states. Maestro's `launchApp` directive, for example, internally waits past the splash before returning control — so the launch-and-route subflow consumes `app_installed` and produces `at_front_door` / `at_returning_user_login` directly, with no intermediate `at_splash` state.

**Probe-observable transients** (e.g. `login_in_progress` — the post-submit spinner that holds for seconds while the network round-trips) DO earn vocabulary entries, because they last long enough to probe and a `wait_for_*` subflow can meaningfully consume them.

Every state in the vocabulary must be something the pathfinder, the agent, or trace-mode debugging can verify. States that can't be observed are dead weight; they make the graph harder to reason about without adding any verifiable structure.

### Categories (template)

The vocabulary will be organized into the following categories. Specific names per category will be filled in based on the target app walkthrough.

- **Lifecycle states** — `app_uninstalled`, `app_installed`, `app_launched_cold`, `app_launched_warm`, …
- **Auth states** — `logged_out`, `logged_in_<persona>`, `mfa_pending`, …
- **Modal/interstitial states** — `no_modals`, `<modal>_visible`, `<modal>_dismissed`, …
- **Destination states** — `at_<screen>` (one per agent-reachable destination), …
- **Mode/persona states** — variants by user role, tier, A/B cohort, app mode, …

### App-specific vocabulary — Experian iOS

Target app: Experian iOS — consumer credit score and credit report aggregator across the 3 reporting agencies. Captured 2026-05-11.

#### Lifecycle

| State | Meaning |
|---|---|
| `app_uninstalled` | App not installed on device/simulator. |
| `app_installed` | App installed but not launched. |
| `app_launched_cold` | App launched from a killed state; full init sequence ran. |
| `app_launched_warm` | App brought to foreground from background; no full init, no splash traversal. Returns to last-visible state. |
| `at_front_door` | The carousel landing page. Reached from launch only when no session is remembered on this device. Two CTA branches: "login" and "registration funnel". |

> Note: the iOS splash screen is **not modeled** as a state — it's a probe-invisible transient absorbed into the `launch_app_to_*` subflows per the admission rule above.

#### Auth

The app has two parallel pre-member login paths plus a registration funnel. v1 models both login paths; registration is Phase 2 scope (deferred 2026-05-11).

**New user login** (reached when no session is remembered — splash → front door → login funnel):

| State | Meaning |
|---|---|
| `at_login_method_selector` | Intermediate screen reached by tapping the "login" CTA on the front door. Offers method choices including "login with username and password". |
| `at_new_user_login` | Username + password screen reached via the debug shortcut from `at_login_method_selector`. **Primary waypoint anchor for new-user member-side testing.** |

**Returning user login** (reached when a session is remembered — splash routes directly here, bypassing front door):

| State | Meaning |
|---|---|
| `at_returning_user_login` | Password-only screen reached directly from `at_splash` when the device remembers the user. **Primary waypoint anchor for returning-user testing.** Also the terminal state for explicit sign-out AND auto-logout on session expiry. |

**Shared transient and terminal states**:

| State | Meaning |
|---|---|
| `logged_out` | General "no active session" predicate. Distinct from `at_front_door` because a logged-out returning user lands at `at_returning_user_login`, not at the carousel. |
| `login_in_progress` | Full-page loading spinner active post-submit. Subflows must not run from this state; the `wait_for_login_complete` subflow is the only edge that consumes it. |
| `logged_in_at_member_landing` | First member-app screen after login completes, **before** any interstitial dismissal. May have an offer sheet or review alert sitting on top. |

**Registration (Phase 2 — deferred per scope decision 2026-05-11)**:

| State | Meaning |
|---|---|
| `at_registration_ssn_entry` | Entry step of the registration funnel — last 4 of SSN. |
| `at_registration_account_creation` | Traditional account-creation form reached via debug shortcut. |

**Explicitly excluded from v1**: biometric auth (Face ID / Touch ID) — auto-invokes too quickly to be reliable in the test harness. Forgot password / recovery — edge-case, deferred. The phone-entry "new user login" funnel — the login team iterates on that surface too fast to chase; v1 standardizes on the debug-shortcut username+password path as the new-user canonical.

#### Interstitials & modals

Server-driven and conditional on user state / eligibility. Each is detected by a probe and removed by an idempotent dismissal subflow.

| State | Meaning |
|---|---|
| `offer_bottom_sheet_visible` | Half-screen bottom-sheet modal with a promotional offer. |
| `app_review_alert_visible` | Native-style popup alert dialog requesting an App Store review. |
| `no_interstitials_visible` | Composite "clean landing" state — all known interstitials have been checked and either dismissed or confirmed absent. |

#### Destinations — member app

The member app uses a 5-item bottom nav. **The tab set will become dynamic / server-driven in the near future** — the vocabulary must tolerate adding/removing tab states without rewiring waypoints. v1 enumerates the current tabs as a closed set; v2 should make the bottom-nav membership probe-discovered.

| State | Meaning |
|---|---|
| `at_member_dashboard` | Dashboard tab. The only tab from which the hamburger menu and alerts are accessible. |
| `at_member_credit` | Credit tab. |
| `at_member_money` | Money tab. |
| `at_member_loans` | Loans tab. |
| `at_member_cards` | Cards tab. |
| `at_dashboard_more_menu` | Hamburger menu opened from the top-right of Dashboard. Gateway to features that don't fit the bottom nav. |
| `at_dashboard_alerts` | Alerts screen opened from the icon next to the hamburger on Dashboard. |

Important constraint encoded in the requires/provides graph: `at_dashboard_more_menu` and `at_dashboard_alerts` **require** `at_member_dashboard` — there is no cross-tab path to them. A waypoint to a feature reachable only via the hamburger menu must traverse Dashboard.

Tab content itself is server-driven by dynamic user state, so any in-tab waypoint (e.g. `at_credit_dispute_form`) is a downstream concern: separate waypoint with `requires: [at_member_credit]`.

#### Modes / personas / flag-gated variants

| State / Flag | Meaning |
|---|---|
| `debug_shortcuts_enabled` | Dev/test mode that makes phone-entry and SSN-entry fields tap-through to the traditional username/password and account-creation forms. Treat as a `when: {debug_shortcuts: true}` condition on shortcut subflows, not as a graph state. |
| `returning_user_session_remembered` | Device-level runtime predicate: a previously-logged-in user is associated with this install. Detected at splash time; routes `at_splash → at_returning_user_login` instead of `at_splash → at_front_door`. Probe-detected at runtime, not flag-based — modeled as `applies_when:` on the splash-dismissal subflows. |

**Server-side user tiers** (free / premium / paid) — exist server-side but do not fork frontend navigation; not modeled in topology. Tier-gated feature visibility is downstream (in-tab content), not a topology concern.

**Dynamic bottom-nav set** (when it ships) — per-user-persistent: a given user always sees the same tabs across sessions. Tab membership can be cached in the waypoint context after the first login probe, rather than re-probed each launch.

### Resolved vocabulary decisions (2026-05-11)

1. ✅ **"New user login" semantics**: confirmed — the phone-entry funnel is genuinely for new users (first login after registration). The login team iterates on it quickly; v1 standardizes on the **username+password path via debug shortcut** as the new-user canonical and the **password-only path** as the returning-user canonical.
2. ✅ **Biometric auth**: excluded from v1 — auto-invokes too quickly for the test harness to interact reliably.
3. ✅ **Forgot password / recovery**: deferred — edge-case, not modeled.
4. ✅ **Logout target**: explicit sign-out via Dashboard → top-of-scrollview hamburger → scroll to bottom → tap sign out → lands at `at_returning_user_login`.
5. ✅ **User tiers**: server-side only — not modeled in topology.
6. 🟡 **Additional interstitials**: deferred to Phase 2 (registration scope) — revisited when registration subflows are designed.
7. ✅ **Dynamic tab set**: per-user-persistent — cacheable in waypoint context after first probe.
8. ✅ **Session-expired mid-app**: auto-logout target is `at_returning_user_login` (same state as the normal returning-user entry point). Re-auth path is identical to a fresh returning-user login. No distinct `session_expired_modal_visible` state needed.

## Initial subflow set — v1 scope (login + logout)

With the resolved vocabulary, the following minimal subflow set covers both login paths and the explicit logout flow. All subflows are written to be **idempotent or precondition-checked** per the authoring rule in §2.

### Launch and routing

The splash screen is not a state (per the admission rule in §5) — these subflows internally use Maestro's `launchApp`, which blocks until the splash has cleared and the first real screen is visible. They consume `app_installed` and produce a settled, probe-observable state directly.

| Subflow | Requires | Provides | Applicability |
|---|---|---|---|
| `launch_app_to_front_door` | `app_installed` | `at_front_door` | `applies_when: not probe.returning_user_session_remembered` |
| `launch_app_to_returning_login` | `app_installed` | `at_returning_user_login` | `applies_when: probe.returning_user_session_remembered` |

### New-user login (via debug shortcut)

| Subflow | Requires | Provides | Applicability |
|---|---|---|---|
| `front_door_tap_login` | `at_front_door` | `at_login_method_selector` | always |
| `login_select_username_password` | `at_login_method_selector` | `at_new_user_login` | `when: {debug_shortcuts: true}` |
| `submit_new_user_credentials` | `at_new_user_login` | `login_in_progress` | always (test fixture user parametrized) |

### Returning-user login

| Subflow | Requires | Provides | Applicability |
|---|---|---|---|
| `submit_returning_user_password` | `at_returning_user_login` | `login_in_progress` | always (test fixture password parametrized) |

### Shared post-submit and interstitial cleanup

| Subflow | Requires | Provides | Applicability |
|---|---|---|---|
| `wait_for_login_complete` | `login_in_progress` | `logged_in_at_member_landing` | always |
| `dismiss_offer_bottom_sheet` | `logged_in_at_member_landing` | (idempotent no-op) | `applies_when: probe.offer_bottom_sheet_visible` |
| `dismiss_app_review_alert` | `logged_in_at_member_landing` | (idempotent no-op) | `applies_when: probe.app_review_alert_visible` |
| `arrive_clean_landing` | `logged_in_at_member_landing` | `at_member_dashboard`, `no_interstitials_visible` | always; Dashboard is the app's default landing tab |

### Logout

| Subflow | Requires | Provides | Applicability |
|---|---|---|---|
| `nav_dashboard_open_more_menu` | `at_member_dashboard` | `at_dashboard_more_menu` | always |
| `more_menu_scroll_and_sign_out` | `at_dashboard_more_menu` | `at_returning_user_login` | always (sign-out button is at the bottom of the menu scrollview) |

### Example v1 waypoint registrations

The three waypoints below are the first to ship. Built on the subflows above. Sufficient to validate the entire v1 architecture end-to-end: schema, composer, `get_waypoint` tool, subflow authoring conventions, and the iOS-GraphRAG `destination_symbol` enrichment hook.

```json
{
  "flows": {
    "login_new_user": {
      "description": "Reach a clean Dashboard via the new-user U+P path with debug shortcuts.",
      "tags": ["login", "waypoint", "v1"],
      "waypoint": {
        "tag": "login_new_user",
        "goal_state": "no_interstitials_visible",
        "destination_symbol": "DashboardView",
        "stack": [
          "subflows/launch_app_to_front_door",
          "subflows/front_door_tap_login",
          "subflows/login_select_username_password",
          "subflows/submit_new_user_credentials",
          "subflows/wait_for_login_complete",
          "subflows/dismiss_offer_bottom_sheet",
          "subflows/dismiss_app_review_alert",
          "subflows/arrive_clean_landing"
        ]
      }
    },
    "login_returning_user": {
      "description": "Reach a clean Dashboard via the returning-user password-only path.",
      "tags": ["login", "waypoint", "v1"],
      "waypoint": {
        "tag": "login_returning_user",
        "goal_state": "no_interstitials_visible",
        "destination_symbol": "DashboardView",
        "stack": [
          "subflows/launch_app_to_returning_login",
          "subflows/submit_returning_user_password",
          "subflows/wait_for_login_complete",
          "subflows/dismiss_offer_bottom_sheet",
          "subflows/dismiss_app_review_alert",
          "subflows/arrive_clean_landing"
        ]
      }
    },
    "sign_out": {
      "description": "Sign out from the member app via Dashboard → more menu → sign out. Terminates at returning-user login.",
      "tags": ["logout", "waypoint", "v1"],
      "waypoint": {
        "tag": "sign_out",
        "goal_state": "at_returning_user_login",
        "stack": [
          "subflows/nav_dashboard_open_more_menu",
          "subflows/more_menu_scroll_and_sign_out"
        ]
      }
    }
  }
}
```

Adding the Credit / Money / Loans / Cards tab waypoints (and any in-tab destination) is then a uniform extension — each is a single subflow `tap_tab_<name>` with `requires: [at_member_dashboard]` (or `[at_member_*]` once cross-tab navigation is modeled).

## 6. Implementation phases

### Phase 1 — v1 (this design)
- Schema additions to `_manifest.json` (`waypoint` block).
- `subflows/` directory convention with metadata headers.
- `get_waypoint` MCP tool with flat resolver (`stack: []` is executed verbatim).
- Composer that emits ephemeral `runFlow:` YAML.
- Optional iOS-GraphRAG `destination_symbol` enrichment via `global_codebase_search`.

### Phase 2 — Dynamic entry handling
- `probe_state()` step before composition (probes UI hierarchy, persisted state, recent network logs).
- Subflows declaring `applies_when:` are skipped when the probe says the state is already met.
- `get_waypoint` returns the trimmed stack.

### Phase 3 — Feature-flag conditional edges
- `when: {flag: value}` is honored at composition time.
- Flag context is passed in via `get_waypoint` input or read from a shared session config.

### Phase 4 — Full DAG pathfinder
- Subflows form a graph; `goal_state` is the only required declaration on a waypoint.
- BFS resolves the shortest applicable subflow path from current state → goal.
- `stack:` becomes optional override / cache.

### Phase 5 — Reverse lookup (iOS-GraphRAG annotation extraction)
- Extend `engine/core/indexer.py:344` to walk tree-sitter `attribute` nodes.
- Add `annotations TEXT` column or `node_annotations` table to `engine/database/schema.sql`.
- New MCP tool: `find_waypoints_for_symbol(symbol)` returns the flows that reach a given Swift view.

## 7. iOS-GraphRAG enrichment hook

`get_waypoint` performs an optional best-effort resolution of `destination_symbol`:

1. If `destination_symbol` is set on the matched waypoint:
2. Call iOS-GraphRAG's `global_codebase_search` MCP tool (or read `waypoints.json` if materialized) with the symbol name.
3. Pick the top result with exact `symbol_name` match.
4. Attach `destination_location: { file, line }` to the response.

Failure modes (iOS-GraphRAG down, symbol not found, ambiguous match) all result in the field being omitted. The tool never errors due to enrichment failure.

## 8. Open questions

- **State vocabulary** — fill in §5 from a walkthrough of the target app.
- **Probe implementation strategy** — UI hierarchy alone is fragile. Probably mixes UI hints, persisted state (UserDefaults / keychain peek where exposed by the test harness), and recent network log inspection. Per-state probe functions or one global probe with branching?
- **Ambiguity resolution rules** — when two waypoints have overlapping tag matches, what is the resolution policy? Most-specific tag? Most-recently-updated? Explicit precedence number on the manifest entry?
- **Flag context source** — is the flag set passed in by the agent, read from a session-config file, or queried via a tool call to a flag service at probe time?
- **Subflow location convention** — `subflows/` flat? Or namespaced like `subflows/auth/`, `subflows/modals/`? Affects manifest paths.
- **Generated YAML lifecycle** — committed to `flows/_generated/` for reproducibility, or `.gitignore`d and rebuilt on demand?

## 9. Cross-machine handoff notes

This document is the durable design artifact. It travels with the repo via git. The auto-memory I save during conversations lives in `~/.claude/projects/.../memory/` and is per-machine — not synced. When picking this work up on another machine, this doc is the entry point; the relevant memory files (`waypoint_graph_design.md`, `ios_graphrag_reindexer.md`) are conversation-state, not source-of-truth.
