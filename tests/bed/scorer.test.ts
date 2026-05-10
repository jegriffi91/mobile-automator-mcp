import { describe, it, expect } from 'vitest';
import {
    scoreSpatialTags,
    scoreElementSelection,
    scoreTokenBudget,
    scoreCompactionRatio,
    aggregateSpatialCorpus,
    aggregateSelectionCorpus,
    aggregateSelection,
} from './scorer.js';
import type { CheckpointResult, SpatialTruthEntry, TaskSpec } from './types.js';
import type { RenderedScreen } from './compactor-baseline.js';

function makeScreen(overrides?: Partial<RenderedScreen>): RenderedScreen {
    const root = { x: 0, y: 0, width: 393, height: 852 };
    return {
        text: '',
        nodes: [],
        parsedRoot: { role: 'Application', children: [], bounds: root },
        compactedRoot: { role: 'Application', children: [] },
        rawBytes: 10_000,
        compactedBytes: 1_000,
        nodesBefore: 100,
        nodesAfter: 20,
        ...overrides,
    };
}

describe('scoreSpatialTags', () => {
    it('returns 100% when every node matches its derived label', () => {
        const screen = makeScreen({
            nodes: [
                { key: 'a', keySource: 'id', role: 'Button', bounds: { x: 10, y: 10, width: 20, height: 20 }, spatial: 'tl' },
                { key: 'b', keySource: 'id', role: 'Button', bounds: { x: 360, y: 800, width: 20, height: 20 }, spatial: 'br' },
            ],
        });
        const result = scoreSpatialTags(screen, 'home', []);
        expect(result.metric).toBe(1);
        expect(result.misses).toHaveLength(0);
        expect(result.passed).toBe(true);
    });

    it('records misses when the compactor emitted the wrong label', () => {
        const screen = makeScreen({
            nodes: [
                // Correct: a top-left node tagged tl.
                { key: 'a', keySource: 'id', role: 'Button', bounds: { x: 10, y: 10, width: 20, height: 20 }, spatial: 'tl' },
                // Wrong: a bottom-right node mis-tagged tl.
                { key: 'b', keySource: 'id', role: 'Button', bounds: { x: 360, y: 800, width: 20, height: 20 }, spatial: 'tl' },
            ],
        });
        const result = scoreSpatialTags(screen, 'home', []);
        expect(result.metric).toBe(0.5);
        expect(result.misses).toHaveLength(1);
        expect(result.misses[0].elementKey).toBe('b');
        expect(result.misses[0].expectedLabel).toBe('br');
        expect(result.misses[0].actualLabel).toBe('tl');
        expect(result.passed).toBe(false);
    });

    it('asserts the hand-labeled audit at 100%', () => {
        const screen = makeScreen({
            nodes: [
                { key: 'settings.gear', keySource: 'id', role: 'Button', bounds: { x: 360, y: 30, width: 20, height: 20 }, spatial: 'tr' },
            ],
        });
        const truth: SpatialTruthEntry[] = [
            { screen: 'home', element_id: 'settings.gear', expected_label: 'tr' },
        ];
        const ok = scoreSpatialTags(screen, 'home', truth);
        expect(ok.handLabeled).toEqual({ total: 1, correct: 1 });
        expect(ok.passed).toBe(true);

        const wrongTruth: SpatialTruthEntry[] = [
            { screen: 'home', element_id: 'settings.gear', expected_label: 'tl' },
        ];
        const fail = scoreSpatialTags(screen, 'home', wrongTruth);
        expect(fail.handLabeled).toEqual({ total: 1, correct: 0 });
        expect(fail.passed).toBe(false);
    });

    it('returns 1.0 for a screen with no positioned nodes', () => {
        const result = scoreSpatialTags(makeScreen(), 'home', []);
        expect(result.metric).toBe(1);
        expect(result.passed).toBe(true);
    });
});

describe('scoreElementSelection', () => {
    const task: TaskSpec = {
        screen: 'home',
        goal: 'Tap Settings',
        expected_element_id: 'settings.gear',
        acceptable_alternates: ['nav.settings'],
    };

    it('marks a direct match correct', () => {
        const r = scoreElementSelection(task, { chosenId: 'settings.gear' });
        expect(r.correct).toBe(true);
    });

    it('marks an alternate match correct', () => {
        const r = scoreElementSelection(task, { chosenId: 'nav.settings' });
        expect(r.correct).toBe(true);
    });

    it('marks a wrong pick incorrect', () => {
        const r = scoreElementSelection(task, { chosenId: 'logout.button' });
        expect(r.correct).toBe(false);
    });

    it('marks an errored pick incorrect', () => {
        const r = scoreElementSelection(task, { error: 'non-json-output' });
        expect(r.correct).toBe(false);
        expect(r.error).toBe('non-json-output');
    });
});

