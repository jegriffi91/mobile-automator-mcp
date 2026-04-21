/**
 * Lightweight JSON-RPC-over-HTTP bridge.
 *
 * Exists so developers can invoke the MCP tools via `curl` while the
 * `mobile-automator-mcp` server is blocked from installation at the
 * org level. Binds to 127.0.0.1 only — there is no auth.
 *
 * Protocol: JSON-RPC 2.0, single request/response per POST.
 * Supports `tools/call` (the only method agents need). No SSE,
 * no session headers, no `initialize` handshake.
 */

import http from 'http';
import type { ZodTypeAny } from 'zod';

import {
    StartRecordingInputSchema,
    StopAndCompileInputSchema,
    GetUIHierarchyInputSchema,
    ExecuteUIActionInputSchema,
    GetNetworkLogsInputSchema,
    VerifySDUIPayloadInputSchema,
    RegisterSegmentInputSchema,
    RunTestInputSchema,
    ListDevicesInputSchema,
    GetSessionTimelineInputSchema,
    ListFlowsInputSchema,
    RunFlowInputSchema,
    BuildAppInputSchema,
    InstallAppInputSchema,
    UninstallAppInputSchema,
    BootSimulatorInputSchema,
    TakeScreenshotInputSchema,
    RunUnitTestsInputSchema,
    TOOL_NAMES,
} from './schemas.js';

import {
    handleStartRecording,
    handleStopAndCompile,
    handleGetUIHierarchy,
    handleExecuteUIAction,
    handleGetNetworkLogs,
    handleVerifySDUIPayload,
    handleRegisterSegment,
    handleRunTest,
    handleListDevices,
    handleGetSessionTimeline,
    handleListFlows,
    handleRunFlow,
    handleBuildApp,
    handleInstallApp,
    handleUninstallApp,
    handleBootSimulator,
    handleTakeScreenshot,
    handleRunUnitTests,
} from './handlers.js';

type ToolEntry = {
    schema: ZodTypeAny;
    handler: (args: any) => Promise<unknown>;
};

const tools: Record<string, ToolEntry> = {
    [TOOL_NAMES.START_RECORDING]: { schema: StartRecordingInputSchema, handler: handleStartRecording },
    [TOOL_NAMES.STOP_AND_COMPILE]: { schema: StopAndCompileInputSchema, handler: handleStopAndCompile },
    [TOOL_NAMES.GET_UI_HIERARCHY]: { schema: GetUIHierarchyInputSchema, handler: handleGetUIHierarchy },
    [TOOL_NAMES.EXECUTE_UI_ACTION]: { schema: ExecuteUIActionInputSchema, handler: handleExecuteUIAction },
    [TOOL_NAMES.GET_NETWORK_LOGS]: { schema: GetNetworkLogsInputSchema, handler: handleGetNetworkLogs },
    [TOOL_NAMES.VERIFY_SDUI_PAYLOAD]: { schema: VerifySDUIPayloadInputSchema, handler: handleVerifySDUIPayload },
    [TOOL_NAMES.REGISTER_SEGMENT]: { schema: RegisterSegmentInputSchema, handler: handleRegisterSegment },
    [TOOL_NAMES.RUN_TEST]: { schema: RunTestInputSchema, handler: handleRunTest },
    [TOOL_NAMES.LIST_DEVICES]: { schema: ListDevicesInputSchema, handler: handleListDevices },
    [TOOL_NAMES.GET_SESSION_TIMELINE]: { schema: GetSessionTimelineInputSchema, handler: handleGetSessionTimeline },
    [TOOL_NAMES.LIST_FLOWS]: { schema: ListFlowsInputSchema, handler: handleListFlows },
    [TOOL_NAMES.RUN_FLOW]: { schema: RunFlowInputSchema, handler: handleRunFlow },
    [TOOL_NAMES.BUILD_APP]: { schema: BuildAppInputSchema, handler: handleBuildApp },
    [TOOL_NAMES.INSTALL_APP]: { schema: InstallAppInputSchema, handler: handleInstallApp },
    [TOOL_NAMES.UNINSTALL_APP]: { schema: UninstallAppInputSchema, handler: handleUninstallApp },
    [TOOL_NAMES.BOOT_SIMULATOR]: { schema: BootSimulatorInputSchema, handler: handleBootSimulator },
    [TOOL_NAMES.TAKE_SCREENSHOT]: { schema: TakeScreenshotInputSchema, handler: handleTakeScreenshot },
    [TOOL_NAMES.RUN_UNIT_TESTS]: { schema: RunUnitTestsInputSchema, handler: handleRunUnitTests },
};

