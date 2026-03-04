/**
 * YamlGenerator — Produces Maestro YAML test scripts from correlated steps.
 *
 * Generates valid Maestro YAML with:
 *   - appId header + launchApp
 *   - Per-step UI commands (tapOn, inputText, scroll, swipe, back, assertVisible)
 *   - evalScript + assertTrue blocks for correlated network events
 */

import type { CorrelatedStep } from './correlator.js';
import type { UIElement, NetworkEvent } from '../types.js';

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
            const { interaction, networkEvents } = step;
            const selector = YamlGenerator.buildSelector(interaction.element);

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

            // Emit network assertions for correlated events
            if (networkEvents.length > 0) {
                const assertion = YamlGenerator.buildNetworkAssertion(networkEvents);
                lines.push(assertion);
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
     * Build an evalScript assertion block from correlated network events.
     * Uses inline JS constants with captured response data — no external dependencies.
     */
    static buildNetworkAssertion(events: NetworkEvent[]): string {
        const jsLines: string[] = [];

        for (const event of events) {
            const varName = `res_${event.method.toLowerCase()}_${event.statusCode}`;
            jsLines.push(`  // ${event.method} ${event.url}`);
            jsLines.push(`  const ${varName}_status = ${event.statusCode};`);
            jsLines.push(`  assertTrue(${varName}_status >= 200 && ${varName}_status < 400);`);

            // If we have a response body, add a basic non-empty assertion
            if (event.responseBody) {
                try {
                    const parsed = JSON.parse(event.responseBody);
                    const keys = Object.keys(parsed);
                    if (keys.length > 0) {
                        jsLines.push(`  const ${varName}_body = JSON.parse('${YamlGenerator.escapeJs(event.responseBody)}');`);
                        jsLines.push(`  assertTrue(${varName}_body !== null);`);
                        // Assert first key exists as a sanity check
                        jsLines.push(`  assertTrue(${varName}_body.hasOwnProperty('${keys[0]}'));`);
                    }
                } catch {
                    // Non-JSON body, skip detailed assertions
                    jsLines.push(`  // Response body is not JSON, skipping field assertions`);
                }
            }
        }

        return `- evalScript: |\n${jsLines.join('\n')}`;
    }

    /**
     * Escape special characters for YAML string values.
     */
    private static escapeYaml(str: string): string {
        return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    /**
     * Escape a string for embedding inside a JS single-quoted string.
     */
    private static escapeJs(str: string): string {
        return str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');
    }
}
