---
name: generate_mcp_curls
description: Use the mobile-automator-mcp tools via cURL while the MCP server is blocked from local installation. Covers starting the HTTP bridge, JSON-RPC request/response shape, all 18 tool signatures, session lifecycle patterns, and debugging.
---

# Using mobile-automator-mcp via the local HTTP bridge

## When to use this skill

The `mobile-automator-mcp` server is currently blocked from MCP client installation at the organization level. This skill lets agents still invoke its 18 tools (simulator control, UI automation, network capture, test synthesis) by hitting a **lightweight localhost JSON-RPC-over-HTTP bridge** that the project ships in `src/httpBridge.ts`.

Reach for this skill when:
- You need to run any `mobile-automator` tool and the MCP client is not connected.
- You see "MCP server blocked" or the tool list is missing `start_recording_session`, `run_test`, etc.
- You're writing a script or CI step that needs to drive simulators without an MCP client.

Once the MCP server is approved at the org level, stop using this skill — configure the MCP client normally and invoke the tools directly.

---

## 1. Start the HTTP bridge

From the project root (`mobile-automator-mcp/`):

```bash
npm run dev:http
```

This runs `MCP_TRANSPORT=http tsx watch src/index.ts`. The server logs should show:

```
[mobile-automator-mcp] HTTP bridge listening on http://127.0.0.1:3000 (18 tools)
[mobile-automator-mcp] POST /message for JSON-RPC, GET /health for liveness
```

**Port override:** `MCP_HTTP_PORT=4000 npm run dev:http`.

**Bind scope:** the bridge listens on `127.0.0.1` only. There is no auth — do not forward the port, reverse-proxy it, or run it on a shared machine.

### Verify it's up

```bash
curl http://localhost:3000/health
# → {"ok":true,"tools":18}
```

If `/health` doesn't return 200, the bridge isn't running. Check the terminal where you ran `npm run dev:http`.

---

## 2. Request envelope (JSON-RPC 2.0)

All tool calls are `POST /message` with this body shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "<tool_name>",
    "arguments": { /* tool-specific */ }
  }
}
```

Canonical example:

```bash
curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "list_devices",
      "arguments": { "platform": "ios", "state": "Booted" }
    }
  }'
```

`tools/list` is also supported and returns `{ tools: [{ name }, ...] }` for discovery.

---

## 3. Response envelope

**Success:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "<pretty-printed JSON>" }],
    "structuredContent": { /* typed tool output */ }
  }
}
```

Read `result.structuredContent` for programmatic access. `result.content[0].text` is a human-readable mirror.

