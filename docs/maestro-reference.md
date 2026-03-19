# Maestro Command Reference

Quick reference for Maestro commands, wait behavior, and stabilization patterns used by the mobile-automator MCP tools.

---

## Supported Commands

The YAML generator (`synthesis/generator.ts`) emits these Maestro commands:

| Command | Maestro YAML | When Used |
|---|---|---|
| Launch app | `- launchApp` | Always first step |
| Tap | `- tapOn:` + selector | `tap` action |
| Type text | `- inputText: "value"` | `type` action (after tapOn to focus) |
| Scroll | `- scroll` | `scroll` action |
| Swipe | `- swipe:` + direction/duration | `swipe` action |
| Back | `- back` | `back` action |
| Assert visible | `- assertVisible:` + selector | `assertVisible` action |

---

## Selector Priority

The tool generates selectors in this priority order:

1. **`id:`** — Accessibility ID / `testID` (most stable)
2. **`label:`** — Accessibility label
3. **`text:`** — Visible text (least stable — changes with localization/content)
4. **`point:`** — Screen coordinates (last resort — breaks on different screen sizes)

> [!TIP]
> The tool warns on low-confidence selectors via YAML comments (`# ⚠️ ...`). If you see these warnings, consider asking the app team to add stable accessibility identifiers.

---

## Wait and Timing Behavior

### Implicit Waits (Default)

Maestro automatically waits for elements to appear before interacting with them. The default implicit wait timeout is **5 seconds**. Most stable flows work fine with just implicit waits.

### `extendedWaitUntil`

Use when an element takes longer than 5 seconds to appear (e.g., after a network call, login, or heavy computation):

```yaml
- extendedWaitUntil:
    visible:
      id: "dashboard_root"
    timeout: 15000  # milliseconds
```

Common use cases:
- Waiting for a post-login dashboard to load
- Waiting for API-driven content to render
- Waiting for animations to complete after navigation

### `assertVisible`

Checks that an element is currently visible. Unlike `extendedWaitUntil`, this **fails immediately** if the element is not visible (no implicit wait):

```yaml
- assertVisible:
    id: "welcome_message"
```

Use for validation checkpoints after you've already waited for the screen to settle.

### `waitForAnimationToEnd`

Waits until all animations on screen finish before proceeding. Useful after transitions:

```yaml
- waitForAnimationToEnd
```

Or with a timeout:

```yaml
- waitForAnimationToEnd:
    timeout: 5000
```

---

## Common Stabilization Patterns

### Handling Loading Spinners

If the app shows a spinner or shimmer before content loads, wait for the final content element instead of interacting with the spinner:

```yaml
- launchApp
- extendedWaitUntil:
    visible:
      id: "dashboard_content"
    timeout: 20000
```

> [!IMPORTANT]
> Do **not** assert on transient loading elements like `full_screen_spinner`, `shimmer-block`, or `LoadingWithSpinner_ViewRoot`. These are placeholder UI that will disappear. Wait for the stable content element that appears **after** loading completes.

### Handling Login Variants

If the app has multiple login screen states (e.g., new user vs. returning user), the generated flow may contain selectors from the wrong variant. To stabilize:

1. **Before recording**: Ensure the app is in a known state (clear app data or use a specific test account)
2. **In generated YAML**: Verify selector IDs match the expected login variant
3. **Best practice**: Ask the app team to expose a single, stable root accessibility ID per screen state

### Handling Auth / Secure Fields

For password and other secure text fields, the generated YAML uses environment variables:

```yaml
- tapOn:
    id: "password_field"
# ⚠️ Secure field detected — use -e SECURE_INPUT=<value> at runtime
- inputText: "${SECURE_INPUT}"
```

Run with: `maestro test flow.yaml -e SECURE_INPUT=mypassword`

---

## Replay Modes

### Live Backend

The generated YAML can run against the real app backend. This is the simplest mode but depends on backend availability and state:

```bash
maestro test flow.yaml
```

### Stubbed / WireMock Replay

The MCP `run_test` tool can start a WireMock stub server alongside the test:

```
run_test(yamlPath: "flow.yaml", stubsDir: "session-xxx/wiremock/")
```

This replays captured API responses for deterministic, offline testing.

> [!NOTE]
> Stubbed replay requires the app to be configured to point to the stub server URL (usually via `localhost.proxyman.io:<port>`). See [Proxyman Setup](./proxyman-setup.md) for details.

### Environment Variables

Pass environment variables to Maestro for dynamic values:

```bash
maestro test flow.yaml -e USERNAME=test@example.com -e PASSWORD=secret
```

Or via the `run_test` tool:

```
run_test(yamlPath: "flow.yaml", env: { "USERNAME": "test@example.com" })
```

---

## Improving Recording Fidelity with `trackEventPaths`

Passive polling mode infers UI interactions from hierarchy diffs, but it can miss fast interactions (especially during login flows). For critical flows, **app-side event tracking** via `trackEventPaths` provides a much more reliable signal.

### How It Works

When `trackEventPaths` is set on `start_recording_session`, the compile step scans captured network events for POST requests to matching URL paths. The request bodies are parsed as interaction events and merged with hierarchy-inferred interactions.

### Configuration

```
start_recording_session(
  appBundleId: "com.example.app",
  platform: "ios",
  trackEventPaths: ["/__track", "/api/analytics/events"]
)
```

### Expected POST Body Format

The app should POST JSON to the tracked endpoint(s) with this structure:

```json
{
  "event": "tap",
  "target": { "id": "login_button", "label": "Sign In" },
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### When to Use

> [!TIP]
> Use `trackEventPaths` for flows where passive hierarchy polling is unreliable:
> - **Login flows** — rapid field focus changes and text input
> - **Multi-step wizards** — fast navigation between screens
> - **Gesture-heavy flows** — swipes and scrolls that hierarchy diffing might miss

### Domain Filtering

For best results, also set `filterDomains` to scope network capture to your app's API hosts:

```
start_recording_session(
  appBundleId: "com.example.app",
  platform: "ios",
  filterDomains: ["api.example.com", "localhost.proxyman.io:3031"],
  trackEventPaths: ["/__track"]
)
```

This reduces noise from unrelated traffic (OS analytics, third-party SDKs, etc.) and improves both recording reliability and debugging clarity.

---

## Troubleshooting Generated Flows

| Symptom | Likely Cause | Fix |
|---|---|---|
| Element not found | Wrong selector for the current app state | Verify IDs match; use `get_ui_hierarchy` to inspect |
| Test times out | Implicit wait insufficient for slow loads | Add `extendedWaitUntil` with longer timeout |
| Flaky pass/fail | Transient loading UI captured as action targets | Remove interactions with spinner/shimmer elements |
| Selector mismatch after login | Multiple login variants produce different IDs | Pin to one variant; clear app state before recording |
| Stub replay stalls | Incomplete stub capture or missing routes | Check manifest.json for captured routes; add missing stubs |
| `⚠️ Selector looks transient` | Element ID contains shimmer/loading/spinner | Wait for final content instead of interacting with loader |
