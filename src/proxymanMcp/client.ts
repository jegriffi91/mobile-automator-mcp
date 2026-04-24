/**
 * ProxymanMcpClient — thin wrapper around Proxyman's bundled stdio MCP server.
 *
 * Spawns `/Applications/Proxyman.app/Contents/MacOS/mcp-server` (path
 * configurable) as a child process and exposes typed methods for the subset of
 * Proxyman tools we need: rule CRUD, tool master-switch toggle, SSL proxying.
 *
 * Why we wrap it instead of letting agents call Proxyman MCP directly:
 *   - Proxyman returns plain-text rather than structured JSON for most tools.
 *     We parse here so handlers operate on real types.
 *   - We bake in the include_paths=true default for scripting rules — leaving
 *     it false silently no-ops the rule on any URL with a path (Proxyman quirk
 *     verified during the spike, see PR conversation around bug-9 follow-up).
 *   - Lifecycle: lazy-connect on first call so the MCP server boots even when
 *     Proxyman isn't running. A clear error surfaces only when a tool is used.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DEFAULT_BIN = '/Applications/Proxyman.app/Contents/MacOS/mcp-server';

const PROXYMAN_BIN = process.env.PROXYMAN_MCP_BIN ?? DEFAULT_BIN;

export interface ProxymanRuleSummary {
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    ruleType: string;
}

export type ProxymanRuleType =
    | 'breakpoint'
    | 'maplocal'
    | 'mapremote'
    | 'blacklist'
    | 'scripting'
    | 'whitelist'
    | 'reverse_proxy'
    | 'network_condition'
    | 'dns_spoofing';

export interface CreateScriptingRuleInput {
    name: string;
    url: string;
    scriptContent: string;
    method?: 'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
    /** Default true — overrides Proxyman's no-match-on-paths default. */
    includePaths?: boolean;
    useRegex?: boolean;
    enableRequest?: boolean;
    enableResponse?: boolean;
    isMockResponse?: boolean;
    graphqlQueryName?: string;
}

export class ProxymanMcpError extends Error {
    constructor(message: string, public readonly tool?: string) {
        super(message);
        this.name = 'ProxymanMcpError';
    }
}

/**
 * Connection-pooled client. All handlers share one instance so we don't spawn
 * a new mcp-server child per call.
 */
export class ProxymanMcpClient {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private connectPromise: Promise<void> | null = null;

    constructor(private readonly bin: string = PROXYMAN_BIN) {}

    /** Returns true if a connection is currently established. */
    isConnected(): boolean {
        return this.client !== null;
    }