**Error:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32602, "message": "Invalid arguments for tool execute_ui_action", "data": { "issues": [...] } }
}
```

| Code | Meaning | Typical fix |
|------|---------|-------------|
| `-32700` | Parse error (bad JSON) | Check quoting; validate with `jq .` |
| `-32600` | Invalid Request (missing `method`/`jsonrpc`) | Ensure body has `"jsonrpc":"2.0"` and `"method":"tools/call"` |
| `-32601` | Method not found | Only `tools/call` and `tools/list` are supported |
| `-32602` | Invalid params | See `error.data.issues` — Zod tells you which field is wrong |
| `-32603` | Internal error (handler threw) | Read `error.message`; tail the server stderr |

---

## 4. Tool reference (all 18)

Every tool below is invoked with `"method": "tools/call"` and `"params": { "name": "<tool>", "arguments": { ... } }`. Only required arguments are listed; optional fields are documented in [src/schemas.ts](../../../src/schemas.ts).

### Session recording

#### `start_recording_session`
Begin a recording session. Returns a `sessionId` to thread through later calls.
- **Required:** `appBundleId`, `platform` (`"ios"` | `"android"`)
- **Optional:** `sessionName`, `filterDomains`, `captureMode`, `pollingIntervalMs`, `settleTimeoutMs`, `trackEventPaths`, `timeouts`

```bash
curl -X POST http://localhost:3000/message -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"start_recording_session","arguments":{
    "appBundleId":"com.example.MyApp","platform":"ios","sessionName":"login_demo"
  }}
}'
```

#### `stop_and_compile_test`
End a session and synthesize a Maestro YAML test.
- **Required:** `sessionId`
- **Optional:** `outputPath`, `conditions`, `mockingConfig`

#### `get_session_timeline`
Mid-session health check: polling stats, interaction counts, gap analysis.
- **Required:** `sessionId`

#### `register_segment`
Register a session as a reusable, fingerprinted flow segment.
- **Required:** `name`, `sessionId`
- **Optional:** `registryPath`

### UI interaction

#### `get_ui_hierarchy`
Capture the current UI element tree. Auto-targets the sole booted device if `sessionId` is omitted.
- **Required:** none (use `sessionId` if inside a session)
- **Optional:** `sessionId`, `interactiveOnly`, `compact`, `includeRawOutput`, `artifactPath`

#### `execute_ui_action`
Dispatch a tap / type / scroll / swipe. Selector priority: `point > id > accessibilityLabel > text > bounds`.
- **Required:** `sessionId`, `action`, `element`
- **Optional:** `textInput` (required when `action: "type"`)

```bash
curl -X POST http://localhost:3000/message -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"execute_ui_action","arguments":{
    "sessionId":"<SID>","action":"tap","element":{"accessibilityLabel":"LoginButton"}
  }}
}'
```

Use `point` as an escape hatch for custom controls (e.g. Bureau tabs) that
ignore accessibility-based taps even when present in the hierarchy:

```bash
curl -X POST http://localhost:3000/message -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"execute_ui_action","arguments":{
    "sessionId":"<SID>","action":"tap","element":{"point":{"x":201,"y":186}}
  }}
}'
```

#### `take_screenshot`
Write a PNG of the current simulator/emulator screen.
- **Required:** `platform`, `deviceUdid`
- **Optional:** `outputPath`, `timeoutMs`

### Network

#### `get_network_logs`
Retrieve intercepted HTTP/HTTPS transactions from Proxyman.
- **Required:** `sessionId`
- **Optional:** `filterPath`, `filterDomains`, `limit`

#### `verify_sdui_payload`
Assert an SDUI response matches expected fields.
- **Required:** `sessionId`, `url`
- **Optional:** `filterDomains`, `expectedFields`

### Devices & simulators

#### `list_devices`
List iOS simulators and Android emulators. Use this to discover UDIDs.
- **Required:** none
- **Optional:** `platform`, `state`, `osVersionContains`

#### `boot_simulator`
Boot an iOS simulator by UDID (Android booting is not supported).
- **Required:** `platform`, `deviceUdid`
- **Optional:** `openSimulatorApp`, `timeoutMs`

### Flows

#### `list_flows`
Discover named Maestro flows in a flows directory.
- **Required:** none
- **Optional:** `flowsDir` (default: `./flows`)

#### `run_flow`
Execute a named flow with merged params.
- **Required:** `name`
- **Optional:** `flowsDir`, `params`, `platform`, `debugOutput`, `stubsDir`, `stubServerPort`

### Test execution

#### `run_test`
Run a Maestro YAML test file, optionally with WireMock stub replay and profiling.
- **Required:** `yamlPath`
- **Optional:** `debugOutput`, `stubsDir`, `platform`, `stubServerPort`, `env`, `profiling`

#### `run_unit_tests`
Run unit tests (iOS: `xcodebuild test`; Android: `./gradlew test<Variant>UnitTest`).
- **Required:** `platform`, plus `scheme` + (`workspacePath` | `projectPath`) on iOS, or `projectPath` on Android
- **Optional:** `destination`, `configuration`, `testPlan`, `onlyTesting`, `module`, `variant`, `gradleTask`, `testFilter`, `timeoutMs`

### Build lifecycle

#### `build_app`
Compile iOS (`xcodebuild`) or Android (`./gradlew assemble<Variant>`).
- **Required:** `platform`, plus `scheme` + (`workspacePath` | `projectPath`) on iOS, or `projectPath` on Android
- **Optional:** `configuration`, `destination`, `derivedDataPath`, `module`, `variant`, `timeoutMs`

#### `install_app`
Install a built `.app`/`.apk` onto a booted device.
- **Required:** `platform`, `deviceUdid`, `appPath`

#### `uninstall_app`
Remove an installed app, wiping storage.
- **Required:** `platform`, `deviceUdid`, `bundleId`

---

## 5. Session lifecycle (the canonical pattern)

Most workflows thread a `sessionId` through multiple calls. The pattern:

1. **`start_recording_session`** → capture `result.structuredContent.sessionId`
2. **(loop)** `get_ui_hierarchy` → inspect → `execute_ui_action` → repeat
3. **(optional)** `get_network_logs` / `verify_sdui_payload` for network assertions
4. **`stop_and_compile_test`** with the same `sessionId` → get a YAML path back
5. **(optional)** `register_segment` to save it for deduplication

`sessionId` is opaque (a UUID). Parse it out of step 1's response with `jq -r '.result.structuredContent.sessionId'`, then substitute into every subsequent call.

**Readiness gate:** step 1's response also includes `readiness.{driverReady, baselineCaptured, pollerStarted}`. Wait for all three before the first UI action — if `pollerStarted` is false, touch inference won't work.

---

## 6. Common workflows

### Run an existing flow

```bash
# 1. Discover flows
curl -s -X POST http://localhost:3000/message -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"list_flows","arguments":{}}
}' | jq '.result.structuredContent.flows[].name'

