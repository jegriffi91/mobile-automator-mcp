# AI Mobile Test Automation MCP Server

An MCP (Model Context Protocol) server that empowers LLMs to dynamically generate stateful, SDUI-aware mobile test scripts. It orchestrates [Maestro](https://maestro.mobile.dev/) for UI automation and [Proxyman](https://proxyman.io/) for network validation.

## Features

- **UI Orchestration via Maestro**: Navigate mobile apps dynamically (iOS focus, Android supported). The server dumps the UI hierarchy, translates an LLM's intended action into a single-step Maestro YAML, and executes it.
- **Network Interception via Proxyman**: Captures live HTTP/HTTPS traffic during the session (using `proxyman-cli` HAR export). Filtering ensures only relevant API calls are tracked.
- **SDUI Validation**: Validates dynamic Server-Driven UI network payloads against expected shapes, with deep-compare reporting for arrays, nested objects, and missing keys.
- **Synthesis & YAML Generation**: Correlates recorded UI interactions with subsequent network events using a sliding time window. It synthesizes a complete, declarative Maestro YAML test script complete with `evalScript` network assertions for execution in CI.

## Prerequisites

1. **Node.js** v20+
2. **Maestro CLI**: `curl -Ls "https://get.maestro.mobile.dev" | bash`
3. **Proxyman CLI**: `proxyman-cli` (requires Proxyman macOS 5.20+)
4. **Target Device**: A booted iOS Simulator (or Android Emulator).

## Quick Start
### 1. Repository Setup

```bash
git clone <repository>
cd mobile-automator-mcp
npm install
npm run build
```

### 2. Registering with an MCP Client (e.g. Claude Desktop)

Add the following to your MCP client config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mobile-automator": {
      "command": "node",
      "args": [
        "/absolute/path/to/mobile-automator-mcp/dist/index.js"
      ]
    }
  }
}
```

Restart your MCP Client.

## Tools Provided

This server provides the following tools to the LLM:

1. `start_recording_session`: Initializes a tracking session for a specific app (e.g., `com.example.app`).
2. `get_ui_hierarchy`: Dumps the current, pruned semantic UI tree from the active emulator.
3. `execute_ui_action`: Dispatches a UI action (tap, type, scroll) to a specific element and logs it.
4. `get_network_logs`: Fetches recent network traffic for the session (with optional domain filtering).
5. `verify_sdui_payload`: Deep-compares a specific network response against expected JSON shapes.
6. `stop_and_compile_test`: Finalizes the session, correlating UI taps with network calls, and outputs a complete Maestro YAML test file.

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint
npm run lint

# Build and start the server (stdio)
npm run build
npm start
```