describe('aggregateSelection', () => {
    it('treats an empty task list as passing (no signal, no fail)', () => {
        const s = aggregateSelection([]);
        expect(s.passed).toBe(true);
        expect(s.metric).toBe(1);
    });

    it('passes at 9/10 (0.9 == 0.9)', () => {
        const tasks = Array.from({ length: 10 }, (_, i) => ({
            goal: '', expected: 'x', alternates: [], correct: i !== 0,
        }));
        const s = aggregateSelection(tasks);
        expect(s.metric).toBe(0.9);
        expect(s.passed).toBe(true);
    });

    it('fails at 8/10', () => {
        const tasks = Array.from({ length: 10 }, (_, i) => ({
            goal: '', expected: 'x', alternates: [], correct: i > 1,
        }));
        const s = aggregateSelection(tasks);
        expect(s.metric).toBe(0.8);
        expect(s.passed).toBe(false);
    });
});

describe('scoreTokenBudget', () => {
    it('uses the heuristic when no real measurement is supplied', () => {
        const s = scoreTokenBudget('a'.repeat(700)); // 700/3.5 = 200 tokens
        expect(s.heuristic).toBe(200);
        expect(s.real).toBeUndefined();
        expect(s.metric).toBe(200);
        expect(s.passed).toBe(true);
    });

    it('hard-fails the heuristic above the 2,200 margin threshold', () => {
        const s = scoreTokenBudget('a'.repeat(8_000)); // 8000/3.5 ≈ 2286
        expect(s.passed).toBe(false);
    });

    it('uses the real value when supplied, overriding the heuristic verdict', () => {
        // Heuristic would be fine, but real input_tokens exceeds 2000.
        const s = scoreTokenBudget('a'.repeat(500), 2_001);
        expect(s.real).toBe(2_001);
        expect(s.passed).toBe(false);
    });

    it('passes when real is at the cap', () => {
        const s = scoreTokenBudget('a'.repeat(500), 2_000);
        expect(s.passed).toBe(true);
    });
});

describe('scoreCompactionRatio', () => {
    it('reports the byte ratio without ever failing', () => {
        const s = scoreCompactionRatio(makeScreen({ rawBytes: 10_000, compactedBytes: 2_000 }));
        expect(s.ratio).toBe(0.2);
        expect(s.passed).toBe(true);
    });

    it('handles a zero raw size without dividing by zero', () => {
        const s = scoreCompactionRatio(makeScreen({ rawBytes: 0, compactedBytes: 0 }));
        expect(s.ratio).toBe(0);
        expect(s.passed).toBe(true);
    });
});

describe('aggregateSpatialCorpus', () => {
    it('weights checkpoints by raw element count', () => {
        const results: CheckpointResult[] = [
            // 90/100 correct
            checkpointWith({ total: 100, correct: 90 }),
            // 9/10 correct
            checkpointWith({ total: 10, correct: 9 }),
        ];
        // (90 + 9) / (100 + 10) = 99/110 = 0.9
        expect(aggregateSpatialCorpus(results)).toBeCloseTo(0.9, 4);
    });

    it('returns 1 when no checkpoints reported counts', () => {
        const empty: CheckpointResult[] = [checkpointWith({ total: 0, correct: 0 })];
        expect(aggregateSpatialCorpus(empty)).toBe(1);
    });
});

describe('aggregateSelectionCorpus', () => {
    it('returns undefined when no checkpoint enabled pillar 2', () => {
        const results: CheckpointResult[] = [checkpointWith({ total: 1, correct: 1 })];
        expect(aggregateSelectionCorpus(results)).toBeUndefined();
    });

    it('aggregates task-level correct/total across checkpoints', () => {
        const results: CheckpointResult[] = [
            checkpointWith({
                total: 1, correct: 1,
                selection: {
                    tasks: [
                        { goal: 'a', expected: 'x', alternates: [], correct: true },
                        { goal: 'b', expected: 'y', alternates: [], correct: false },
                    ],
                },
            }),
            checkpointWith({
                total: 1, correct: 1,
                selection: {
                    tasks: [{ goal: 'c', expected: 'z', alternates: [], correct: true }],
                },
            }),
        ];
        // 2 correct out of 3
        expect(aggregateSelectionCorpus(results)).toBeCloseTo(2 / 3, 4);
    });
});

function checkpointWith(opts: {
    total: number;
    correct: number;
    selection?: { tasks: { goal: string; expected: string; alternates: string[]; correct: boolean }[] };
}): CheckpointResult {
    return {
        name: 'cp',
        pillar1_spatial: {
            passed: true,
            metric: opts.total === 0 ? 1 : opts.correct / opts.total,
            total: opts.total,
            correct: opts.correct,
            misses: [],
            handLabeled: { total: 0, correct: 0 },
        },
        pillar2_selection: opts.selection
            ? {
                passed: true,
                metric: 1,
                tasks: opts.selection.tasks.map((t) => ({ ...t })),
            }
            : undefined,
        pillar3_tokens: {
            passed: true,
            metric: 0,
            heuristic: 0,
            renderedChars: 0,
            renderedBytes: 0,
        },
        pillar4_compaction: {
            passed: true,
            metric: 0,
            rawBytes: 0,
            compactedBytes: 0,
            ratio: 0,
            nodesBefore: 0,
            nodesAfter: 0,
        },
    };
}
