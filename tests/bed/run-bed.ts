/**
 * iOS Accuracy + Token-Budget Test Bed driver.
 *
 * Runs against a live iOS simulator. Walks the verification flow YAML one
 * action at a time; at each `checkpoint:` marker it dumps the live
 * hierarchy, runs the baseline compactor, and scores four pillars. Writes a
 * timestamped JSON report and exits 0/1 on pass/fail.
 *
 * Usage:
 *   npm run test:bed                       # pillars 1, 3 (heuristic), 4
 *   npm run test:bed -- --with-llm         # all four pillars (uses claude -p)
 *
 * Exit codes:
 *   0 — passing baseline
 *   1 — one or more pillars failed
 *   2 — environment setup error (no sim, no Maestro, no claude when needed)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { getExecEnv, resolveMaestroBin as resolveMaestroBinCore } from '../../src/maestro/env.js';
import { DriverFactory, type AutomationDriver } from '../../src/maestro/driver.js';
import type { UIActionType, UIElement } from '../../src/types.js';
import { compactBaseline } from './compactor-baseline.js';
import {
    scoreSpatialTags,
    scoreElementSelection,
    scoreTokenBudget,
    scoreCompactionRatio,
    aggregateSelection,
    aggregateSpatialCorpus,
    aggregateSelectionCorpus,
} from './scorer.js';
import { pickElement } from './picker.js';
import type {
    BedReport,
    CheckpointResult,
    CheckpointSpec,
    BedFlowSpec,
    ElementSelector,
    SpatialTruthCorpus,
    TaskCorpus,
    TaskResult,
} from './types.js';
import { PILLAR_THRESHOLDS, TOKEN_BUDGET } from './types.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI ──

interface BedConfig {
    deviceId?: string;
    appId?: string;
    screenFilter?: string;
    withLlm: boolean;
}

function parseArgs(): BedConfig {
    const args = process.argv.slice(2);
    let withLlm = false;
    let deviceId: string | undefined;
    let appId: string | undefined;
    let screenFilter: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--with-llm') withLlm = true;
        else if (a === '--device-id' && args[i + 1]) { deviceId = args[++i]; }
        else if (a === '--app-id' && args[i + 1]) { appId = args[++i]; }
        else if (a === '--filter' && args[i + 1]) {
            const m = args[++i].match(/^screen=(.+)$/);
            if (m) screenFilter = m[1];
        }
    }
    return { withLlm, deviceId, appId, screenFilter };
}

// ── Preflight ──

async function checkBootedIosSim(): Promise<{ booted: boolean; deviceId?: string }> {
    try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
        const data = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; state: string }>> };
        for (const runtime in data.devices) {
            for (const device of data.devices[runtime]) {
                if (device.state === 'Booted') return { booted: true, deviceId: device.udid };
            }
        }
    } catch {
        // xcrun not available
    }
    return { booted: false };
}

async function checkMaestroBin(): Promise<string | null> {
    const bin = resolveMaestroBinCore();
    try {
        if (bin === 'maestro') {
            await execFileAsync(bin, ['--version'], { env: getExecEnv(), timeout: 5000 });
            return bin;
        }
        await fs.access(bin);
        return bin;
    } catch {
        return null;
    }
}

async function checkClaudeCli(): Promise<boolean> {
    try {
        await execFileAsync('claude', ['--version'], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function launchApp(deviceId: string, appId: string): Promise<void> {
    await execFileAsync('xcrun', ['simctl', 'launch', deviceId, appId], { timeout: 30_000 });
}

// ── Corpus loading ──

async function loadFlow(): Promise<BedFlowSpec> {
    const p = path.join(__dirname, 'flows', 'ios-bed-verification.yaml');
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = yaml.load(raw) as BedFlowSpec;
    return parsed;
}

async function loadTaskCorpus(): Promise<TaskCorpus> {
    const p = path.join(__dirname, 'corpus', 'tasks.yaml');
    const raw = await fs.readFile(p, 'utf-8');
    return yaml.load(raw) as TaskCorpus;
}

async function loadSpatialTruth(): Promise<SpatialTruthCorpus> {
    const p = path.join(__dirname, 'corpus', 'spatial-truth.yaml');
    const raw = await fs.readFile(p, 'utf-8');
    return yaml.load(raw) as SpatialTruthCorpus;
}

// ── Step dispatch ──

function selectorToElement(sel: ElementSelector): UIElement {
    return {
        id: sel.id,
        testId: sel.testId,
        text: sel.text,
        accessibilityLabel: sel.accessibilityLabel,
    };
}

interface StepError {
    step: number;
    message: string;
}

async function dispatchStep(
    driver: AutomationDriver,
    step: CheckpointSpec,
    config: { deviceId: string; appId: string },
): Promise<{ kind: 'action' } | { kind: 'checkpoint'; name: string } | { kind: 'error'; message: string }> {
    if ('checkpoint' in step) {
        return { kind: 'checkpoint', name: step.checkpoint };
    }
    if ('launchApp' in step) {
        await launchApp(config.deviceId, config.appId);
        return { kind: 'action' };
    }
    if ('tap' in step) {
        const r = await driver.executeAction('tap' as UIActionType, selectorToElement(step.tap));
        return r.success ? { kind: 'action' } : { kind: 'error', message: r.error ?? 'tap failed' };
    }
    if ('inputText' in step) {
        const r = await driver.executeAction(
            'inputText' as UIActionType,
            selectorToElement(step.inputText.into),
            step.inputText.text,
        );
        return r.success ? { kind: 'action' } : { kind: 'error', message: r.error ?? 'inputText failed' };
    }
    if ('assertVisible' in step) {
        const r = await driver.executeAction('assertVisible' as UIActionType, selectorToElement(step.assertVisible));
        return r.success ? { kind: 'action' } : { kind: 'error', message: r.error ?? 'assertVisible failed' };
    }
    return { kind: 'error', message: `unknown step: ${JSON.stringify(step)}` };
}

// ── Main loop ──

async function main(): Promise<void> {
    const config = parseArgs();

    console.log('\n📏 mobile-automator-mcp Test Bed');
    console.log(`   With LLM: ${config.withLlm ? 'yes (claude -p)' : 'no (heuristic-only)'}`);

    // Preflight
    const maestroBin = await checkMaestroBin();
    if (!maestroBin) {
        console.error('❌ Maestro CLI not found.');
        process.exit(2);
    }
    console.log(`   ✅ Maestro CLI (${maestroBin})`);

    let deviceId = config.deviceId;
    if (!deviceId) {
        const sim = await checkBootedIosSim();
        if (!sim.booted) {
            console.error('❌ No booted iOS simulator. Boot one with `xcrun simctl boot <udid>`.');
            process.exit(2);
        }
        deviceId = sim.deviceId!;
    }
    console.log(`   ✅ iOS simulator booted (${deviceId})`);

    if (config.withLlm) {
        const hasClaude = await checkClaudeCli();
        if (!hasClaude) {
            console.error('❌ --with-llm requires the `claude` CLI on PATH.');
            process.exit(2);
        }
        console.log('   ✅ claude CLI available');
    }

    // Corpora
    const flow = await loadFlow();
    const appId = config.appId ?? flow.appId;
    const spatial = await loadSpatialTruth();
    const tasks: TaskCorpus = config.withLlm
        ? await loadTaskCorpus()
        : { tasks: [] };

    if (config.withLlm) {
        console.log(`   📋 ${tasks.tasks.length} tasks queued (~${tasks.tasks.length * 3}s LLM wall-clock)`);
    }

    // Driver
    const driver = await DriverFactory.create();
    await driver.start(deviceId);

    const checkpoints: CheckpointResult[] = [];
    const stepErrors: StepError[] = [];

    try {
        let lastCheckpointName: string | null = null;
        let pendingCheckpointFailure: string | undefined;
        for (let i = 0; i < flow.steps.length; i++) {
            const step = flow.steps[i];
            const result = await dispatchStep(driver, step, { deviceId, appId });

            if (result.kind === 'error') {
                stepErrors.push({ step: i, message: result.message });
                pendingCheckpointFailure = result.message;
                continue;
            }
            if (result.kind === 'action') continue;

            // Checkpoint: dump + score.
            lastCheckpointName = result.name;
            if (config.screenFilter && !result.name.includes(config.screenFilter)) {
                pendingCheckpointFailure = undefined;
                continue;
            }
            console.log(`\n  ▶ checkpoint: ${result.name}`);

            try {
                const { hierarchy } = await driver.dumpHierarchyUntilSettled();
                const screen = compactBaseline({ raw: hierarchy });
                const p1 = scoreSpatialTags(screen, result.name, spatial.entries);
                const p4 = scoreCompactionRatio(screen);

                // Pillar 2 (if --with-llm) + pillar 3 (real input_tokens)
                let p2: CheckpointResult['pillar2_selection'];
                let realTokens: number | undefined;
                if (config.withLlm) {
                    const screenTasks = tasks.tasks.filter((t) => t.screen === result.name);
                    const taskResults: TaskResult[] = [];
                    for (const task of screenTasks) {
                        const pick = await pickElement({ compactedScreen: screen.text, goal: task.goal });
                        taskResults.push(scoreElementSelection(task, pick));
                        if (pick.inputTokens !== undefined) {
                            realTokens = Math.max(realTokens ?? 0, pick.inputTokens);
                        }
                    }
                    const agg = aggregateSelection(taskResults);
                    p2 = { ...agg, tasks: taskResults };
                }

                const p3 = scoreTokenBudget(screen.text, realTokens);

                checkpoints.push({
                    name: result.name,
                    pillar1_spatial: p1,
                    pillar2_selection: p2,
                    pillar3_tokens: p3,
                    pillar4_compaction: p4,
                    checkpointFailed: pendingCheckpointFailure,
                });
                pendingCheckpointFailure = undefined;

                const tokenLabel = p3.real !== undefined ? `real=${p3.real}` : `heuristic=${p3.heuristic}`;
                console.log(
                    `    p1=${p1.metric.toFixed(3)} ${p1.passed ? '✅' : '❌'}  ` +
                    `p2=${p2 ? p2.metric.toFixed(3) : 'skip'} ${p2 ? (p2.passed ? '✅' : '❌') : ''}  ` +
                    `p3=${tokenLabel} ${p3.passed ? '✅' : '❌'}  ` +
                    `p4=${p4.metric.toFixed(3)} ℹ️`,
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                checkpoints.push({
                    name: result.name,
                    pillar1_spatial: emptySpatial(),
                    pillar3_tokens: emptyTokens(),
                    pillar4_compaction: emptyCompaction(),
                    checkpointFailed: message,
                });
                console.log(`    ❌ checkpoint crashed: ${message}`);
            }
        }
        if (lastCheckpointName === null) {
            console.log('   ⚠️  No checkpoint: markers found in the flow.');
        }
    } finally {
        await driver.stop();
    }

    // Summary + report
    const passed = checkpoints.every(
        (c) =>
            c.pillar1_spatial.passed &&
            c.pillar3_tokens.passed &&
            (c.pillar2_selection === undefined || c.pillar2_selection.passed),
    ) && checkpoints.length > 0;

    const spatialCorpus = aggregateSpatialCorpus(checkpoints);
    const selectionCorpus = aggregateSelectionCorpus(checkpoints);
    const maxHeuristic = Math.max(0, ...checkpoints.map((c) => c.pillar3_tokens.heuristic));
    const maxReal = checkpoints
        .map((c) => c.pillar3_tokens.real)
        .filter((v): v is number => v !== undefined);
    const avgCompaction =
        checkpoints.length === 0
            ? 0
            : checkpoints.reduce((sum, c) => sum + c.pillar4_compaction.ratio, 0) / checkpoints.length;

    const report: BedReport = {
        timestamp: new Date().toISOString(),
        deviceId,
        appId,
        withLlm: config.withLlm,
        checkpoints,
        summary: {
            passed:
                passed &&
                spatialCorpus >= PILLAR_THRESHOLDS.spatialMinCorpus &&
                (selectionCorpus === undefined || selectionCorpus >= PILLAR_THRESHOLDS.selectionMinCorpus),
            spatialCorrectnessCorpus: spatialCorpus,
            selectionAccuracyCorpus: selectionCorpus,
            maxHeuristicTokens: maxHeuristic,
            maxRealTokens: maxReal.length > 0 ? Math.max(...maxReal) : undefined,
            avgCompactionRatio: avgCompaction,
        },
    };

    const reportDir = path.join(__dirname, 'reports');
    await fs.mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${report.timestamp.replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    printSummary(report);
    console.log(`\n📄 Report: ${reportPath}`);

    if (stepErrors.length > 0) {
        console.log(`\n⚠️  ${stepErrors.length} step(s) errored during execution:`);
        for (const e of stepErrors) console.log(`   step ${e.step}: ${e.message}`);
    }

    process.exit(report.summary.passed ? 0 : 1);
}

function emptySpatial(): CheckpointResult['pillar1_spatial'] {
    return {
        passed: false,
        metric: 0,
        total: 0,
        correct: 0,
        misses: [],
        handLabeled: { total: 0, correct: 0 },
    };
}
function emptyTokens(): CheckpointResult['pillar3_tokens'] {
    return {
        passed: false,
        metric: 0,
        heuristic: 0,
        renderedChars: 0,
        renderedBytes: 0,
    };
}
function emptyCompaction(): CheckpointResult['pillar4_compaction'] {
    return {
        passed: true,
        metric: 0,
        rawBytes: 0,
        compactedBytes: 0,
        ratio: 0,
        nodesBefore: 0,
        nodesAfter: 0,
    };
}

function printSummary(r: BedReport): void {
    console.log('\n' + '═'.repeat(70));
    console.log('  TEST BED RESULTS');
    console.log('═'.repeat(70));
    console.log(`  Checkpoints:           ${r.checkpoints.length}`);
    console.log(`  Spatial correctness:   ${(r.summary.spatialCorrectnessCorpus * 100).toFixed(1)}% (cap ${PILLAR_THRESHOLDS.spatialMinCorpus * 100}%)`);
    if (r.summary.selectionAccuracyCorpus !== undefined) {
        console.log(`  Selection accuracy:    ${(r.summary.selectionAccuracyCorpus * 100).toFixed(1)}% (cap ${PILLAR_THRESHOLDS.selectionMinCorpus * 100}%)`);
    }
    console.log(`  Max heuristic tokens:  ${r.summary.maxHeuristicTokens} (cap ${TOKEN_BUDGET.hardFailHeuristic})`);
    if (r.summary.maxRealTokens !== undefined) {
        console.log(`  Max real input_tokens: ${r.summary.maxRealTokens} (cap ${TOKEN_BUDGET.hardFailReal})`);
    }
    console.log(`  Avg compaction ratio:  ${(r.summary.avgCompactionRatio * 100).toFixed(1)}%`);
    console.log('─'.repeat(70));
    console.log(`  Verdict: ${r.summary.passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log('═'.repeat(70));
}

main().catch((err) => {
    console.error('💥 Bed runner crashed:', err);
    process.exit(2);
});