// JSON-RPC 2.0 error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
    return { jsonrpc: '2.0', id, result };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

async function dispatch(toolName: string, args: unknown): Promise<unknown> {
    const entry = tools[toolName];
    if (!entry) {
        const known = Object.keys(tools).join(', ');
        throw new JsonRpcDispatchError(
            INVALID_PARAMS,
            `Unknown tool: ${toolName}`,
            { knownTools: known.split(', ') },
        );
    }

    const parsed = entry.schema.safeParse(args ?? {});
    if (!parsed.success) {
        throw new JsonRpcDispatchError(
            INVALID_PARAMS,
            `Invalid arguments for tool ${toolName}`,
            { issues: parsed.error.issues },
        );
    }

    const result = await entry.handler(parsed.data);

    // Mirror the stdio response envelope so clients can rely on the same shape.
    return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
    };
}

class JsonRpcDispatchError extends Error {
    constructor(public code: number, message: string, public data?: unknown) {
        super(message);
    }
}

async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw: string;
    try {
        raw = await readBody(req);
    } catch (err) {
        send(res, 400, jsonRpcError(null, PARSE_ERROR, 'Failed to read request body', String(err)));
        return;
    }

    let body: any;
    try {
        body = JSON.parse(raw);
    } catch {
        send(res, 400, jsonRpcError(null, PARSE_ERROR, 'Invalid JSON'));
        return;
    }

    const id: JsonRpcId = body?.id ?? null;

    if (body?.jsonrpc !== '2.0' || typeof body?.method !== 'string') {
        send(res, 400, jsonRpcError(id, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 request with a "method" string'));
        return;
    }

    try {
        if (body.method === 'tools/call') {
            const name = body.params?.name;
            if (typeof name !== 'string') {
                send(res, 400, jsonRpcError(id, INVALID_PARAMS, 'Missing "params.name"'));
                return;
            }
            const result = await dispatch(name, body.params?.arguments ?? {});
            send(res, 200, jsonRpcResult(id, result));
            return;
        }

        if (body.method === 'tools/list') {
            const list = Object.keys(tools).map((name) => ({ name }));
            send(res, 200, jsonRpcResult(id, { tools: list }));
            return;
        }

        send(res, 404, jsonRpcError(id, METHOD_NOT_FOUND, `Unsupported method: ${body.method}. Use "tools/call".`));
    } catch (err) {
        if (err instanceof JsonRpcDispatchError) {
            send(res, 400, jsonRpcError(id, err.code, err.message, err.data));
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        send(res, 500, jsonRpcError(id, INTERNAL_ERROR, message));
    }
}

export async function startHttpBridge(): Promise<void> {
    const port = parseInt(process.env.MCP_HTTP_PORT ?? '3000', 10);
    const host = '127.0.0.1';

    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            send(res, 200, { ok: true, tools: Object.keys(tools).length });
            return;
        }
        if (req.method === 'POST' && req.url === '/message') {
            void handleMessage(req, res);
            return;
        }
        send(res, 404, { error: 'Not found. Use POST /message or GET /health.' });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve();
        });
    });

    console.error(
        `[mobile-automator-mcp] HTTP bridge listening on http://${host}:${port} (${Object.keys(tools).length} tools)`,
    );
    console.error('[mobile-automator-mcp] POST /message for JSON-RPC, GET /health for liveness');
}
