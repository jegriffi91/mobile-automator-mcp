/**
 * Minimal dot/bracket path evaluator.
 *
 *   "data.items[0].id"     → obj.data.items[0].id
 *   "data['weird.key']"    → obj.data['weird.key']
 *
 * Deliberately small — if you need wildcards or filters, use a real JSONPath lib.
 */

/** Parse a path string into a list of keys/indices. */
function parsePath(path: string): Array<string | number> {
    const tokens: Array<string | number> = [];
    let i = 0;
    const n = path.length;

    while (i < n) {
        // Skip leading dots between segments.
        if (path[i] === '.') {
            i++;
            continue;
        }

        if (path[i] === '[') {
            const close = path.indexOf(']', i);
            if (close === -1) {
                throw new Error(`Unterminated bracket in path: ${path}`);
            }
            const inner = path.slice(i + 1, close).trim();
            if ((inner.startsWith('"') && inner.endsWith('"')) ||
                (inner.startsWith("'") && inner.endsWith("'"))) {
                tokens.push(inner.slice(1, -1));
            } else if (/^\d+$/.test(inner)) {
                tokens.push(Number(inner));
            } else {
                tokens.push(inner);
            }
            i = close + 1;
            continue;
        }

        // Plain identifier up to the next '.' or '['.
        let j = i;
        while (j < n && path[j] !== '.' && path[j] !== '[') j++;
        const seg = path.slice(i, j);
        if (seg.length > 0) tokens.push(seg);
        i = j;
    }

    return tokens;
}

export function getByPath(obj: unknown, path: string): unknown {
    if (obj === null || obj === undefined) return undefined;
    const tokens = parsePath(path);
    let cur: unknown = obj;
    for (const tok of tokens) {
        if (cur === null || cur === undefined) return undefined;
        if (typeof tok === 'number') {
            if (!Array.isArray(cur)) return undefined;
            cur = cur[tok];
        } else {
            if (typeof cur !== 'object') return undefined;
            cur = (cur as Record<string, unknown>)[tok];
        }
    }
    return cur;
}

export function existsAtPath(obj: unknown, path: string): boolean {
    return getByPath(obj, path) !== undefined;
}
