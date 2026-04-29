---
name: ios-automation-gotchas
description: Accessibility IDs, simulator interaction gotchas, and best practices for iOS UI automation with Maestro
---

# iOS Automation Gotchas & Best Practices

Hard-won lessons from building 29 Maestro tests against a SwiftUI iOS app on the simulator.

## 1. `clearState` Is Mandatory

**Problem:** `launchApp` performs a **warm start** — it brings the app to the foreground without resetting state. If a previous test logged in, the next test finds the dashboard instead of the login screen.

**Fix:** Always add `clearState` before `launchApp`:

```yaml
- clearState
- launchApp
```

**Why it matters:** Without this, test order determines pass/fail. Running tests individually passes, running the suite fails. This is the #1 source of false positives/negatives in Maestro suites.

---

## 2. SwiftUI TabView Accessibility

**Problem:** SwiftUI `TabView` only exposes the **selected tab's content** in the accessibility tree. Assertions on non-selected tab content will fail even though the tab bar item is visible.

```swift
// The tab_doom accessibility ID is on the TabItem, but the
// DoomTabView content is only in the tree when DOOM is selected.
TabView(selection: $selectedTab) {
    DoomTabView()
        .tabItem { Label("DOOM", systemImage: "theatermasks.fill") }
        .tag(0)
        .accessibilityIdentifier("tab_doom")
}
```

**Fix:** Assert on the **tab bar item** (e.g., `tab_doom`), not on nested content from a non-selected tab. To verify another tab's content, `tapOn` the tab first.

---

## 3. NavigationStack Nesting

**Problem:** Double-nesting `NavigationStack` (e.g., `DashboardView` wrapping `DoomTabView` which also has one) can cause elements to become invisible in the accessibility hierarchy. The inner stack's navigation title may conflict with the outer.

**Fix:** Use `NavigationStack` at only one level. Use `NavigationLink` in inner views without an additional stack.

---

## 4. `accessibilityIdentifier` vs `.id()` 

**Problem:** SwiftUI's `.id()` modifier is NOT the same as `.accessibilityIdentifier()`. Maestro uses accessibility identifiers. Using `.id()` will not make elements findable.

```swift
// ❌ Wrong — Maestro can't see this
Text("Hello").id("my_text")

// ✅ Correct — Maestro can find this
Text("Hello").accessibilityIdentifier("my_text")
```

---

## 5. Dynamic Accessibility IDs

**Problem:** When using dynamic IDs (e.g., `doom_topic_row_\(topic.title)`), special characters and spaces break Maestro selectors.

**Fix:** Normalize IDs by replacing spaces with underscores and lowercasing:

```swift
.accessibilityIdentifier(
    "doom_topic_row_\(topic.title.replacingOccurrences(of: " ", with: "_").lowercased())"
)
```

Then in YAML:
```yaml
- tapOn:
    id: "doom_topic_row_the_metal_face"
```

---

## 6. Transient Loading States

**Problem:** `ProgressView` indicators often flash for < 500ms. Maestro's polling interval may miss them entirely, causing `assertVisible` to fail.

**Fix:** Don't assert on transient loading indicators directly. Instead:
- Use `extendedWaitUntil` to wait for the **end state** (the loaded content)
- Test loading states only with a WireMock stub that adds `fixedDelayMilliseconds` to force a long delay

```yaml
# ❌ Unreliable — spinner may vanish before Maestro polls
- assertVisible:
    id: "loading_indicator"

# ✅ Reliable — wait for the final state
- extendedWaitUntil:
    visible:
      id: "doom_topic_list"
    timeout: 15000
```

---

## 7. `extendedWaitUntil` Timeouts

**Problem:** Default Maestro timeouts are 5 seconds. With variable network latency, `DelaySimulator` jitter, and cold-start overhead, 5s is not enough.

**Fix:** Use `extendedWaitUntil` with generous timeouts for ANY post-navigation or post-API assertion:

```yaml
- extendedWaitUntil:
    visible:
      id: "doom_topic_list"
    timeout: 15000  # 15 seconds accommodates jitter + cold start
```

**Rule of thumb:** Login transitions → 15s. Data fetches → 15s. UI animations → 5s.

---

## 8. Share Sheets and System Dialogs

**Problem:** System share sheets and permission dialogs are outside the app's accessibility tree. Maestro has limited ability to interact with them.