# 2. Run one
curl -X POST http://localhost:3000/message -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":2,"method":"tools/call",
  "params":{"name":"run_flow","arguments":{"name":"login","platform":"ios"}}
}'
```

### Build + install + screenshot

```bash
# 1. Build
curl -X POST http://localhost:3000/message ... "name":"build_app" ...  # capture result.appPath, result.bundleId

# 2. Boot (if not already)
curl -X POST http://localhost:3000/message ... "name":"list_devices" ...  # find a Shutdown iOS UDID
curl -X POST http://localhost:3000/message ... "name":"boot_simulator" ...

# 3. Install
curl -X POST http://localhost:3000/message ... "name":"install_app" ...

# 4. Screenshot
curl -X POST http://localhost:3000/message ... "name":"take_screenshot" ...  # returns imagePath
```

### Record a new test end-to-end

```bash
SID=$(curl -s -X POST http://localhost:3000/message -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"start_recording_session","arguments":{
    "appBundleId":"com.example.MyApp","platform":"ios"
  }}
}' | jq -r '.result.structuredContent.sessionId')

# ... execute_ui_action calls using $SID ...

curl -X POST http://localhost:3000/message -H 'Content-Type: application/json' -d "{
  \"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",
  \"params\":{\"name\":\"stop_and_compile_test\",\"arguments\":{
    \"sessionId\":\"$SID\",\"outputPath\":\"/tmp/login-test.yaml\"
  }}
}"
```

### Run unit tests

```bash
curl -X POST http://localhost:3000/message -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"run_unit_tests","arguments":{
    "platform":"ios","workspacePath":"/path/MyApp.xcworkspace","scheme":"MyAppTests"
  }}
}'
```

---

## 7. Debugging

- **`/health` returns nothing** — the bridge isn't running. Start `npm run dev:http`.
- **`error.code: -32602`** — check `error.data.issues` for the Zod field path. Common slip: missing required arg (e.g., `sessionId`, `scheme`).
- **`error.code: -32603`** — the tool handler threw. Read `error.message` and tail the server terminal (handlers log to stderr with a `[MCP]` prefix).
- **"No booted ios simulator found"** — call `list_devices` → pick a UDID → `boot_simulator` before recording.
- **Session ID lost** — `stop_and_compile_test` fails with "Session not found". You only get the `sessionId` once, from `start_recording_session`'s response; capture it immediately.
- **Tool hangs** — long-running tools (`build_app`, `run_unit_tests`) have multi-minute timeouts by default. Override via `timeoutMs` if needed.

---

## 8. Quick boilerplate generator

For a copy-paste list of all 18 tools with placeholder arguments:

```bash
npx tsx .github/skills/generate_mcp_curls/generate.ts
```

Override the target URL: `MCP_URL="http://localhost:4000/message" npx tsx .github/skills/generate_mcp_curls/generate.ts`.

Edit the `toolDefaults` map in [generate.ts](generate.ts) if you want different placeholder values baked in.

---

## 9. Transition plan

When the MCP server is approved at the org level:

1. Configure the MCP client (e.g., add `mobile-automator-mcp` to the Claude Code MCP config).
2. Stop the HTTP bridge (`Ctrl+C` on the `npm run dev:http` terminal).
3. Use the tools directly — the MCP client will invoke the same handlers via stdio.

The HTTP bridge stays in the repo but is inert without `MCP_TRANSPORT=http`. Optionally delete this skill and the bridge when no one needs the fallback anymore.
