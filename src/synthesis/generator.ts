/**
 * YamlGenerator — Produces Maestro YAML test scripts from correlated steps.
 *
 * Generates valid Maestro YAML with:
 *   - appId header + launchApp
 *   - Per-step UI commands (tapOn, inputText, scroll, swipe, back, assertVisible)
 *   - Inline comments documenting correlated network calls and fixture references
 *   - ⚠️ warnings for low-confidence selectors and secure text field placeholders
 */

import * as path from 'path';
import type { CorrelatedStep } from './correlator.js';
import type { UIElement } from '../types.js';
import { assessSelectorQuality } from './selector-quality.js';
import type { RunFlowYamlBlock, FlowStep } from './flow-weaver.js';

export class YamlGenerator {
    private appBundleId: string;

    constructor(appBundleId: string) {
        this.appBundleId = appBundleId;
    }

    /**
     * Generate a complete Maestro YAML test from correlated steps.
     *
     * Phase 5: optional `flowBlocks` are merge-sorted with `steps` by
     * timestamp and rendered as `- runFlow: <relativePath>` directives with
     * summary comments above each. Pass `outputDir` to control how the
     * relative path is computed (defaults to '.').
     */
    toYaml(
        steps: CorrelatedStep[],
        conditions?: string[],
        opts?: {
            flowBlocks?: RunFlowYamlBlock[];
            outputDir?: string;
        },
    ): string {
        const lines: string[] = [
            `appId: ${this.appBundleId}`,
            '---',
            '- launchApp',
        ];

        const flowBlocks = opts?.flowBlocks ?? [];
        const outputDir = opts?.outputDir ?? '.';

        // Merge-sort steps and flow blocks chronologically.
        type Entry =
            | { kind: 'step'; ts: number; step: CorrelatedStep }
            | { kind: 'flow'; ts: number; block: RunFlowYamlBlock };
        const merged: Entry[] = [];
        for (const step of steps) {
            merged.push({
                kind: 'step',
                ts: Date.parse(step.interaction.timestamp),
                step,
            });
        }
        for (const block of flowBlocks) {
            merged.push({
                kind: 'flow',
                ts: Date.parse(block.timestamp),
                block,
            });
        }
        merged.sort((a, b) => a.ts - b.ts);

        for (const entry of merged) {
            if (entry.kind === 'step') {
                this.emitStep(lines, entry.step);
            } else {
                this.emitFlowBlock(lines, entry.block, outputDir);
            }
        }

        // Append user-supplied conditions as comments
        if (conditions && conditions.length > 0) {
            lines.push('');
            lines.push('# ── User-defined assertions (to be implemented) ──');
            for (const condition of conditions) {
                lines.push(`# TODO: ${condition}`);
            }
        }

        return lines.join('\n') + '\n';
    }

    private emitStep(lines: string[], step: CorrelatedStep): void {
        const { interaction, networkCaptures } = step;
        const selector = YamlGenerator.buildSelector(interaction.element);

        // Emit network context comment before the UI action
        if (networkCaptures.length > 0) {
            const summary = networkCaptures
                .map((c) => `${c.event.method} ${c.requestPattern.pathPattern} → ${c.event.statusCode}`)
                .join(', ');
            lines.push('');
            lines.push(`# ── ${this.describeAction(interaction.actionType, interaction.element)} (${summary}) ──`);
        }

        // Emit selector quality warnings
        const warnings = assessSelectorQuality(interaction.element);
        for (const w of warnings) {
            lines.push(`# ⚠️ ${w.message}`);
        }

        switch (interaction.actionType) {
            case 'tap':
                lines.push(`- tapOn:`);
                lines.push(`    ${selector}`);
                break;
            case 'type':
                lines.push(`- tapOn:`);
                lines.push(`    ${selector}`);
                if (interaction.element.isSecure) {
                    lines.push(`# ⚠️ Secure field detected — use -e SECURE_INPUT=<value> at runtime`);
                    lines.push(`- inputText: "\${SECURE_INPUT}"`);
                } else if (interaction.textInput) {
                    lines.push(`- inputText: "${YamlGenerator.escapeYaml(interaction.textInput)}"`);
                }
                break;
            case 'scroll':
                lines.push(`- scroll`);
                break;
            case 'swipe':
                lines.push(`- swipe:`);
                lines.push(`    direction: DOWN`);
                lines.push(`    duration: 400`);
                break;
            case 'scrollUntilVisible':
                lines.push(`- scrollUntilVisible:`);
                lines.push(`    element:`);
                lines.push(`      ${YamlGenerator.buildSelector(interaction.element)}`);
                lines.push(`    direction: DOWN`);
                break;
            case 'swipeUntilVisible':
                lines.push(`- scrollUntilVisible:`);
                lines.push(`    element:`);
                lines.push(`      ${YamlGenerator.buildSelector(interaction.element)}`);
                lines.push(`    direction: RIGHT`);
                break;
            case 'back':
                lines.push(`- back`);
                break;
            case 'assertVisible':
                lines.push(`- assertVisible:`);
                lines.push(`    ${selector}`);
                break;
            default:
                lines.push(`# Unknown action: ${interaction.actionType}`);
        }
    }

