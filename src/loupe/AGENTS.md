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
    │     ├── hierarchy + tap/type → LoupeClient (HTTP + `loupe` CLI)
    │     └── runTest / setup / swipe / back / scroll → MaestroWrapper
    └─▶ MaestroDaemonDriver  otherwise (baseline)
```

The factory predicate **requires** a bundle id at create time, because Loupe
injects per-app. Sessionless `get_ui_hierarchy` calls (no bundle id known)
naturally fall through to Maestro.

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
- `setAppContext(bundleId)` is idempotent — `loupe start --bundle-id ... --udid ...`
  then polls `~/.loupe/runtimes` (and `loupe current` as a fallback) until
  GET `/runtime` responds 200, or times out.
- On any injection failure (CLI missing, runtime never comes up, HTTP error
  mid-session) the driver enters **degraded** mode: every hierarchy/action
  call transparently forwards to the internal `MaestroWrapper`. Handlers
  never see an exception cross the boundary.
- `stop()` best-effort `loupe stop --udid <udid>` and clears state.

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
