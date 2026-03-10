# Getting Started Guide

Welcome to the **Mobile Automator MCP Server**! This guide will walk you through setting up all the necessary tools and environment dependencies to get this MCP server running locally.

## Prerequisite Tools

Before you can start recording and generating UI automation tests, you need to install the following software.

### 1. Node.js
The Mobile Automator MCP server is built with Node.js and requires **version 20 or higher**.

- **Download**: [nodejs.org](https://nodejs.org/)
- **Verify**:
  ```bash
  node -v
  # Should output v20.x.x or higher
  ```

### 2. Java (OpenJDK 11+)
Maestro relies on Java to interact with Android devices and simulators. You must have **Java 11 or higher** installed.

- **Option A (Homebrew)**:
  ```bash
  brew install openjdk@17
  ```
- **Option B (Direct Download)**: Download from [Adoptium](https://adoptium.net/) or use any standard JDK distribution.
- **Verify**:
  ```bash
  java -version
  # Should output 11.x, 17.x, 21.x, etc.
  ```

### 3. Maestro CLI
Maestro is the core engine we use for UI interaction and hierarchy capture.

- **Install via terminal**:
  ```bash
  curl -Ls "https://get.maestro.mobile.dev" | bash
  ```
- **Verify**:
  ```bash
  maestro --version
  ```
- **Note**: Ensure the Maestro binary is accessible in your system `$PATH` so the MCP server can execute it.

### 4. Proxyman
Proxyman is used to intercept network traffic, allowing the MCP server to capture API calls and generate WireMock stubs.

- **Download**: **macOS 5.20+** is required. [Download Proxyman](https://proxyman.io/).
- **Setup CLI**: Proxyman's CLI tool (`proxyman-cli`) must be installed and configured. 
- **Important**: Please follow the detailed [Proxyman Setup Guide](./proxyman-setup.md) to ensure certificates and proxy settings are correctly configured for your simulators.

### 5. Mobile Simulator / Emulator
You will need a device to run your app on.
- **iOS**: Install Xcode and boot an iOS Simulator.
- **Android**: Install Android Studio and boot an Android Virtual Device (AVD).

---

## Installation & Build

Once your system has the required tools, you can clone and build the MCP Server:

1. **Clone the repository**:
   ```bash
   git clone <repository-url> mobile-automator-mcp
   cd mobile-automator-mcp
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the project**:
   ```bash
   npm run build
   ```
   *This compiles the TypeScript source code into the `dist/` folder.*

---

## Connecting to an MCP Client

To use the tools, you must register the Mobile Automator MCP server with an AI Client (like Claude Desktop, Gemini Code Assist, Cursor, etc.).

Add the following configuration to your MCP client's settings:

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

*Note: Replace `/absolute/path/to/mobile-automator-mcp` with the actual path on your local machine.*

---

## Next Steps

- Check out the [Architecture](./architecture.md) document to understand how Maestro and Proxyman are orchestrated.
- Read through the [Showcase](./showcase.md) to see examples of the AI-driven test creation workflow.
