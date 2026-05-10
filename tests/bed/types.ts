/**
 * Shared types for the iOS Accuracy + Token-Budget Test Bed.
 *
 * The bed measures four pillars (spatial-tag correctness, element-selection
 * accuracy, token budget compliance, compaction ratio) against the current
 * `HierarchyParser.filterInteractive + compact` pipeline. When the real
 * spatial semantic compactor lands it swaps in behind the same interface and
 * the bed verifies it doesn't regress.
 */

/** Grid labels for the 3x3 spatial tagger. Row-major order, top-left first. */
export type GridLabel =
    | 'tl' | 'tc' | 'tr'
    | 'ml' | 'mc' | 'mr'
    | 'bl' | 'bc' | 'br';

export const GRID_LABELS: readonly GridLabel[] = [
    'tl', 'tc', 'tr',
    'ml', 'mc', 'mr',
    'bl', 'bc', 'br',
] as const;

/** Hard ceilings for pillar 3 (token budget compliance). */
export const TOKEN_BUDGET = {
    /** Heuristic warn threshold (chars-based estimate). */
    warnHeuristic: 1_800,
    /** Heuristic hard-fail threshold — leaves ±15% slack vs the real cap. */
    hardFailHeuristic: 2_200,
    /** Real ground-truth ceiling on input_tokens from `claude -p` response. */
    hardFailReal: 2_000,
} as const;

/** Per-screen thresholds for pillars 1, 2, 4. Pillar 3 thresholds live on TOKEN_BUDGET. */
export const PILLAR_THRESHOLDS = {
    /** Pillar 1 — per-checkpoint minimum. */
    spatialMinPerCheckpoint: 0.95,
    /** Pillar 1 — corpus-wide minimum. */
    spatialMinCorpus: 0.98,
    /** Pillar 1 — hand-labeled audit must be perfect. */
    spatialHandLabeledMin: 1.0,
    /** Pillar 2 — per-screen minimum (only enforced when --with-llm). */
    selectionMinPerScreen: 0.9,
    /** Pillar 2 — corpus-wide minimum (only enforced when --with-llm). */
    selectionMinCorpus: 0.92,
    /** Pillar 4 — compaction ratio above this triggers a warning (never blocks). */
    compactionRatioWarn: 0.5,
} as const;

/** A single step in the bed's verification flow YAML. */
export type CheckpointSpec =
    | { launchApp: true }
    | { tap: ElementSelector }
    | { inputText: { into: ElementSelector; text: string } }
    | { assertVisible: ElementSelector }
    | { checkpoint: string };

export interface ElementSelector {
    id?: string;
    testId?: string;
    text?: string;
    accessibilityLabel?: string;
}

export interface BedFlowSpec {
    appId: string;
    steps: CheckpointSpec[];
}

/** Task corpus entry — natural-language goal → expected element ID. */
export interface TaskSpec {
    screen: string;
    goal: string;
    expected_element_id: string;
    acceptable_alternates?: string[];
    notes?: string;
}

export interface TaskCorpus {
    tasks: TaskSpec[];
}

/** Hand-labeled spatial audit entry. */
export interface SpatialTruthEntry {
    screen: string;
    element_id: string;
    expected_label: GridLabel;
}

export interface SpatialTruthCorpus {
    entries: SpatialTruthEntry[];
}

// ── Report shapes ──

export interface PillarScore {
    passed: boolean;
    metric: number;          // 0..1 for ratios, integer for counts
    threshold?: number;
    details?: unknown;
}

export interface TaskResult {
    goal: string;
    expected: string;
    alternates: string[];
    chosen?: string;
    correct: boolean;
    error?: string;
    latencyMs?: number;
    inputTokens?: number;    // from claude -p usage.input_tokens
}

export interface SpatialMiss {
    elementKey: string;       // id|testId|label|text
    expectedLabel: GridLabel;
    actualLabel: GridLabel | null;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface CheckpointResult {
    name: string;
    pillar1_spatial: PillarScore & {
        total: number;
        correct: number;
        misses: SpatialMiss[];
        handLabeled: { total: number; correct: number };
    };
    pillar2_selection?: PillarScore & {
        tasks: TaskResult[];
    };
    pillar3_tokens: PillarScore & {
        heuristic: number;
        real?: number;
        renderedChars: number;
        renderedBytes: number;
    };
    pillar4_compaction: PillarScore & {
        rawBytes: number;
        compactedBytes: number;
        ratio: number;
        nodesBefore: number;
        nodesAfter: number;
    };
    checkpointFailed?: string;  // populated when Maestro action errored at setup
}

export interface BedReport {
    timestamp: string;
    deviceId?: string;
    appId: string;
    withLlm: boolean;
    checkpoints: CheckpointResult[];
    summary: {
        passed: boolean;
        spatialCorrectnessCorpus: number;
        selectionAccuracyCorpus?: number;
        maxHeuristicTokens: number;
        maxRealTokens?: number;
        avgCompactionRatio: number;
    };
}