    /**
     * Emit a `runFlow:` directive for a recorded sub-flow execution. Adds
     * summary comments (status, duration, step kinds, FAILED markers) and a
     * leading warning comment for cancelled / failed runs.
     */
    private emitFlowBlock(
        lines: string[],
        block: RunFlowYamlBlock,
        outputDir: string,
    ): void {
        lines.push('');

        if (block.cancelled) {
            lines.push(`# ⚠ flow CANCELLED: ${block.flowName}`);
        } else if (!block.succeeded) {
            const failed = block.steps.find((s) => s.status === 'FAILED');
            const reason = failed?.error ? ` — ${failed.error}` : '';
            lines.push(`# ⚠ flow FAILED: ${block.flowName}${reason}`);
        }

        lines.push(
            `# Flow: ${block.flowName} (succeeded: ${block.succeeded}, duration: ` +
                `${Date.parse(block.endTimestamp) - Date.parse(block.timestamp)}ms)`,
        );

        if (block.steps.length > 0) {
            const summary = block.steps
                .map((s: FlowStep) => {
                    const tag = s.status === 'FAILED'
                        ? ` (FAILED${s.error ? ': ' + s.error : ''})`
                        : '';
                    return `${s.kind}${tag}`;
                })
                .join(' → ');
            lines.push(`# Steps: ${summary}`);
        }

        // Compute the relative runFlow: path. Falls back to '<missing-flow-path>'
        // if the source path wasn't captured — Maestro will then surface the
        // missing-file error at runtime, which is the right diagnostic.
        if (block.flowPath) {
            const rel = path.relative(outputDir, block.flowPath) || block.flowPath;
            lines.push(`- runFlow: ${rel}`);
        } else {
            lines.push(`# ⚠ flowPath unavailable — runFlow target unknown`);
            lines.push(`- runFlow: ${block.flowName}`);
        }
    }

    /**
     * Build a Maestro selector string from a UIElement.
     * Priority: id → accessibilityLabel (label) → text
     */
    static buildSelector(element: UIElement): string {
        if (element.id) return `id: "${YamlGenerator.escapeYaml(element.id)}"`;
        if (element.accessibilityLabel) return `label: "${YamlGenerator.escapeYaml(element.accessibilityLabel)}"`;
        if (element.text) return `text: "${YamlGenerator.escapeYaml(element.text)}"`;
        if (element.bounds) return `point: "${element.bounds.x},${element.bounds.y}"`;
        return `text: "unknown"`;
    }

    /**
     * Generate a human-readable description of a UI action.
     */
    private describeAction(action: string, element: UIElement): string {
        const target = element.id || element.accessibilityLabel || element.text || 'element';
        switch (action) {
            case 'tap': return `Tap ${target}`;
            case 'type': return `Type into ${target}`;
            case 'scroll': return 'Scroll';
            case 'swipe': return 'Swipe';
            case 'scrollUntilVisible': return `Scroll to ${target}`;
            case 'swipeUntilVisible': return `Swipe to ${target}`;
            case 'back': return 'Back';
            case 'assertVisible': return `Assert ${target} visible`;
            default: return action;
        }
    }

    /**
     * Escape special characters for YAML string values.
     */
    private static escapeYaml(str: string): string {
        return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
}
