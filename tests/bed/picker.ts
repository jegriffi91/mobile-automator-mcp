/**
 * LLM picker via the Claude Code CLI (`claude -p`).
 *
 * The bed never imports `@anthropic-ai/sdk` or reads `ANTHROPIC_API_KEY`. All
 * LLM access goes through `claude -p --output-format json`, which uses
 * whatever auth the user's Claude Code install already has.
 *
 * The CLI's JSON envelope carries `usage.input_tokens` — that becomes the
 * ground-truth value for pillar 3 (token budget) when `--with-llm` is on.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MODEL = 'claude-haiku-4-5-20251001';

export interface PickRequest {
    /** Deterministic rendered compacted screen (one line per node). */
    compactedScreen: string;
    /** Natural-language goal from the task corpus. */
    goal: string;
}

export interface PickResult {
    chosenId?: string;
    error?: string;
    /** From `usage.input_tokens` on the `claude -p` JSON envelope. */
    inputTokens?: number;
    /** From `usage.output_tokens`. */
    outputTokens?: number;
    latencyMs: number;
    /** Raw stdout for diagnostics on parse failure. */
    raw?: string;
}

/**
 * Build the prompt sent to `claude -p`. Kept pure so a future bed run can
 * replay or count tokens locally without invoking the CLI.
 */
export function buildPrompt(req: PickRequest): string {
    return [
        'You are picking ONE element ID from a mobile screen.',
        'Reply with ONLY a JSON object of the form: {"id": "<element id>"}',
        'No prose, no markdown fences, no other fields.',
        'The id MUST be one of the ids that appear on a screen line below.',
        '',
        'Screen:',
        req.compactedScreen,
        '',
        `Goal: ${req.goal}`,
    ].join('\n');
}

/**
 * Invoke `claude -p` and parse the resulting JSON envelope.
 *
 * Verification step before first use: run `claude -p --help` to confirm the
 * `--output-format json`, `--model`, and prompt-as-arg flags are supported
 * on the installed version. Adjust this function if they differ.
 */
export async function pickElement(req: PickRequest, signal?: AbortSignal): Promise<PickResult> {
    const start = Date.now();
    const prompt = buildPrompt(req);

    try {
        const { stdout } = await execFileAsync(
            'claude',
            ['-p', prompt, '--output-format', 'json', '--model', MODEL],
            { signal, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
        );
        const latencyMs = Date.now() - start;
        return parseEnvelope(stdout, latencyMs);
    } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        return { error: `claude-cli-error: ${message}`, latencyMs };
    }
}

/**
 * Parse the Claude Code JSON envelope. Tolerant of envelope-schema drift —
 * extracts whichever fields are present.
 */
export function parseEnvelope(stdout: string, latencyMs: number): PickResult {
    let envelope: Record<string, unknown>;
    try {
        envelope = JSON.parse(stdout);
    } catch {
        return { error: 'non-json-envelope', latencyMs, raw: stdout };
    }

    const usage = (envelope.usage ?? {}) as Record<string, unknown>;
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;

    const result = typeof envelope.result === 'string' ? envelope.result : '';
    const chosen = extractChosenId(result);

    if (chosen === undefined) {
        return { error: 'non-json-output', inputTokens, outputTokens, latencyMs, raw: result };
    }
    return { chosenId: chosen, inputTokens, outputTokens, latencyMs };
}

/**
 * Extract the `id` field from the model's reply. Tolerates surrounding
 * whitespace, accidental markdown fences, and minor prose around the JSON.
 */
export function extractChosenId(reply: string): string | undefined {
    const trimmed = reply.trim();
    // Fast path: the entire reply is a JSON object.
    const direct = tryParseId(trimmed);
    if (direct !== undefined) return direct;

    // Fallback: find the first {...} block.
    const match = trimmed.match(/\{[\s\S]*?\}/);
    if (!match) return undefined;
    return tryParseId(match[0]);
}

function tryParseId(s: string): string | undefined {
    try {
        const obj = JSON.parse(s);
        if (obj && typeof obj.id === 'string') return obj.id;
        return undefined;
    } catch {
        return undefined;
    }
}
