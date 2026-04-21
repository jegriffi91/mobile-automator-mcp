import { TOOL_NAMES } from '../../../src/schemas.js';

const MCP_URL = process.env.MCP_URL || 'http://localhost:3000/message';

// Default mock parameters for generating valid JSON-RPC payloads.
// Replace placeholder values (sessionId, deviceUdid, paths, bundle ids) with
// real ones from your environment before sending the commands.
const toolDefaults: Record<string, any> = {
    [TOOL_NAMES.START_RECORDING]: {
        appBundleId: 'com.example.MyApp',
        platform: 'ios',
        sessionName: 'demo_session',
    },
    [TOOL_NAMES.STOP_AND_COMPILE]: {
        sessionId: 'session_123abc',
        outputPath: '/tmp/generated-test.yaml',
    },
    [TOOL_NAMES.GET_UI_HIERARCHY]: {
        sessionId: 'session_123abc',
        interactiveOnly: true,
    },
    [TOOL_NAMES.EXECUTE_UI_ACTION]: {
        sessionId: 'session_123abc',
        action: 'tap',
        element: { accessibilityLabel: 'LoginButton' },
    },
    [TOOL_NAMES.GET_NETWORK_LOGS]: {
        sessionId: 'session_123abc',
        limit: 50,
    },
    [TOOL_NAMES.VERIFY_SDUI_PAYLOAD]: {
        sessionId: 'session_123abc',
        url: 'https://api.example.com/login',
        expectedFields: { ok: true },
    },
    [TOOL_NAMES.REGISTER_SEGMENT]: {
        sessionId: 'session_123abc',
        name: 'login_flow',
    },
    [TOOL_NAMES.RUN_TEST]: {
        yamlPath: '/tmp/generated-test.yaml',
        platform: 'ios',
    },
    [TOOL_NAMES.LIST_DEVICES]: {
        platform: 'ios',
        state: 'Booted',
    },
    [TOOL_NAMES.GET_SESSION_TIMELINE]: {
        sessionId: 'session_123abc',
    },
    [TOOL_NAMES.LIST_FLOWS]: {
        flowsDir: './flows',
    },
    [TOOL_NAMES.RUN_FLOW]: {
        name: 'login',
        flowsDir: './flows',
        platform: 'ios',
        params: { USERNAME: 'demo@example.com' },
    },
    [TOOL_NAMES.BUILD_APP]: {
        platform: 'ios',
        workspacePath: '/absolute/path/to/MyApp.xcworkspace',
        scheme: 'MyApp',
        configuration: 'Debug',
    },
    [TOOL_NAMES.INSTALL_APP]: {
        platform: 'ios',
        deviceUdid: 'REPLACE_WITH_UDID',
        appPath: '/absolute/path/to/MyApp.app',
    },
    [TOOL_NAMES.UNINSTALL_APP]: {
        platform: 'ios',
        deviceUdid: 'REPLACE_WITH_UDID',
        bundleId: 'com.example.MyApp',
    },
    [TOOL_NAMES.BOOT_SIMULATOR]: {
        platform: 'ios',
        deviceUdid: 'REPLACE_WITH_UDID',
        openSimulatorApp: true,
    },
    [TOOL_NAMES.TAKE_SCREENSHOT]: {
        platform: 'ios',
        deviceUdid: 'REPLACE_WITH_UDID',
        outputPath: '/tmp/screen.png',
    },
    [TOOL_NAMES.RUN_UNIT_TESTS]: {
        platform: 'ios',
        workspacePath: '/absolute/path/to/MyApp.xcworkspace',
        scheme: 'MyAppTests',
    },
};

const generateCurl = (method: string, params: any): string => {
    const payload = {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 10000),
        method: 'tools/call',
        params: {
            name: method,
            arguments: params,
        },
    };

    return `curl -X POST ${MCP_URL} \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(payload, null, 2)}'`;
};

console.log(`\n======================================================`);
console.log(`📡 MCP Mobile Automator cURL Generator `);
console.log(`URL: ${MCP_URL}`);
console.log(`Tools: ${Object.keys(toolDefaults).length}`);
console.log(`======================================================\n`);

for (const [toolName, defaultParams] of Object.entries(toolDefaults)) {
    console.log(`\n### ${toolName.toUpperCase()} ###`);
    console.log(generateCurl(toolName, defaultParams));
    console.log('\n---\n');
}

console.log(`To change the URL, run with: MCP_URL="http://your-server/message" npx tsx generate.ts`);
