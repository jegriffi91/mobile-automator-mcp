/**
 * MaestroDaemon — Manages a long-running `maestro mcp` child process.
 *
 * Instead of spawning a new JVM for each `maestro hierarchy` call (~5.2s),
 * the daemon keeps a warm JVM alive and communicates via JSON-RPC over stdio.
 * After the initial startup (~5s), subsequent hierarchy calls complete in <500ms.
 *
 * Protocol: MCP (Model Context Protocol) over stdio with newline-delimited JSON-RPC.
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolveMaestroBin, getExecEnv } from './env.js';
import { parseCsvHierarchy } from './csv-hierarchy-parser.js';
import type { UIHierarchyNode, TimeoutConfig } from '../types.js';
import { DEFAULT_TIMEOUTS } from '../types.js';

/** Returns a parsed UIHierarchyNode tree for the TouchInferrer */
export type TreeHierarchyReader = () => Promise<UIHierarchyNode>;

export class MaestroDaemon {
  private process: ChildProcess | null = null;
  private maestroBin: string;
  private deviceId?: string;
  private requestId = 0;
  private responseBuffer = '';
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private initialized = false;
  private timeouts: TimeoutConfig;

  constructor(maestroBin?: string, timeouts?: Partial<TimeoutConfig>) {
    this.maestroBin = resolveMaestroBin(maestroBin);
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  /**
   * Spawn the `maestro mcp` process and perform the MCP initialize handshake.
   * The first call incurs JVM startup (~5s), after which the process stays warm.
   */
  async start(deviceId?: string): Promise<void> {
    if (this.process) {
      console.error('[MaestroDaemon] already running');
      return;
    }

    this.deviceId = deviceId;
    const args: string[] = [];
    if (deviceId) {
      args.push('--udid', deviceId);
    }
    args.push('mcp');

    const env = getExecEnv();

    console.error(`[MaestroDaemon] starting: ${this.maestroBin} ${args.join(' ')}`);

    this.process = spawn(this.maestroBin, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Buffer stdout for JSON-RPC response parsing
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.responseBuffer += chunk.toString();
      this.processResponseBuffer();
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      // Log daemon stderr for debugging (JVM startup messages, etc.)
      const msg = chunk.toString().trim();
      if (msg) {
        console.error(`[MaestroDaemon:stderr] ${msg}`);
      }
    });

    this.process.on('exit', (code, signal) => {
      console.error(`[MaestroDaemon] process exited (code: ${code}, signal: ${signal})`);
      this.rejectAllPending(
        new Error(`MaestroDaemon process exited (code: ${code}, signal: ${signal})`),
      );
      this.cleanup();
    });

    this.process.on('error', (err) => {
      console.error(`[MaestroDaemon] process error:`, err);
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
      this.cleanup();
    });

    // Send MCP initialize handshake
    const startTime = Date.now();
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mobile-automator', version: '1.0.0' },
    });

    // Send initialized notification (no response expected)
    this.sendNotification('notifications/initialized', {});

    this.initialized = true;
    const warmupMs = Date.now() - startTime;
    console.error(`[MaestroDaemon] started (PID: ${this.process.pid}), JVM warm in ~${warmupMs}ms`);
  }

  /**
   * Call `inspect_view_hierarchy` on the warm JVM and return the raw CSV string.
   * This is the fast path — typically <500ms on a warm process.
   */
  async getHierarchyRaw(): Promise<string> {
    if (!this.initialized || !this.process) {
      throw new Error('MaestroDaemon not started. Call start() first.');
    }

    const result = await this.sendRequest('tools/call', {
      name: 'inspect_view_hierarchy',
      arguments: this.deviceId ? { device_id: this.deviceId } : {},
    }) as { content?: Array<{ type: string; text: string }> };

    // Extract text content from the MCP tool response
    const textContent = result?.content?.find((c) => c.type === 'text');
    if (!textContent?.text) {
      throw new Error('inspect_view_hierarchy returned no text content');
    }

    return textContent.text;
  }

  // ── Action tool wrappers ──

  /**
   * Tap on a UI element identified by id or text.
   * Requires at least one of: `id`, `text`. For point-based taps, use the CLI path.
   */
  async tapOn(
    deviceId: string,
    selector: { id?: string; text?: string; index?: number; useFuzzyMatching?: boolean },
  ): Promise<void> {
    if (!this.initialized || !this.process) {
      throw new Error('MaestroDaemon not started. Call start() first.');
    }

    const args: Record<string, unknown> = { device_id: deviceId };
    if (selector.id !== undefined) args['id'] = selector.id;
    if (selector.text !== undefined) args['text'] = selector.text;
    if (selector.index !== undefined) args['index'] = selector.index;
    if (selector.useFuzzyMatching !== undefined) args['use_fuzzy_matching'] = selector.useFuzzyMatching;

    const result = await this.sendRequest('tools/call', {
      name: 'tap_on',
      arguments: args,
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    if (result?.isError) {
      const msg = result.content?.find((c) => c.type === 'text')?.text ?? 'tap_on failed';
      throw new Error(`[MaestroDaemon] tap_on error: ${msg}`);
    }
  }

  /**
   * Type text into the currently-focused field.
   *
   * NOTE: `input_text` does NOT accept an element selector — Maestro types into
   * whatever field currently has focus. Call `tapOn` first to focus the target
   * field before calling `inputText`.
   */
  async inputText(deviceId: string, text: string): Promise<void> {
    if (!this.initialized || !this.process) {
      throw new Error('MaestroDaemon not started. Call start() first.');
    }

    const result = await this.sendRequest('tools/call', {
      name: 'input_text',
      arguments: { device_id: deviceId, text },
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    if (result?.isError) {
      const msg = result.content?.find((c) => c.type === 'text')?.text ?? 'input_text failed';
      throw new Error(`[MaestroDaemon] input_text error: ${msg}`);
    }
  }

  /**
   * Press the device back button (Android hardware back / swipe-back gesture).
   */
  async back(deviceId: string): Promise<void> {
    if (!this.initialized || !this.process) {
      throw new Error('MaestroDaemon not started. Call start() first.');
    }

    const result = await this.sendRequest('tools/call', {
      name: 'back',
      arguments: { device_id: deviceId },
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    if (result?.isError) {
      const msg = result.content?.find((c) => c.type === 'text')?.text ?? 'back failed';
      throw new Error(`[MaestroDaemon] back error: ${msg}`);
    }
  }

  /**
   * Launch the app identified by `appId` on the device.
   */
  async launchApp(deviceId: string, appId: string): Promise<void> {
    if (!this.initialized || !this.process) {
      throw new Error('MaestroDaemon not started. Call start() first.');
    }

    const result = await this.sendRequest('tools/call', {
      name: 'launch_app',
      arguments: { device_id: deviceId, app_id: appId },
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    if (result?.isError) {
      const msg = result.content?.find((c) => c.type === 'text')?.text ?? 'launch_app failed';
      throw new Error(`[MaestroDaemon] launch_app error: ${msg}`);
    }
  }

  /**
   * Stop the app identified by `appId` on the device.
   * If `appId` is omitted, Maestro stops the app that was most recently launched.
   */
  async stopApp(deviceId: string, appId?: string): Promise<void> {
    if (!this.initialized || !this.process) {
      throw new Error('MaestroDaemon not started. Call start() first.');
    }

    const args: Record<string, unknown> = { device_id: deviceId };
    if (appId !== undefined) args['app_id'] = appId;

    const result = await this.sendRequest('tools/call', {
      name: 'stop_app',
      arguments: args,
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    if (result?.isError) {
      const msg = result.content?.find((c) => c.type === 'text')?.text ?? 'stop_app failed';
      throw new Error(`[MaestroDaemon] stop_app error: ${msg}`);
    }
  }

  /**
   * Take a screenshot of the device screen.
   * Returns the PNG as a base64 string when the daemon provides it, plus the
   * raw text content of the response for callers that need the full payload.
   */
  async takeScreenshot(deviceId: string): Promise<{ pngBase64?: string; rawText: string }> {
    if (!this.initialized || !this.process) {
      throw new Error('MaestroDaemon not started. Call start() first.');
    }

    const result = await this.sendRequest('tools/call', {
      name: 'take_screenshot',
      arguments: { device_id: deviceId },
    }) as { isError?: boolean; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

    if (result?.isError) {
      const msg = result.content?.find((c) => c.type === 'text')?.text ?? 'take_screenshot failed';
      throw new Error(`[MaestroDaemon] take_screenshot error: ${msg}`);
    }

    // Prefer an image/png content block; fall back to text
    const imageContent = result?.content?.find((c) => c.mimeType === 'image/png' || c.type === 'image');
    const textContent = result?.content?.find((c) => c.type === 'text');
    const rawText = textContent?.text ?? '';

    return {
      pngBase64: imageContent?.data,
      rawText,
    };
  }

  /**
   * Get hierarchy parsed into UIHierarchyNode tree.
   */
  async getHierarchy(): Promise<UIHierarchyNode> {
    const csv = await this.getHierarchyRaw();
    return parseCsvHierarchy(csv);
  }

  /**
   * Create a tree reader function compatible with TouchInferrer.
   * Returns parsed UIHierarchyNode trees from the warm daemon's CSV output.
   */
  createTreeReader(): TreeHierarchyReader {
    return async () => {
      const csv = await this.getHierarchyRaw();
      return parseCsvHierarchy(csv);
    };
  }

  /**
   * Stop the daemon process and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    console.error('[MaestroDaemon] stopping...');

    // Reject any pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('MaestroDaemon stopped'));
    }
    this.pendingRequests.clear();

    // Kill the process
    this.process.kill('SIGTERM');

    // Give it a moment to exit gracefully, then force kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
        resolve();
      }, this.timeouts.daemonShutdownMs);

      this.process?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.cleanup();
    console.error('[MaestroDaemon] stopped');
  }

  /** Whether the daemon is alive and ready */
  get isRunning(): boolean {
    return this.initialized && this.process !== null;
  }

  // ── Private helpers ──

  private nextId(): number {
    return ++this.requestId;
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('Daemon stdin not writable'));
        return;
      }

      const id = this.nextId();
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this.pendingRequests.set(id, { resolve, reject });

      // Timeout after configured duration
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id: ${id}) timed out after ${this.timeouts.daemonRequestMs}ms`));
      }, this.timeouts.daemonRequestMs);

      // Wrap the resolve/reject to clear timeout
      const original = this.pendingRequests.get(id)!;
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          original.resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          original.reject(reason);
        },
      });

      this.process.stdin.write(message + '\n');
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;

    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    this.process.stdin.write(message + '\n');
  }

  /**
   * Process buffered stdout data, extracting complete JSON-RPC messages.
   * Messages are newline-delimited JSON.
   */
  private processResponseBuffer(): void {
    const lines = this.responseBuffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.responseBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);

        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);

          if (msg.error) {
            pending.reject(new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Notifications from the server (no id) are logged but not dispatched
        else if (msg.id === undefined && msg.method) {
          console.error(`[MaestroDaemon] server notification: ${msg.method}`);
        }
      } catch {
        // Not valid JSON — might be interleaved log output from the JVM
        console.error(`[MaestroDaemon] non-JSON stdout: ${trimmed.slice(0, 200)}`);
      }
    }
  }

  private rejectAllPending(reason: Error): void {
    if (this.pendingRequests.size === 0) return;
    console.error(
      `[MaestroDaemon] rejecting ${this.pendingRequests.size} pending request(s): ${reason.message}`,
    );
    for (const [, pending] of this.pendingRequests) {
      pending.reject(reason);
    }
    this.pendingRequests.clear();
  }

  private cleanup(): void {
    this.process = null;
    this.initialized = false;
    this.responseBuffer = '';
    this.requestId = 0;
  }
}
