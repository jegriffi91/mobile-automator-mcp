/**
 * SegmentRegistry — Persistent registry of named, reusable flow segments.
 *
 * Segments are stored in a JSON file (default: segments/registry.json)
 * alongside their YAML and WireMock stubs. The registry maps fingerprints
 * to named segments so the agent can detect and reuse known flows.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SegmentFingerprint } from './fingerprint.js';
import type { CorrelatedStep } from '../synthesis/correlator.js';

// ── Types ──

export interface SegmentEntry {
    /** Human-readable name (e.g., "login", "navigate-to-settings") */
    name: string;
    /** Deterministic fingerprint from SegmentFingerprint.compute() */
    fingerprint: string;
    /** Relative path to the segment's Maestro YAML */
    yamlPath: string;
    /** Relative path to associated WireMock stubs directory */
    stubsDir?: string;
    /** ISO timestamp of when this segment was first registered */
    createdAt: string;
    /** Session ID that first produced this segment */
    createdBy?: string;
    /** Human-readable description of the raw action sequence */
    sequencePreview?: string;
}

export interface SegmentMatch {
    entry: SegmentEntry;
    similarity: number;
}

// ── Registry ──

export class SegmentRegistry {
    /**
     * Load the segment registry from disk.
     * Returns an empty array if the file does not exist.
     */
    static async load(registryPath: string): Promise<SegmentEntry[]> {
        try {
            const raw = await fs.readFile(registryPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed as SegmentEntry[];
        } catch {
            return [];
        }
    }

    /**
     * Save the segment registry to disk.
     * Creates parent directories if they don't exist.
     */
    static async save(registryPath: string, entries: SegmentEntry[]): Promise<void> {
        await fs.mkdir(path.dirname(registryPath), { recursive: true });
        await fs.writeFile(registryPath, JSON.stringify(entries, null, 2), 'utf-8');
    }

    /**
     * Find segments matching a fingerprint or with high similarity.
     *
     * @param entries - Current registry entries
     * @param fingerprint - Fingerprint to match
     * @param steps - Correlated steps (for similarity scoring against non-exact matches)
     * @param threshold - Minimum similarity to include (default 0.7)
     */
    static findMatches(
        entries: SegmentEntry[],
        fingerprint: string,
        _steps?: CorrelatedStep[],
        _threshold = 0.7
    ): SegmentMatch[] {
        const matches: SegmentMatch[] = [];

        for (const entry of entries) {
            if (entry.fingerprint === fingerprint) {
                // Exact match
                matches.push({ entry, similarity: 1.0 });
            }
            // Note: fuzzy similarity matching would require storing the original
            // CorrelatedStep[] for each entry, which is expensive. For now, we
            // only support exact fingerprint matches. The similarity() function
            // on SegmentFingerprint is available for agent-level comparison when
            // the steps data is available in memory.
        }

        return matches.sort((a, b) => b.similarity - a.similarity);
    }

    /**
     * Register a new segment entry.
     * Replaces any existing entry with the same name.
     */
    static addEntry(entries: SegmentEntry[], entry: SegmentEntry): SegmentEntry[] {
        const filtered = entries.filter((e) => e.name !== entry.name);
        filtered.push(entry);
        return filtered;
    }

    /**
     * Remove a segment entry by name.
     */
    static removeEntry(entries: SegmentEntry[], name: string): SegmentEntry[] {
        return entries.filter((e) => e.name !== name);
    }
}
