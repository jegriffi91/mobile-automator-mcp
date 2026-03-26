---
name: generate_mcp_curls
description: Skill to generate cURL requests for all available tools in the mobile-automator MCP server
---

# Generate MCP cURLs Skill

This skill allows GitHub Copilot (or other agents) to programmatically generate boilerplate `curl` commands for the `mobile-automator-mcp` tools. The generated cURLs use the JSON-RPC 2.0 format compatible with standard HTTP-hosted MCP servers.

## Problem it Solves
If local MCP servers are blocked by enterprise restrictions, you can host the MCP server remotely or via an HTTP proxy. This skill outputs the necessary valid cURL payload formats without needing to look up the arguments for each tool manually.

## Usage

To generate the cURL commands for all tools, simply execute the `generate.ts` script using `tsx` from the project root:

```bash
npx tsx .github/skills/generate_mcp_curls/generate.ts
```

### Overriding the Server URL
By default, the script generates cURLs pointing to `http://localhost:3000/message`.
You can customize the HTTP endpoint URL by supplying the `MCP_URL` environment variable:

```bash
MCP_URL="https://mcp.yourcompany.internal/message" npx tsx .github/skills/generate_mcp_curls/generate.ts
```

## Available Tool Payloads
The following tool payloads are implemented and output by the generator:
- `start_recording_session`
- `stop_and_compile_test`
- `get_ui_hierarchy`
- `execute_ui_action`
- `get_network_logs`
- `verify_sdui_payload`
- `register_segment`
- `run_test`
- `list_devices`
- `get_session_timeline`

## Modifying Defaults
If you need specific IDs or data in the generated JSON, simply edit `toolDefaults` inside `.github/skills/generate_mcp_curls/generate.ts`.
