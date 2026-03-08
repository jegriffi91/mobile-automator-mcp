# Proxyman Integration Setup

Reference guide for capturing iOS Simulator HTTP traffic with Proxyman and the mobile-automator MCP tools.

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Proxyman** | macOS app installed and running |
| **Proxyman CLI** | Ships with Proxyman at `/Applications/Proxyman.app/Contents/MacOS/proxyman-cli` |
| **iOS Simulator** | Booted with Proxyman certificate installed and trusted |

---

## iOS Simulator Setup

### 1. Install & Trust Proxyman Certificate

In Proxyman:  
**Certificate** → **Install Certificate on iOS** → **Simulator**

This installs the root CA and configures the simulator to trust it. Must be done per simulator device.

### 2. Verify System Proxy

Proxyman sets the system HTTP proxy to `127.0.0.1:9090`. Verify:

```bash
networksetup -getwebproxy Wi-Fi
# → Enabled: Yes, Server: 127.0.0.1, Port: 9090
```

The simulator shares the host Mac's network stack, so this proxy applies automatically.

---

## The localhost Problem

> [!CAUTION]
> iOS `URLSession` and the macOS network stack **bypass the system HTTP proxy** for `localhost` and `127.0.0.1`. Traffic to these addresses will never appear in Proxyman.

### Solution: `localhost.proxyman.io`

Proxyman provides a DNS alias that resolves to `127.0.0.1` but forces traffic through the proxy:

```
http://localhost.proxyman.io:<port>
```

Use this instead of `http://localhost:<port>` in your app's base URL. The traffic reaches the same local server but Proxyman can intercept it.

Reference: [Proxyman Troubleshooting — Localhost](https://docs.proxyman.com/troubleshooting/couldnt-see-any-request-from-localhost-server)

---

## iOS App Configuration

### App Transport Security (Info.plist)

Since `localhost.proxyman.io` is an external domain, ATS blocks plain HTTP to it by default. Add both:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSExceptionDomains</key>
    <dict>
        <key>localhost.proxyman.io</key>
        <dict>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <true/>
            <key>NSIncludesSubdomains</key>
            <true/>
        </dict>
    </dict>
</dict>
```

| Key | Purpose |
|---|---|
| `NSAllowsLocalNetworking` | Permits HTTP to `localhost` / `127.0.0.1` (fallback when Proxyman is off) |
| `NSExceptionDomains` | Permits HTTP to `localhost.proxyman.io` (for Proxyman capture) |

### Base URL Configuration

Centralize the server URL so it's easy to toggle:

```swift
enum ServerConfig {
    static let baseURL = URL(string: "http://localhost.proxyman.io:3030")!
}
```

> [!TIP]
> When Proxyman is not running, `localhost.proxyman.io` still resolves to `127.0.0.1`, so the app continues to work — it just won't be proxied.

---

## Local Test Server

The server must bind to `0.0.0.0` (not just `localhost`) to accept connections via the DNS alias:

```javascript
app.listen(PORT, '0.0.0.0', () => { ... });
```

---

## MCP Tool Usage

### `get_network_logs`

```
filterDomains: ["localhost.proxyman.io"]
```

> [!NOTE]
> The `proxyman-cli export-log -m domains` filter may not match traffic on non-standard ports. Use `-m all` and filter in your code if the domains filter returns empty.

### `verify_sdui_payload`

```
url: "http://localhost.proxyman.io:3030/api/your-endpoint"
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No traffic in Proxyman | Verify using `localhost.proxyman.io`, not `localhost` |
| ATS error / connection refused | Add `NSExceptionDomains` entry in `Info.plist` |
| Certificate error | Reinstall Proxyman cert on the simulator |
| `export-log` "nothing to export" | Use `-m all` instead of `-m domains` |
| Server not reachable via alias | Ensure server binds to `0.0.0.0`, not `127.0.0.1` |
| App still uses mock data | Check for explicit `.environment()` overrides in the app entry point |
