# Loupe Module — AGENTS.md

## Purpose

Additive `AutomationDriver` backend that routes UI hierarchy + native HID
actions through Loupe (`heoblitz/Loupe`), an iOS Simulator dylib injector
that exposes the inspected app's UI tree over a loopback HTTP server.

Loupe is **opt-in** via `MCA_UI_DRIVER=loupe`. Default behavior (env unset
or `=maestro`) is unchanged.

## Architecture Boundaries

- **Owns:** `LoupeClient` (CLI + HTTP wrapper), `loupeToHierarchy` (canonical
  converter), `LoupeDriver` (`AutomationDriver` implementation).
- **Must NOT** import from `session/`, `proxyman/`, `synthesis/`.
- **May import:** `maestro/wrapper.js` (for delegated `runTest` / setup /
  fallbacks), `maestro/hierarchy.js` (`HierarchyParser` for degraded mode),
  `maestro/structural-hash.js`, `maestro/driver.js` (for the interface),
  `types.js`.

## How It Slots In

```
DriverFactory.create(timeouts, { platform, bundleId })
    ├─▶ LoupeDriver        when MCA_UI_DRIVER=loupe AND platform=ios AND bundleId set
    │     ├── hierarchy ops + every live UI action → LoupeClient (HTTP + `loupe` CLI)
    │     │     • tap/type:           native Loupe primitives
    │     │     • back/swipe/scroll:  composed from `loupe swipe`
    │     │     • scrollUntilVisible: poll /accessibility, swipe DOWN, repeat
    │     │     • swipeUntilVisible:  poll /accessibility, swipe RIGHT, repeat
    │     │     • assertVisible:      query /accessibility
    │     └── runTest / validateSetup / validateSimulator / ensureCleanDriverState /
    │         uninstallDriver → MaestroWrapper (Maestro CLI is the source of truth
    │         for the synthesized YAML that will replay later)
    └─▶ MaestroDaemonDriver  otherwise (baseline)
```

The factory predicate **requires** a bundle id at create time, because Loupe
injects per-app. Sessionless `get_ui_hierarchy` calls (no bundle id known)
naturally fall through to Maestro.

Loupe has no `stop`, `scroll`, or `back` subcommand upstream — those are
composed inside `LoupeDriver` from `loupe swipe`. Screen dimensions used by
the composed gestures are cached opportunistically from the live
`/accessibility` root frame.

## Output Convergence

`loupeToHierarchy` is the single point where Loupe JSON becomes a canonical
`UIHierarchyNode`. Downstream (`HierarchyDiffer`, `flattenToElements`,
`computeStructuralHash`, synthesis) is unchanged — meaning a session
recorded under Loupe and a session recorded under Maestro on the same UI
must produce byte-identical Maestro YAML (modulo timestamps).

Mapping (`hierarchy.ts`):

| `UIHierarchyNode`     | Loupe source                                         |
|-----------------------|------------------------------------------------------|
| `id`                  | `testID ?? identifier` (NOT `testId` — synthesis ignores it) |
| `accessibilityLabel`  | `label`                                              |
| `text`                | `value ?? text ?? placeholder`                       |
| `role`                | `role ?? traitToRole(traits) ?? 'Element'`           |
| `isSecure`            | `traits.includes('secureTextEntry')`                 |
| `bounds`              | `frame` copied as-is                                 |
| `children`            | refs resolved through `tree.nodes`                   |

## Lifecycle & Failure Model

- `start(deviceId)` stores UDID; if `bundleId` was passed to the constructor,
  eagerly calls `setAppContext(bundleId)`.
- `setAppContext(bundleId)` is idempotent — `loupe start --bundle-id <id> --device <udid>`
  then resolves the assigned port via `loupe runtimes` → `loupe current` →
  `~/.loupe/runtimes`, then polls GET `/runtime` until 200 or timeout.
- On **injection failure** (CLI missing, runtime never comes up) the driver
  enters **degraded** mode: every hierarchy/action call transparently
  forwards to the internal `MaestroWrapper`. Handlers never see an
  exception cross the boundary.
- **Per-call failures** behave differently by category:
  - Hierarchy read errors (HTTP failure mid-session) → wrapper fallback.
  - Live action errors (`loupe tap`/`swipe`/`type` returns non-zero) →
    surface as `{ success: false, error }`. **No silent wrapper fallback**,
    because that would defeat the point of the integration by sending the
    action through the XCUITest driver.
- `stop()` clears local injection state. Loupe has no `stop` subcommand;
  the injected runtime tears down when the simulator app process dies.

## File Inventory

| File              | Description                                              |
|-------------------|----------------------------------------------------------|
| `client.ts`       | `LoupeClient` — CLI spawn + HTTP fetch                   |
| `hierarchy.ts`    | Pure `loupeToHierarchy` converter (the convergence point) |
| `loupe-driver.ts` | `LoupeDriver` — `AutomationDriver` impl                  |
| `index.ts`        | Barrel re-exports                                        |

## Testing

- `hierarchy.test.ts` (golden + cross-driver convergence) verifies the
  converter's output matches what Maestro's `HierarchyParser` would emit
  for the equivalent screen.
- `loupe-driver.test.ts` exercises the degraded-mode fallbacks and the
  selector priority in `dispatchTap`.
- `client.test.ts` covers `resolveLoupeBin` and the runtimes-file parser.

Run: `npm test src/loupe/`.
