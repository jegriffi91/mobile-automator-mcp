/**
 * Minimal JSON Patch applier (RFC 6902 subset).
 *
 * Supports `replace`, `add`, and `remove` ops with RFC 6901 JSON Pointer paths.
 * Enough for the motivating use case (override loginStatus → test routing)
 * without pulling in a third-party lib.
 */

export interface JsonPatchOp {
    op: 'replace' | 'add' | 'remove';
    path: string;
    value?: unknown;
}

export class JsonPatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JsonPatchError';
    }
}

/**
 * Apply a sequence of patch operations to a JSON document. Mutates the input
 * and also returns it for convenience.
 *
 * Path rules (RFC 6901):
 *   - `""` refers to the whole document
 *   - `"/foo/bar"` navigates keys
 *   - `"/arr/0"` indexes into arrays
 *   - `"/arr/-"` appends to an array (for `add`)
 *   - `~0` unescapes to `~`, `~1` unescapes to `/`
 */
export function applyPatch<T = unknown>(doc: T, ops: readonly JsonPatchOp[]): T {
    let current: unknown = doc;
    for (const op of ops) {
        current = applyOne(current, op);
    }
    return current as T;
}

function applyOne(doc: unknown, op: JsonPatchOp): unknown {
    const tokens = parsePointer(op.path);

    if (tokens.length === 0) {
        // Root replacement.
        if (op.op === 'replace' || op.op === 'add') return op.value;
        if (op.op === 'remove') {
            throw new JsonPatchError('Cannot remove the root document');
        }
    }

    const parent = navigate(doc, tokens.slice(0, -1));
    const last = tokens[tokens.length - 1];

    if (Array.isArray(parent)) {
        applyArrayOp(parent, last, op);
    } else if (parent !== null && typeof parent === 'object') {
        applyObjectOp(parent as Record<string, unknown>, last, op);
    } else {
        throw new JsonPatchError(
            `Cannot apply ${op.op} at "${op.path}": parent is not an object or array`,
        );
    }

    return doc;
}

function applyObjectOp(parent: Record<string, unknown>, key: string, op: JsonPatchOp): void {
    switch (op.op) {
        case 'replace':
            if (!(key in parent)) {
                throw new JsonPatchError(`Cannot replace missing key "${key}" at ${op.path}`);
            }
            parent[key] = op.value;
            return;
        case 'add':
            parent[key] = op.value;
            return;
        case 'remove':
            if (!(key in parent)) {
                throw new JsonPatchError(`Cannot remove missing key "${key}" at ${op.path}`);
            }
            delete parent[key];
            return;
    }
}

function applyArrayOp(parent: unknown[], token: string, op: JsonPatchOp): void {
    if (token === '-') {
        if (op.op !== 'add') {
            throw new JsonPatchError(`"-" is only valid with add, got ${op.op} at ${op.path}`);
        }
        parent.push(op.value);
        return;
    }

    const index = Number(token);
    if (!Number.isInteger(index) || index < 0) {
        throw new JsonPatchError(`Invalid array index "${token}" at ${op.path}`);
    }

    switch (op.op) {
        case 'replace':
            if (index >= parent.length) {
                throw new JsonPatchError(`Index ${index} out of bounds at ${op.path}`);
            }
            parent[index] = op.value;
            return;
        case 'add':
            if (index > parent.length) {
                throw new JsonPatchError(`Index ${index} out of bounds at ${op.path}`);
            }
            parent.splice(index, 0, op.value);
            return;
        case 'remove':
            if (index >= parent.length) {
                throw new JsonPatchError(`Index ${index} out of bounds at ${op.path}`);
            }
            parent.splice(index, 1);
            return;
    }
}

function navigate(doc: unknown, tokens: readonly string[]): unknown {
    let node: unknown = doc;
    for (const token of tokens) {
        if (Array.isArray(node)) {
            const idx = Number(token);
            if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) {
                throw new JsonPatchError(`Invalid array index "${token}" during navigation`);
            }
            node = node[idx];
        } else if (node !== null && typeof node === 'object') {
            const rec = node as Record<string, unknown>;
            if (!(token in rec)) {
                throw new JsonPatchError(`Missing key "${token}" during navigation`);
            }
            node = rec[token];
        } else {
            throw new JsonPatchError(`Cannot navigate into primitive at token "${token}"`);
        }
    }
    return node;
}

function parsePointer(pointer: string): string[] {
    if (pointer === '') return [];
    if (!pointer.startsWith('/')) {
        throw new JsonPatchError(`JSON Pointer must be empty or start with "/": ${pointer}`);
    }
    return pointer
        .slice(1)
        .split('/')
        .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}
