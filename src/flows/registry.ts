/**
 * FlowRegistry — First-class, named Maestro flows for navigation and verification.
 *
 * A flow is a `.yaml` file inside a flows directory (default: ./flows). Flows are
 * discovered by scanning for `*.yaml` files; the filename (without suffix) is the
 * flow name. An optional `_manifest.json` in the same directory adds metadata
 * (description, tags, parameter specs).
 *
 * Declared params are passed to Maestro as environment variables (-e KEY=VALUE),
 * and referenced inside YAML as ${KEY}.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ── Types ──

export interface FlowParamSpec {
    /** Whether the caller must provide this param. Default: false. */
    required?: boolean;
    /** Default value applied when the caller omits the param. */
    default?: string;
    /** Human-readable description for agents. */
    description?: string;
}

export interface FlowManifestEntry {
    /** Human-readable summary of what the flow does. */
    description?: string;
    /** Free-form tags (e.g., ["auth", "setup"]). */
    tags?: string[];
    /** Declared input parameters passed as Maestro env vars. */
    params?: Record<string, FlowParamSpec>;
}

export interface FlowManifest {
    /** Map from flow name → manifest entry. */
    flows?: Record<string, FlowManifestEntry>;
}

export interface FlowEntry {
    /** Flow name (derived from filename when no manifest entry exists). */
    name: string;
    /** Absolute path to the flow's YAML file. */
    path: string;
    /** Optional human-readable description from the manifest. */
    description?: string;
    /** Optional tags from the manifest. */
    tags?: string[];
    /** Parameter specs from the manifest (if any). */
    params?: Record<string, FlowParamSpec>;
}

// ── Constants ──

export const FLOW_MANIFEST_FILENAME = '_manifest.json';
export const FLOW_YAML_SUFFIX = '.yaml';

// ── Implementation ──

export class FlowRegistry {
    /** Load the optional manifest. Returns an empty manifest if the file is missing or malformed. */
    static async loadManifest(flowsDir: string): Promise<FlowManifest> {
        const manifestPath = path.join(flowsDir, FLOW_MANIFEST_FILENAME);
        try {
            const raw = await fs.readFile(manifestPath, 'utf-8');
            const parsed = JSON.parse(raw) as FlowManifest;
            return parsed ?? {};
        } catch {
            return {};
        }
    }

    /**
     * List all flows in `flowsDir`. Scans for `*.yaml` files (excluding names
     * starting with `_`) and merges each with the corresponding manifest entry
     * if one exists. Throws with ENOENT if `flowsDir` does not exist.
     */
    static async list(flowsDir: string): Promise<FlowEntry[]> {
        const entries = await fs.readdir(flowsDir, { withFileTypes: true });
        const manifest = await this.loadManifest(flowsDir);
        const manifestFlows = manifest.flows ?? {};

        const flows: FlowEntry[] = [];
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!entry.name.endsWith(FLOW_YAML_SUFFIX)) continue;
            if (entry.name.startsWith('_')) continue;

            const name = entry.name.slice(0, -FLOW_YAML_SUFFIX.length);
            const absPath = path.join(flowsDir, entry.name);
            const meta = manifestFlows[name];

            flows.push({
                name,
                path: absPath,
                description: meta?.description,
                tags: meta?.tags,
                params: meta?.params,
            });
        }

        flows.sort((a, b) => a.name.localeCompare(b.name));
        return flows;
    }

    /**
     * Resolve a flow by name. Returns the YAML path and manifest metadata.
     * Throws if the flow file does not exist.
     */
    static async resolve(flowsDir: string, name: string): Promise<FlowEntry> {
        const yamlPath = path.join(flowsDir, `${name}${FLOW_YAML_SUFFIX}`);
        try {
            await fs.access(yamlPath);
        } catch {
            throw new Error(
                `Flow "${name}" not found at ${yamlPath}. ` +
                `Ensure ${name}${FLOW_YAML_SUFFIX} exists under the flows directory.`,
            );
        }
        const manifest = await this.loadManifest(flowsDir);
        const meta = manifest.flows?.[name];
        return {
            name,
            path: yamlPath,
            description: meta?.description,
            tags: meta?.tags,
            params: meta?.params,
        };
    }

    /**
     * Validate caller-supplied params against the flow's manifest and apply
     * defaults. Supplied params not declared in the manifest are forwarded
     * as-is — the manifest is optional documentation, not a hard gate.
     * Throws if a required param is missing.
     */
    static applyParams(
        flow: FlowEntry,
        supplied: Record<string, string> | undefined,
    ): Record<string, string> {
        const specs = flow.params ?? {};
        const result: Record<string, string> = {};
        const missing: string[] = [];

        for (const [key, spec] of Object.entries(specs)) {
            if (supplied && key in supplied) {
                result[key] = supplied[key];
            } else if (spec.default !== undefined) {
                result[key] = spec.default;
            } else if (spec.required) {
                missing.push(key);
            }
        }

        if (supplied) {
            for (const [key, value] of Object.entries(supplied)) {
                if (!(key in result)) {
                    result[key] = value;
                }
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `Flow "${flow.name}" requires parameter(s): ${missing.join(', ')}. ` +
                `Pass them via the "params" input.`,
            );
        }

        return result;
    }
}
