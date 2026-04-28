/**
 * FlowWeaver — Phase 5 compile-time event weaving.
 *
 * Phase 4 left a structural gap in compiled artifacts: when a recording
 * session brackets a `run_test` / `run_flow` call (via pauseSession +
 * resumeSession), the timeline gains synthetic `flow_boundary` markers but
 * the range between them is opaque (just captured stdout).
 *
 * This module fills the gap by parsing Maestro's --debug-output artifacts
 * (`commands-<flow>.json`) and emitting structured FlowStep[] that can be
 * spliced into the compiled timeline.json and YAML.
 *
 * Defensive by design: missing dirs, malformed JSON, and unknown command
 * shapes degrade to empty/unknown rather than throwing — a bad artifact
 * must not fail the compile pipeline.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ── Public types ──

/** A single Maestro command parsed from commands-<flow>.json. */
export interface FlowStep {
    /** Maestro's per-command sequence number within the source flow. */
    sequenceNumber: number;
    /** ISO-8601 timestamp converted from Maestro's epoch-ms metadata. */
    timestamp: string;
    /** Action kind: 'tap' | 'inputText' | 'launchApp' | 'assertVisible' | 'unknown' | etc. */
    kind: string;
    /** Best-effort display string for the target (text, id, selector). */
    target?: string;
    /** Maestro's command duration in ms. */
    durationMs: number;
    /** Status reported by Maestro for this command. */
    status: 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'PENDING';
    /** Error message when status === 'FAILED'. */
    error?: string;
    /** Full Maestro command object preserved for downstream tooling. */
    raw: unknown;
}

// ── Internal Maestro JSON shape (best-effort) ──

interface MaestroEntry {
    command?: Record<string, unknown>;
    metadata?: {
        status?: string;
        timestamp?: number;
        duration?: number;
        sequenceNumber?: number;
        error?: { message?: string } | string;
    };
}

/**
 * Parse all commands-*.json files in a Maestro --debug-output directory,
 * concatenating them in metadata.timestamp ascending order.
 *
 * Returns [] on missing/unreadable dir. Never throws — degrades gracefully
 * so a malformed artifact doesn't fail the compile.
 */
export async function parseMaestroDebugOutput(
    debugOutputDir: string,
): Promise<FlowStep[]> {
    let entries: string[];
    try {
        entries = await fs.readdir(debugOutputDir);
    } catch (err) {
        // ENOENT or permissions — degrade to empty.
        console.error(
            `[flow-weaver] cannot read debugOutputDir ${debugOutputDir}: ${(err as Error).message}`,
        );
        return [];
    }

    const files = entries.filter(
        (name) => name.startsWith('commands-') && name.endsWith('.json'),
    );

    const steps: FlowStep[] = [];
    for (const name of files) {
        const filePath = path.join(debugOutputDir, name);
        let parsed: unknown;
        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            parsed = JSON.parse(raw);
        } catch (err) {
            console.error(`[flow-weaver] parse failed: ${filePath} — ${(err as Error).message}`);
            continue;
        }
        if (!Array.isArray(parsed)) continue;
        for (const entry of parsed) {
            const step = mapEntry(entry as MaestroEntry);
            if (step) steps.push(step);
        }
    }

    // Sort by epoch timestamp so multiple commands-*.json files (e.g. nested
    // runFlow:) merge into a single chronological stream.
    steps.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return steps;
}

// ── Helpers ──

function mapEntry(entry: MaestroEntry): FlowStep | null {
    if (!entry || typeof entry !== 'object') return null;
    const meta = entry.metadata ?? {};

    const epochMs = typeof meta.timestamp === 'number' ? meta.timestamp : 0;
    const timestamp = epochMs > 0 ? new Date(epochMs).toISOString() : new Date(0).toISOString();
    const durationMs = typeof meta.duration === 'number' ? meta.duration : 0;
    const sequenceNumber = typeof meta.sequenceNumber === 'number' ? meta.sequenceNumber : 0;
    const status = normalizeStatus(meta.status);

    const command = entry.command;
    let kind = 'unknown';
    let target: string | undefined;
    if (command && typeof command === 'object') {
        const keys = Object.keys(command);
        if (keys.length > 0) {
            const key = keys[0];
            // tapOnElementCommand → tapOnElement, tapOnPointCommand → tapOnPoint, etc.
            // Maestro suffix is consistently 'Command'.
            kind = key.endsWith('Command') ? key.slice(0, -'Command'.length) : key;
            target = extractTarget(command[key]);
        }
    }

    const error = extractError(meta.error);

    return {
        sequenceNumber,
        timestamp,
        kind,
        ...(target !== undefined ? { target } : {}),
        durationMs,
        status,
        ...(error !== undefined ? { error } : {}),
        raw: entry,
    };
}

function normalizeStatus(s: unknown): FlowStep['status'] {
    if (typeof s !== 'string') return 'PENDING';
    const upper = s.toUpperCase();
    if (upper === 'COMPLETED' || upper === 'FAILED' || upper === 'SKIPPED' || upper === 'PENDING') {
        return upper;
    }
    return 'PENDING';
}

function extractError(err: unknown): string | undefined {
    if (!err) return undefined;
    if (typeof err === 'string') return err;
    if (typeof err === 'object' && err !== null && 'message' in err) {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === 'string') return msg;
    }
    return undefined;
}

/**
 * Best-effort target extraction from a Maestro command body. Maestro's
 * command shapes vary widely — we look for the most-common-display fields
 * (text, id, label, regex, point) and fall back to undefined.
 */
function extractTarget(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const obj = body as Record<string, unknown>;

    // Direct text-bearing payloads (inputTextCommand etc.)
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.id === 'string') return obj.id;
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.appId === 'string') return obj.appId;

    // selector { textRegex, idRegex, accessibilityText, text, id }
    if (obj.selector && typeof obj.selector === 'object') {
        const sel = obj.selector as Record<string, unknown>;
        if (typeof sel.textRegex === 'string') return sel.textRegex;
        if (typeof sel.text === 'string') return sel.text;
        if (typeof sel.idRegex === 'string') return sel.idRegex;
        if (typeof sel.id === 'string') return sel.id;
        if (typeof sel.accessibilityText === 'string') return sel.accessibilityText;
        if (typeof sel.label === 'string') return sel.label;
    }

    // element wrapper (scrollUntilVisible etc.)
    if (obj.element && typeof obj.element === 'object') {
        return extractTarget(obj.element);
    }

    return undefined;
}
