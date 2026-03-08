/**
 * Synthesis sub-package — Test script generation from recorded data.
 *
 * Responsible for:
 *   • Correlating UI interactions with network events by timestamp
 *   • Generating declarative Maestro YAML test scripts
 *   • Writing WireMock stubs and response fixtures for network replay
 */

export { Correlator } from './correlator.js';
export type { CorrelatedStep, CorrelatedNetworkCapture } from './correlator.js';
export { YamlGenerator } from './generator.js';
export { StubWriter } from './stub-writer.js';
export type { MockingConfig, StubManifest, StubRoute } from './stub-writer.js';
