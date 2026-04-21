/**
 * Flows sub-package — First-class, named Maestro flows for navigation and verification.
 *
 * Responsible for:
 *   • Discovering `.yaml` flow files in a flows directory
 *   • Merging flow entries with optional manifest metadata (description, tags, params)
 *   • Validating caller-supplied params against declared specs
 */

export {
    FlowRegistry,
    FLOW_MANIFEST_FILENAME,
    FLOW_YAML_SUFFIX,
} from './registry.js';
export type {
    FlowEntry,
    FlowManifest,
    FlowManifestEntry,
    FlowParamSpec,
} from './registry.js';
