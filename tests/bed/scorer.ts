/**
 * Pillar scoring functions. Pure — no I/O, deterministic, easy to unit-test.
 */

import type {
    CheckpointResult,
    PillarScore,
    SpatialMiss,
    SpatialTruthEntry,
    TaskResult,
    TaskSpec,
} from './types.js';
import { PILLAR_THRESHOLDS, TOKEN_BUDGET } from './types.js';
import type { RenderedScreen, RenderedNode } from './compactor-baseline.js';
import { gridLabel } from './spatial.js';
import { estimateTokens } from './token-estimator.js';

// ── Pillar 1: spatial-tag correctness ──

/**
 * Score the spatial tag the compactor emitted for each node against the
 * ground-truth tag re-derived from `node.bounds + parsedRoot.bounds`. The
 * hand-labeled subset (`spatialTruth`) adds an additional check that catches
 * bugs in the bed's own formula.
 */
export function scoreSpatialTags(
    screen: RenderedScreen,
    screenName: string,
    spatialTruth: SpatialTruthEntry[],
): CheckpointResult['pillar1_spatial'] {
    const root = screen.parsedRoot.bounds;
    const misses: SpatialMiss[] = [];
    let total = 0;
    let correct = 0;

    if (root) {
        for (const node of screen.nodes) {
            if (!node.bounds || !node.spatial) continue;
            total += 1;
            const expected = gridLabel(node.bounds, root);
            if (expected === node.spatial) {
                correct += 1;
            } else {
                misses.push({
                    elementKey: node.key,
                    expectedLabel: expected,
                    actualLabel: node.spatial,
                    bounds: node.bounds,
                });
            }
        }
    }

    // Hand-labeled audit subset for this screen.
    const audit = spatialTruth.filter((e) => e.screen === screenName);
    let handCorrect = 0;
    for (const entry of audit) {
        const match = findNodeByKey(screen.nodes, entry.element_id);
        if (match && match.spatial === entry.expected_label) {
            handCorrect += 1;
        }
    }

    const ratio = total === 0 ? 1 : correct / total;
    const handRatio = audit.length === 0 ? 1 : handCorrect / audit.length;

    const passed =
        ratio >= PILLAR_THRESHOLDS.spatialMinPerCheckpoint &&
        handRatio >= PILLAR_THRESHOLDS.spatialHandLabeledMin;

    return {
        passed,
        metric: ratio,
        threshold: PILLAR_THRESHOLDS.spatialMinPerCheckpoint,
        total,
        correct,
        misses,
        handLabeled: { total: audit.length, correct: handCorrect },
    };
}

function findNodeByKey(nodes: RenderedNode[], key: string): RenderedNode | undefined {
    return nodes.find((n) => n.key === key);
}

// ── Pillar 2: element-selection accuracy ──

export function scoreElementSelection(
    task: TaskSpec,
    pick: { chosenId?: string; error?: string; inputTokens?: number; latencyMs?: number },
): TaskResult {
    const alternates = task.acceptable_alternates ?? [];
    const correct =
        !pick.error &&
        !!pick.chosenId &&
        (pick.chosenId === task.expected_element_id || alternates.includes(pick.chosenId));

    return {
        goal: task.goal,
        expected: task.expected_element_id,
        alternates,
        chosen: pick.chosenId,
        correct,
        error: pick.error,
        latencyMs: pick.latencyMs,
        inputTokens: pick.inputTokens,
    };
}

export function aggregateSelection(tasks: TaskResult[]): PillarScore {
    if (tasks.length === 0) {
        return { passed: true, metric: 1, threshold: PILLAR_THRESHOLDS.selectionMinPerScreen };
    }
    const correct = tasks.filter((t) => t.correct).length;
    const ratio = correct / tasks.length;
    return {
        passed: ratio >= PILLAR_THRESHOLDS.selectionMinPerScreen,
        metric: ratio,
        threshold: PILLAR_THRESHOLDS.selectionMinPerScreen,
    };
}

// ── Pillar 3: token budget ──

/**
 * Score token budget compliance. `realInputTokens` is supplied only when
 * `--with-llm` is on (sourced from `claude -p` usage.input_tokens). Without
 * it, the heuristic carries the verdict — but with extra margin (the
 * `hardFailHeuristic` threshold sits 200 above the real cap to account for
 * ±15% heuristic error).
 */
export function scoreTokenBudget(
    rendered: string,
    realInputTokens?: number,
): CheckpointResult['pillar3_tokens'] {
    const heuristic = estimateTokens(rendered);
    const renderedChars = rendered.length;
    const renderedBytes = Buffer.byteLength(rendered, 'utf8');

    let passed: boolean;
    if (realInputTokens !== undefined) {
        passed = realInputTokens <= TOKEN_BUDGET.hardFailReal;
    } else {
        passed = heuristic <= TOKEN_BUDGET.hardFailHeuristic;
    }

    return {
        passed,
        metric: realInputTokens ?? heuristic,
        threshold: realInputTokens !== undefined ? TOKEN_BUDGET.hardFailReal : TOKEN_BUDGET.hardFailHeuristic,
        heuristic,
        real: realInputTokens,
        renderedChars,
        renderedBytes,
    };
}

// ── Pillar 4: compaction ratio ──

export function scoreCompactionRatio(screen: RenderedScreen): CheckpointResult['pillar4_compaction'] {
    const ratio = screen.rawBytes === 0 ? 0 : screen.compactedBytes / screen.rawBytes;
    return {
        passed: true, // informational; never blocks
        metric: ratio,
        rawBytes: screen.rawBytes,
        compactedBytes: screen.compactedBytes,
        ratio,
        nodesBefore: screen.nodesBefore,
        nodesAfter: screen.nodesAfter,
    };
}

// ── Corpus aggregates ──

export function aggregateSpatialCorpus(results: CheckpointResult[]): number {
    let totalCorrect = 0;
    let totalCount = 0;
    for (const r of results) {
        totalCount += r.pillar1_spatial.total;
        totalCorrect += r.pillar1_spatial.correct;
    }
    return totalCount === 0 ? 1 : totalCorrect / totalCount;
}

export function aggregateSelectionCorpus(results: CheckpointResult[]): number | undefined {
    let total = 0;
    let correct = 0;
    let any = false;
    for (const r of results) {
        if (!r.pillar2_selection) continue;
        any = true;
        const tasks = (r.pillar2_selection as { tasks: TaskResult[] }).tasks;
        total += tasks.length;
        correct += tasks.filter((t) => t.correct).length;
    }
    if (!any) return undefined;
    return total === 0 ? 1 : correct / total;
}

