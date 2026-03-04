/**
 * Synthesis sub-package — Test script generation from recorded data.
 *
 * Responsible for:
 *   • Correlating UI interactions with network events by timestamp
 *   • Generating declarative Maestro YAML test scripts
 *   • Embedding JavaScript evalScript assertions for analytics/SDUI
 */

export { Correlator } from './correlator.js';
export type { CorrelatedStep } from './correlator.js';
export { YamlGenerator } from './generator.js';
