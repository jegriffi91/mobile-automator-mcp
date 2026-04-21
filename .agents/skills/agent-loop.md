---
name: agent-loop
description: End-to-end loop for an agent making an incremental change to a mobile app — build, install, navigate via a named flow, inspect a screenshot, run unit tests, and iterate.
---

# Agent Loop for Mobile Changes

Use this skill when the user asks you to **make a change to a mobile app and verify it works**. The mobile-automator MCP server exposes tools for each step of the loop. Run through them in order; don't skip ahead.

## The loop

```
1. understand    read the code + tests in the change area
2. edit          apply the change
3. build         build_app
4. install       uninstall_app + install_app  (always pair them — never install on top)
5. navigate      run_flow  → reach the screen the change affects
6. verify_ui     take_screenshot  → visually inspect the result
7. unit_test     run_unit_tests
8. iterate       if step 6 or 7 fails, go to step 2
```

Do not merge steps. Each step is observable evidence the loop hasn't broken yet. If you skip build+install and run a flow, you are verifying the last binary — not your change.

---

## 1. understand

Before touching code:

- Read the file you're about to change AND its tests in the same pass.
- Grep for callers; a one-line change can have five consumers.
- If the change is visual (SwiftUI/Jetpack Compose), identify the screen you'll need to navigate to in step 5.

Common trap: claiming to understand before reading the test file. If a test exists, read it — it encodes the invariants you must preserve.

---

## 2. edit

Minimal, targeted edits. No surrounding refactors. No speculative abstractions. See the main SKILL in `CLAUDE.md` / the repo for style conventions.

---

## 3. build

Call `build_app`. **iOS:**

```json
{
  "platform": "ios",
  "workspacePath": "/abs/path/App.xcworkspace",
  "scheme": "App"
}
```

**Android:**

```json
{
  "platform": "android",
  "projectPath": "/abs/path/android-project",
  "module": "app",
  "variant": "debug"
}
```

Output is truncated (head + tail). If the build failed, the tail almost always contains the compile error. Fix and retry before moving on.

**Caveat:** `build_app` default timeout is 15 minutes. Clean iOS builds on large projects can approach that; incremental builds are fast. If you hit the timeout, pass `timeoutMs` explicitly rather than retrying blindly.

---

## 4. uninstall + install (always pair them)

Never `install_app` on top of an existing install — iOS keeps app data across reinstalls, which means stale UserDefaults, Keychain items, and SwiftData stores survive. The only reliable way to verify "does the fresh app behave correctly?" is:

```
1. uninstall_app  → wipes storage
2. install_app    → clean slate
```

Both take `deviceUdid` + `bundleId` (or `appPath` for install). Get the UDID from `list_devices`.

If you skip the uninstall, you will eventually chase a bug that doesn't reproduce after a wipe — and you won't realize that's the cause until you've wasted an hour.

---

## 5. navigate via run_flow

Hand-authored flows in `./flows/` encode the navigation path to the screen under test. Do not rebuild navigation inline with `execute_ui_action` calls when a flow exists — the flow has already been debugged; your ad-hoc taps haven't.

```json
{ "name": "navigate-to-checkout", "params": { "CART_ID": "abc123" } }
```

If no flow exists for your target screen and the change is not trivial, **ask the user whether to add one** before verifying. A one-off navigation sequence you run once is wasted work; a flow checked into the repo is reusable.

Flows live at `./flows/<name>.yaml`. Optional `./flows/_manifest.json` declares params and descriptions. Run `list_flows` to see what's available.

---

## 6. verify_ui via take_screenshot

`take_screenshot` returns an absolute PNG path. Read the image back — Claude can visually inspect it.

```json
{ "platform": "ios", "deviceUdid": "<udid>" }
```

What to check:

- **Layout:** elements in the expected positions, no clipping, no overlapping text.
- **Content:** the change rendered. A button color change is visible; a label text change is readable.
- **Regression:** previously-working UI on the same screen hasn't broken.

`get_ui_hierarchy` complements this — it shows structural data but will not surface visual regressions (misaligned pixels, wrong color, broken image). Use both.

**Caveat:** Transient states (loading spinners, skeletons, animation mid-flight) produce noisy screenshots. If you see a spinner, wait a second and capture again.

---

## 7. run_unit_tests

Structural verification. Fast on incremental runs, slow on cold runs — default timeout is 30 minutes.

**iOS:**

```json
{
  "platform": "ios",
  "workspacePath": "/abs/path/App.xcworkspace",
  "scheme": "AppTests",
  "onlyTesting": ["AppTests/LoginViewModelTests"]
}
```

Use `onlyTesting` aggressively. Running one test class is seconds; the full suite can be minutes. Only run the full suite before you tell the user the task is done.

**Android:**

```json
{
  "platform": "android",
  "projectPath": "/abs/path/android-project",
  "module": "app",
  "variant": "debug",
  "testFilter": "com.example.LoginViewModelTest"
}
```

The response contains structured `failures[]` with `{name, message, file?, line?}` — jump straight to the file + line rather than grepping.

**Caveat:** `passed: true` requires BOTH `failedTests == 0` AND `totalTests > 0`. If the runner reports zero tests (e.g., the filter matched nothing), `passed` is `false` — that's intentional. A test run with no tests is not a pass.

---

## 8. iterate

If steps 6 or 7 failed, go to step 2. Do not skip back to step 3 — the edit you're about to make has not been built yet.

**When to stop:** when both the visual inspection and the unit tests are clean, AND you can state in one sentence what you changed and why it works.

**When to escalate to the user:** if the same test fails twice after targeted fixes, or if the visual change looks right but the test asserts the old behavior. That's a judgment call about what the correct behavior should be — don't invent it.

---

## Ordering notes

- `boot_simulator` happens before step 3 if the device isn't already booted. `list_devices` tells you.
- `get_ui_hierarchy` is a useful debugging sidecar at any step, but don't confuse "element exists in the tree" with "user can see it." Screenshots settle that question.
- When a flow fails mid-execution, `take_screenshot` is the fastest way to understand why. The error message from Maestro alone rarely tells you enough.

## Tools at a glance

| Step | Tool |
|---|---|
| 3 | `build_app` |
| 4a | `uninstall_app` |
| 4b | `install_app` |
| 5 | `list_flows`, `run_flow` |
| 6 | `take_screenshot`, `get_ui_hierarchy` |
| 7 | `run_unit_tests` |
| — | `list_devices`, `boot_simulator` (pre-step-3 setup) |
