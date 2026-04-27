/**
 * Bounded ring buffer for streaming text output.
 *
 * Capped on both line count and total byte size. Oldest entries are evicted
 * (FIFO) when either cap is exceeded. A single line longer than `maxBytes`
 * is truncated rather than dropped silently — content is preserved with a
 * trailing marker so callers can tell.
 *
 * Used by `TaskRegistry` to retain the recent tail of stdout/stderr from
 * long-running tasks (builds, test runs).
 */

const DEFAULT_MAX_LINES = 500;
const DEFAULT_MAX_BYTES = 100 * 1024;
const TRUNCATION_MARKER = '… [truncated]';

export interface RingBufferOptions {
    /** Maximum retained line count. Default: 500. */
    maxLines?: number;
    /** Maximum retained byte sum (utf8). Default: 100 KiB. */
    maxBytes?: number;
}

export class RingBuffer {
    private readonly maxLines: number;
    private readonly maxBytes: number;
    private readonly lines: string[] = [];
    private readonly lineBytes: number[] = [];
    private byteSum = 0;
    private pushed = 0;

    constructor(opts?: RingBufferOptions) {
        this.maxLines = Math.max(1, opts?.maxLines ?? DEFAULT_MAX_LINES);
        this.maxBytes = Math.max(1, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
    }

    /**
     * Append a line. Evicts oldest entries while either cap is exceeded.
     * Lines longer than the byte cap are truncated to fit (with a marker).
     */
    push(line: string): void {
        this.pushed += 1;

        let stored = line;
        // +1 for the implicit newline separator that callers read out.
        let size = Buffer.byteLength(stored, 'utf8') + 1;

        if (size > this.maxBytes) {
            const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
            const cap = Math.max(1, this.maxBytes - markerBytes - 1);
            // Slice by bytes via Buffer to avoid splitting multi-byte chars mid-codepoint.
            const buf = Buffer.from(stored, 'utf8').subarray(0, cap);
            stored = buf.toString('utf8') + TRUNCATION_MARKER;
            size = Buffer.byteLength(stored, 'utf8') + 1;
        }

        this.lines.push(stored);
        this.lineBytes.push(size);
        this.byteSum += size;

        while (
            this.lines.length > this.maxLines ||
            (this.byteSum > this.maxBytes && this.lines.length > 1)
        ) {
            this.lines.shift();
            const evicted = this.lineBytes.shift() ?? 0;
            this.byteSum -= evicted;
        }
    }

    /**
     * Return a copy of the retained lines. If `maxTail` is given, returns at
     * most the last N retained lines.
     */
    snapshot(maxTail?: number): string[] {
        if (maxTail === undefined || maxTail >= this.lines.length) {
            return this.lines.slice();
        }
        if (maxTail <= 0) return [];
        return this.lines.slice(this.lines.length - maxTail);
    }

    /** Currently retained line count. */
    size(): number {
        return this.lines.length;
    }

    /** Currently retained byte sum (including newline accounting). */
    bytes(): number {
        return this.byteSum;
    }

    /** Lifetime push count, never decreases. */
    totalPushed(): number {
        return this.pushed;
    }

    clear(): void {
        this.lines.length = 0;
        this.lineBytes.length = 0;
        this.byteSum = 0;
    }
}
