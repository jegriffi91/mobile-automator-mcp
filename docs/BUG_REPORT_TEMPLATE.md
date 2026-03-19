# Bug Report Template

Use this template when reporting issues with the Mobile Automator MCP tools. Providing complete information helps us reproduce and fix problems faster.

> **For LLM Agents**: Fill in every section. Include raw values — do not summarize or paraphrase tool output.

---

## 1. Tool & Session Info

| Field | Value |
|---|---|
| **MCP Tool** | *(e.g., `start_recording_session`, `execute_ui_action`, `stop_and_compile_test`)* |
| **Session ID** | *(UUID from `start_recording_session`)* |
| **Platform** | *(ios / android)* |
| **App Bundle ID** | *(e.g., `com.doombot.ios`)* |
| **Capture Mode** | *(event-triggered / polling)* |

---

## 2. Environment

| Field | Value |
|---|---|
| **Node.js version** | *(output of `node -v`)* |
| **Maestro version** | *(output of `maestro --version`)* |
| **Simulator** | *(device name, UDID, OS version — from `list_devices`)* |
| **Proxyman running?** | *(yes / no / unknown)* |
| **mobile-automator-mcp version** | *(git commit hash or version)* |

---

## 3. Reproduction Steps

Provide the **exact sequence of MCP tool calls** that led to the issue, including all parameters:

```
1. start_recording_session({
     appBundleId: "...",
     platform: "ios",
     captureMode: "polling"
   })
   → sessionId: "..."

2. execute_ui_action({
     sessionId: "...",
     action: "tap",
     element: { id: "login_button" }
   })
   → success: true

3. stop_and_compile_test({ sessionId: "..." })
   → ERROR: ...
```

---

## 4. Expected vs Actual

**Expected behavior:**
*(What should have happened)*

**Actual behavior:**
*(What actually happened — include the full error message)*

---

## 5. Diagnostic Artifacts

Attach or paste the contents of any available diagnostic data:

### 5a. Polling Diagnostics (from `stop_and_compile_test` output)

```json
{
  "pollCount": 0,
  "successCount": 0,
  "errorCount": 0,
  "inferredCount": 0,
  "lastError": null
}
```

### 5b. Session Timeline (from `get_session_timeline` or `timelinePath` output)

```json
// Paste the contents of timeline.json here
```

### 5c. Generated YAML (if compilation succeeded)

```yaml
# Paste the generated YAML here
```

### 5d. stderr Logs

```
# Paste any relevant [MCP] log lines from stderr here
# Look for lines starting with [MCP], [ProxymanWrapper], or [TouchInferrer]
```

---

## 6. Selector Quality

Were any **low-confidence selector warnings** reported during the session?

- [ ] Yes — paste warnings below
- [ ] No
- [ ] Unknown

```
# Paste selector warnings here, e.g.:
# ⚠️ Low-confidence selector: using text "Submit" (no id or accessibilityLabel available)
```

---

## 7. Network Context

| Field | Value |
|---|---|
| **Proxyman baseline count** | *(from `start_recording_session` readiness)* |
| **Network events captured** | *(total from `stop_and_compile_test`)* |
| **filterDomains used?** | *(list or none)* |
| **WireMock stubs generated?** | *(yes / no, count if yes)* |

---

## 8. Additional Context

*(Any other information that might help: screenshots, app state, recent code changes, etc.)*

---

> **Minimum viable report**: If you can't fill everything, sections **1**, **3**, **4**, and **5d** (stderr logs) are the most critical for debugging.
