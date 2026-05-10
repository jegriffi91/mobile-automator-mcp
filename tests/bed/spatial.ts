/**
 * 3x3 spatial grid tagger.
 *
 * Lives here for now; the future spatial-semantic compactor will absorb this
 * logic. Pure functions, no I/O.
 *
 * Labels are row-major from the top-left:
 *   tl tc tr
 *   ml mc mr
 *   bl bc br
 *
 * Binning uses the bounding box's CENTER point. A full-width banner at the
 * top therefore lands in `tc` (its center is at width/2, smallH/2), which is
 * the semantically correct answer.
 */

import type { GridLabel } from './types.js';
import { GRID_LABELS } from './types.js';

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Compute the 3x3 grid label for a node given its bounds and the root device
 * bounds. Off-screen centers (negative or beyond root extent) are clamped to
 * the nearest cell — this is rare in practice but keeps the function total.
 */
export function gridLabel(node: Bounds, root: Bounds): GridLabel {
    if (root.width <= 0 || root.height <= 0) {
        return 'mc';
    }

    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;

    // Translate to root-relative coordinates so a root that doesn't start at
    // (0,0) is handled correctly.
    const rx = cx - root.x;
    const ry = cy - root.y;

    const col = clamp(Math.floor((rx / root.width) * 3), 0, 2);
    const row = clamp(Math.floor((ry / root.height) * 3), 0, 2);

    return GRID_LABELS[row * 3 + col];
}

function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}