**Fix:** Use `assertVisible` with the sheet's `accessibilityIdentifier` (if set via `.sheet`), but avoid trying to tap on system-provided share targets. Dismiss with swipe or the "Done" button if available.

---

## 9. SwiftUI `.confirmationDialog` vs `.alert`

**Problem:** `.confirmationDialog` renders as an action sheet on iPhone and a popover on iPad. The accessibility tree structure differs. `.alert` renders consistently.

**Best practice:** 
- Use `.alert` for critical confirmations (logout, delete)
- Use `.confirmationDialog` for selection menus
- Test on the **same device type** you deploy to

---

## 10. Live Server vs WireMock Stubs

**Problem:** Tests that work against a live server may fail with WireMock stubs (and vice versa) because:
- The live server validates request bodies (e.g., specific usernames)
- WireMock stubs match only on URL path, not body content
- Port mismatch: app targets `localhost:3030`, stub server starts on a random port

**Fix:** 
- For stub tests, use `stubServerPort: 3030` in `run_test` (after stopping the live server)
- For live tests, ensure the username matches what the server expects (e.g., "admin")
- Use Proxyman to route app traffic to the stub server port

---

## 11. Maestro CLI Environment

**Problem:** Subprocesses may not find Maestro CLI or Java if `PATH` isn't properly configured.

**Fix:** Use the enriched environment from `getExecEnv()`:
- Checks `~/.maestro/bin/maestro`
- Ensures `JAVA_HOME` is set
- Adds homebrew and system paths to `PATH`

---

## 12. Username / Form Input Gotchas

**Problem:** `inputText` in Maestro types into the **currently focused field**. If the field isn't focused (e.g., `tapOn` the field first), text goes nowhere.

**Fix:** Always `tapOn` the field before `inputText`:

```yaml
- tapOn:
    id: "login_username_field"
- inputText: "admin"
```

**Also:** SwiftUI `TextField` with `.autocapitalization(.none)` still capitalizes the first character on some iOS versions. Use `.disableAutocorrection(true)` as a belt-and-suspenders approach.

---

## 13. Accessibility Audit for Automation Compatibility

**When to use:** After capturing a UI hierarchy with `get_ui_hierarchy`, assess how automation-friendly the screen's accessibility identifiers are.

### Compatibility Scoring

For each screen, classify every identifiable element:

| Tier | Selector Source | Score | Example |
|------|----------------|-------|---------|
| **A** | `id` (accessibilityIdentifier) | ✅ Best | `signin.password`, `submit_btn` |
| **B** | `accessibilityLabel` only | ⚠️ OK | `label: "Sign In"` |
| **C** | `text` only | ❌ Fragile | `text: "Submit"` |
| **D** | No identifier | 🚫 Invisible | Container views, decorative images |

**Compute:** `Score = (A_count × 3 + B_count × 2 + C_count) / (total × 3) × 100`

### Red Flags to Surface

When analyzing a hierarchy, flag these patterns to the developer:

- **Suffix-only identifiers** (`logo_svg`, `showTextIcon`, `icon_chevron`): These are typically decorative and will produce spurious inferred taps during recording. Recommend renaming or removing the accessibility identifier.
- **Numeric-only text** (`"42"`, `"100"`): Dynamic values that produce flaky selectors. Recommend adding a stable `accessibilityIdentifier` to the parent.
- **Interactive elements without IDs**: Buttons, links, switches, text fields: these MUST have `accessibilityIdentifier`. Without it, recording inference cannot reliably target them.
- **Transient elements** (spinners, shimmers, skeletons): If these have IDs, the poller may infer false interactions on them. Recommend removing their accessibility identifiers or using `accessibilityElementsHidden`.

### Actionable Output Format

When surfacing an audit, recommend specific code changes:

```
Accessibility Audit — Login Screen (Score: 62/100)

🔴 Missing IDs (interactive):
  - Button "Sign In" → add .accessibilityIdentifier("sign_in.button")
  - TextField (password) → add .accessibilityIdentifier("signin.password")

🟡 Decorative IDs (will cause false inferences):
  - Image "logo_svg" → remove .accessibilityIdentifier or use .accessibilityElementsHidden(true)
  - Image "showTextIcon" → rename to "password_visibility_toggle"

🟢 Well-identified:
  - TextField "signin.username" ✓
  - Button "forgot_password" ✓
```

