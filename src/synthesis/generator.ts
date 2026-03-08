/**
 * YamlGenerator — Produces Maestro YAML test scripts from correlated steps.
 *
 * Generates valid Maestro YAML with:
 *   - appId header + launchApp
 *   - Per-step UI commands (tapOn, inputText, scroll, swipe, back, assertVisible)
 *   - Inline comments documenting correlated network calls and fixture references
 */

import type { CorrelatedStep } from './correlator.js';
import type { UIElement } from '../types.js';

export class YamlGenerator {
    private appBundleId: string;

    constructor(appBundleId: string) {
        this.appBundleId = appBundleId;
    }

    /**
     * Generate a complete Maestro YAML test from correlated steps.
     */
    toYaml(steps: CorrelatedStep[], conditions?: string[]): string {
        const lines: string[] = [
            `appId: ${this.appBundleId}`,
            '---',
            '- launchApp',
        ];

        for (const step of steps) {
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

            switch (interaction.actionType) {
                case 'tap':
                    lines.push(`- tapOn:`);
                    lines.push(`    ${selector}`);
                    break;
                case 'type':
                    lines.push(`- tapOn:`);
                    lines.push(`    ${selector}`);
                    if (interaction.textInput) {
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
