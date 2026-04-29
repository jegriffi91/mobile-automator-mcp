---
name: mock-variant-testing
description: Pattern for validating app behavior across multiple mocked API response variants using run_feature_test or scripted bash loops via the HTTP bridge. Avoids the per-variant LLM-inference tax.
---

# Mock Variant Testing

Use this skill when the user needs to validate behavior across **multiple values of the same API field** — different `loginStatus` codes, feature-flag states, error conditions, etc.

The temptation is to loop in LLM turns: set mock → run flow → screenshot → clear → reset → next variant. For 6 variants that's 30–42 turns. **Don't.**

## Decision tree

```
How many variants?
├── 1–2  → run_feature_test, one call per variant (best when you also need network assertions)
├── 3+ with identical structure → script via HTTP bridge (bash loop, zero per-variant LLM cost)
└── Need screenshots as evidence?
    ├── Yes → bash loop with `xcrun simctl io booted screenshot` between variants
    └── No  → run_feature_test alone is enough
```

## Pattern A — `run_feature_test` (1–2 variants)

One tool call per variant. Network assertions live inside the spec.

```json
{
  "spec": {
    "name": "Test RHINOBOOT intercept",
    "appBundleId": "com.example.App",
    "setup": [{ "flow": "full-signin" }],
    "mocks": [{
      "matcher": { "graphqlQueryName": "CustomerStatusQuery" },
      "responseTransform": {
        "jsonPatch": [
          { "op": "replace",
            "path": "/data/customerStatusV3/loginStatus",
            "value": "RHINOBOOT" }
        ]
      }
    }],
    "actions": [
      { "assertVisible": { "text": "unable to bill" } }
    ],
    "assertions": [{
      "type": "on_screen",
      "expectedCalls": [{ "operationMatches": "CustomerStatusQuery" }]
    }]
  }
}
```

## Pattern B — Scripted bash loop (3+ variants)

Use [generate_mcp_curls](../generate_mcp_curls/SKILL.md) to build the curl commands, then wrap in bash. The agent writes the script once; the loop runs without further LLM inference.

**Prerequisites:**
- HTTP bridge running: `npm run dev:http` (listens on `127.0.0.1:3000`)
- Reusable navigation flow exists (e.g. `flows/full-signin.yaml`)
- Booted simulator (use `list_devices` to find a UDID)

```bash
#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ID="com.example.App"
FLOWS_DIR="/path/to/flows"
SCREENSHOT_DIR="/tmp/intercept-screenshots"
mkdir -p "$SCREENSHOT_DIR"

STATUSES=("OP2_INTERCEPT" "RHINOBOOT" "UPGRADE_REQUIRED" "SUPPORT_REQUIRED" "TERMS_NOT_ACCEPTED")

for STATUS in "${STATUSES[@]}"; do
  echo "=== Testing $STATUS ==="

  # 1. Install standalone mock (no sessionId → persists through run_flow + screenshot)
  curl -s -X POST http://localhost:3000/message \
    -H 'Content-Type: application/json' \
    -d "{
      \"jsonrpc\": \"2.0\", \"id\": 1,
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"set_mock_response\",
        \"arguments\": {
          \"mock\": {
            \"id\": \"variant-mock\",
            \"matcher\": { \"graphqlQueryName\": \"CustomerStatusQuery\" },
            \"responseTransform\": {
              \"jsonPatch\": [
                {\"op\":\"replace\",
                 \"path\":\"/data/customerStatusV3/loginStatus\",
                 \"value\":\"${STATUS}\"}
              ]
            }
          }
        }
      }
    }" > /dev/null

  # 2. Run sign-in flow
  curl -s -X POST http://localhost:3000/message \
    -H 'Content-Type: application/json' \
    -d "{
      \"jsonrpc\": \"2.0\", \"id\": 2,
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"run_flow\",
        \"arguments\": { \"name\": \"full-signin\", \"flowsDir\": \"${FLOWS_DIR}\" }
      }
    }" > /dev/null

  # 3. Capture evidence
  sleep 5
  xcrun simctl io booted screenshot "${SCREENSHOT_DIR}/${STATUS}.png"
  echo "  screenshot: ${SCREENSHOT_DIR}/${STATUS}.png"

  # 4. Clear standalone mock
  curl -s -X POST http://localhost:3000/message \
    -H 'Content-Type: application/json' \
    -d '{
      "jsonrpc":"2.0","id":3,
      "method":"tools/call",
      "params":{"name":"clear_mock_responses","arguments":{"allStandalone":true}}
    }' > /dev/null

  # 5. Reset app state for next variant
  xcrun simctl terminate booted "$BUNDLE_ID" || true
  sleep 2
  xcrun simctl launch booted "$BUNDLE_ID"
  sleep 5
done

echo "Done. Screenshots in $SCREENSHOT_DIR"
```

After the loop completes, the LLM reviews the screenshots — **one** turn for N variants of evidence.

## Key principles

1. **Never let the LLM loop over identical-shape variants.** A bash loop is O(1) LLM turns vs O(N).
2. **Mocks install BEFORE setup flows.** `run_feature_test` does this correctly. Manual orchestration must use **standalone** mocks (no `sessionId`) installed before `run_flow`.
3. **App reset between variants.** Some intercept screens have no clean exit path. `terminate + launch` is the only reliable reset.
4. **Standalone mocks** (omit `sessionId` from `set_mock_response`) are the right scope here — they survive across flow runs and screenshots, and `clear_mock_responses { allStandalone: true }` cleans up at the end.
5. **One reusable flow per navigation path.** The bash loop calls `run_flow` against a single `flows/full-signin.yaml`. Don't inline navigation into the loop.

## When `run_feature_test` doesn't fit

The composite tool today does **not** support:
- `screenshot` as an action (you must call `take_screenshot` separately)
- `terminateApp` / `launchApp` actions (use the bash loop's reset block)
- A `matrix` field for fanning out one spec across multiple values

If you need any of those, fall back to Pattern B.

## Token cost (rough order of magnitude for 6 variants)

| Approach | LLM turns | Reliability |
|---|---|---|
| Manual orchestration in LLM loop | ~45 | Medium (driver flake compounds) |
| `run_feature_test` × 6 | ~8 | Medium |
| Bash loop via HTTP bridge | ~3 | High (CLI-only paths) |