    async connect(): Promise<void> {
        if (this.client) return;
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = (async () => {
            this.transport = new StdioClientTransport({
                command: this.bin,
                args: [],
            });
            this.client = new Client(
                { name: 'mobile-automator-mcp', version: '0.1.0' },
                { capabilities: {} },
            );
            try {
                await this.client.connect(this.transport);
            } catch (err) {
                this.client = null;
                this.transport = null;
                throw new ProxymanMcpError(
                    `Failed to spawn Proxyman MCP at ${this.bin}: ${(err as Error).message}. ` +
                    `Is Proxyman installed? (set PROXYMAN_MCP_BIN env var to override the path.)`,
                );
            }
        })();
        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    async close(): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.close();
        } catch {
            // Best effort — child may already be dead.
        }
        this.client = null;
        this.transport = null;
    }

    /**
     * Generic tool call returning the unwrapped text payload. Throws
     * ProxymanMcpError on tool error. Auto-reconnects once if the underlying
     * connection died.
     */
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
        await this.connect();
        const client = this.client!;
        let resp;
        try {
            resp = await client.callTool({ name, arguments: args });
        } catch (err) {
            // Transport-level failure — try one reconnect.
            await this.close();
            await this.connect();
            resp = await this.client!.callTool({ name, arguments: args });
        }
        if (resp.isError) {
            const text = extractText(resp);
            throw new ProxymanMcpError(text, name);
        }
        return extractText(resp);
    }

    // ── Typed wrappers ──

    async getProxyStatus(): Promise<string> {
        return this.callTool('get_proxy_status');
    }

    async toggleTool(tool: string, enabled: boolean): Promise<void> {
        await this.callTool('toggle_tool', { tool, enabled });
    }

    async enableSslProxying(domain: string): Promise<void> {
        await this.callTool('enable_ssl_proxying', { domain });
    }

    async createScriptingRule(input: CreateScriptingRuleInput): Promise<string> {
        const args: Record<string, unknown> = {
            name: input.name,
            url: input.url,
            script_content: input.scriptContent,
            include_paths: input.includePaths ?? true, // override Proxyman's no-match-by-default
        };
        if (input.method) args.method = input.method;
        if (input.useRegex !== undefined) args.use_regex = input.useRegex;
        if (input.enableRequest !== undefined) args.enable_request = input.enableRequest;
        if (input.enableResponse !== undefined) args.enable_response = input.enableResponse;
        if (input.isMockResponse !== undefined) args.is_mock_response = input.isMockResponse;
        if (input.graphqlQueryName) args.graphql_query_name = input.graphqlQueryName;

        const text = await this.callTool('create_scripting_rule', args);
        const id = parseRuleId(text);
        if (!id) {
            throw new ProxymanMcpError(
                `create_scripting_rule succeeded but no rule ID could be parsed from response: "${text.slice(0, 200)}"`,
                'create_scripting_rule',
            );
        }
        return id;
    }

    async deleteRule(id: string, ruleType: ProxymanRuleType = 'scripting'): Promise<void> {
        await this.callTool('delete_rule', { id, rule_type: ruleType });
    }

    async listRules(ruleType: ProxymanRuleType | 'all' = 'all'): Promise<ProxymanRuleSummary[]> {
        const text = await this.callTool('list_rules', { rule_type: ruleType });
        return parseRuleList(text);
    }
}

// ── Plain-text parsers (Proxyman returns formatted text, not JSON) ──

function extractText(resp: unknown): string {
    if (!resp || typeof resp !== 'object') return '';
    const content = (resp as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) return '';
    const first = content[0];
    if (first && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
        return (first as { text: string }).text;
    }
    return '';
}

/**
 * Parse "Rule ID: ABCD1234" out of a create_*_rule success message.
 * Returns null if the pattern isn't found.
 */
export function parseRuleId(text: string): string | null {
    const m = text.match(/Rule ID:\s*([A-Z0-9-]+)/i);
    return m?.[1] ?? null;
}

/**
 * Parse the multi-rule list_rules text format. Each entry looks like:
 *
 *   1. [✓] [SCRIPTING] mca:abc123:probe1
 *      ID: AC5CFB7B
 *      URL: httpbin.proxyman.app
 *
 * The marker is `[✓]` (enabled) or `[ ]` / `[✗]` (disabled).
 */
export function parseRuleList(text: string): ProxymanRuleSummary[] {
    const entryRegex = /^\d+\.\s*\[([^\]]+)\]\s*\[([A-Z_]+)\]\s*(.+?)\n\s*ID:\s*(\S+)\n\s*URL:\s*(.+?)$/gm;
    const out: ProxymanRuleSummary[] = [];
    for (const m of text.matchAll(entryRegex)) {
        const enabledMarker = m[1].trim();
        out.push({
            enabled: enabledMarker === '✓' || enabledMarker.toLowerCase() === 'on',
            ruleType: m[2].toLowerCase(),
            name: m[3].trim(),
            id: m[4].trim(),
            url: m[5].trim(),
        });
    }
    return out;
}

// ── Singleton, lazily constructed ──

let singleton: ProxymanMcpClient | null = null;

export function getProxymanMcpClient(): ProxymanMcpClient {
    if (!singleton) singleton = new ProxymanMcpClient();
    return singleton;
}

/** Reset the singleton (test-only). */
export function _resetProxymanMcpClient(): void {
    singleton = null;
}
