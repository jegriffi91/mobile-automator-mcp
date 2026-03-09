# Mobile Automator MCP Server

An [MCP](https://modelcontextprotocol.io/) server that gives AI agents the power to **record**, **replay**, and **mock** mobile app interactions — combining [Maestro](https://maestro.mobile.dev/) UI automation with [Proxyman](https://proxyman.io/) network capture to generate complete, self-contained test scripts.

## Architecture

![Recording synthesis flow](docs/images/detailed-user-flow.png)

The system orchestrates two async data streams — **UI interactions** (via Maestro) and **HTTP traffic** (via Proxyman) — then correlates them by timestamp to produce Maestro YAML + WireMock stubs for full experience replay.

## Capabilities

| Capability | Description |
|---|---|
| **UI Recording** | Dispatch taps, types, scrolls, swipes on iOS/Android simulators via Maestro |
| **Network Capture** | Intercept HTTP/HTTPS traffic through Proxyman with scoped, session-aware exports |
| **Correlation** | Automatically match UI actions to the network requests they trigger (sliding time window) |
| **YAML Synthesis** | Generate Maestro test scripts with inline network context comments |
| **WireMock Stubs** | Produce WireMock-compatible `mappings/` + `__files/` for network replay |
| **Selective Mocking** | Mock all, some, or all-except-some APIs — unmocked routes proxy to the real server |
| **SDUI Validation** | Deep-compare server-driven UI payloads against expected JSON shapes |

## Tools

| Tool | Purpose |
|---|---|
| `start_recording_session` | Begin recording — snapshots Proxyman baseline, initializes session state |
| `execute_ui_action` | Dispatch a UI action and log it to the session |
| `get_ui_hierarchy` | Capture the current accessibility tree from the simulator |
| `get_network_logs` | Fetch intercepted HTTP traffic (with domain/path filtering) |
| `verify_sdui_payload` | Validate a network response against expected fields |
| `stop_and_compile_test` | Finalize session → export scoped HAR → correlate → generate YAML + WireMock stubs |

## Quick Start

### Prerequisites

- **Node.js** v20+
- **Maestro CLI** — `curl -Ls "https://get.maestro.mobile.dev" | bash`
- **Proxyman** macOS 5.20+ with CLI — see [Proxyman Setup](docs/proxyman-setup.md)
- A booted **iOS Simulator** or **Android Emulator**

### Install

```bash
git clone <repository>
cd mobile-automator-mcp
npm install
npm run build
```

### Register with an MCP Client

Add to your MCP client config (e.g., Claude Desktop, Gemini Code Assist):

```json
{
  "mcpServers": {
    "mobile-automator": {
      "command": "node",
      "args": ["/absolute/path/to/mobile-automator-mcp/dist/index.js"]
    }
  }
}
```

## Selective Mocking

The `stop_and_compile_test` tool accepts a `mockingConfig` to control which APIs are mocked vs. proxied to a real backend:

```
full      → Mock all captured APIs (default, no real server needed)
include   → Mock only listed routes, proxy everything else
exclude   → Mock everything EXCEPT listed routes
```

**Example** — mock only login, proxy everything else:
```json
{
  "mockingConfig": {
    "mode": "include",
    "routes": ["/api/login"],
    "proxyBaseUrl": "http://localhost:3030"
  }
}
```

## Output Structure

```
session-<id>/
├── wiremock/
│   ├── mappings/           ← WireMock stub JSON files
│   │   ├── post_api_login.json
│   │   ├── get_api_lore_doom.json
│   │   └── _proxy_fallback.json   ← (include/exclude modes only)
│   └── __files/            ← Response body fixtures
│       ├── post_api_login_response.json
│       └── get_api_lore_doom_response.json
└── manifest.json           ← Session metadata + route manifest
```

## Project Structure

```
src/
├── index.ts              ← MCP server entry point
├── handlers.ts           ← Tool handler implementations
├── schemas.ts            ← Zod schemas (single source of truth for I/O)
├── types.ts              ← Domain models
├── session/              ← Session lifecycle + SQLite persistence
├── maestro/              ← Maestro CLI wrapper + hierarchy parser
├── proxyman/             ← Proxyman CLI wrapper + payload validator
└── synthesis/            ← Correlator + YAML generator + WireMock stub writer
```

## Development

```bash
npm test            # Run tests
npm run test:watch  # Watch mode
npm run build       # Compile TypeScript
npm start           # Start server (stdio)
npm run lint        # ESLint
```

## License

MIT
