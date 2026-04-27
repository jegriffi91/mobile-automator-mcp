/**
 * spawnStream — line-streamed wrapper around child_process.spawn.
 *
 * Each stdout/stderr line invokes `onLine(line, stream)` and is appended to a
 * per-stream byte-capped accumulator. Mirrors abort/timeout semantics from
 * `execFileWithAbort` (SIGTERM → 5s grace → SIGKILL) so the build helpers can
 * swap in transparently.
 *
 * Resolution rules: resolves on `child.on('close')` for normal/timed-out/
 * aborted exits — the caller interprets the result. Rejects only on spawn-
 * time errors (ENOENT, EACCES, etc).
 */

import { spawn, type SpawnOptions } from 'child_process';
import * as readline from 'readline';

const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

export interface SpawnStreamOptions extends SpawnOptions {
    signal?: AbortSignal;
    onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
    maxBufferBytes?: number;
    timeout?: number;
}

export interface SpawnStreamResult {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
}

/**
 * Head+tail truncation: when the accumulator overflows, keep the first 25%
 * and last 75% with a marker between them.
 */
class CappedAccumulator {
    private head = '';
    private tail = '';
    private headDone = false;
    private overflow = 0;
    private readonly headCap: number;
    private readonly tailCap: number;

    constructor(private readonly maxBytes: number) {
        this.headCap = Math.floor(maxBytes * 0.25);
        this.tailCap = maxBytes - this.headCap;
    }

    append(s: string): void {
        const sBytes = Buffer.byteLength(s, 'utf8');
        if (!this.headDone) {
            const remainingHead = this.headCap - Buffer.byteLength(this.head, 'utf8');
            if (sBytes <= remainingHead) {
                this.head += s;
                return;
            }
            // Spill into tail.
            const headPart = sliceUtf8(s, remainingHead);
            this.head += headPart;
            this.headDone = true;
            const rest = s.slice(headPart.length);
            this.appendToTail(rest);
            return;
        }
        this.appendToTail(s);
    }

    private appendToTail(s: string): void {
        this.tail += s;
        const tailBytes = Buffer.byteLength(this.tail, 'utf8');
        if (tailBytes > this.tailCap) {
            // Drop from front of tail; track overflow byte count.
            const dropBytes = tailBytes - this.tailCap;
            const buf = Buffer.from(this.tail, 'utf8');
            this.tail = buf.subarray(dropBytes).toString('utf8');
            this.overflow += dropBytes;
        }
    }

    toString(): string {
        if (!this.headDone || this.overflow === 0) {
            return this.head + this.tail;
        }
        return `${this.head}\n... [truncated ${this.overflow} bytes] ...\n${this.tail}`;
    }
}

function sliceUtf8(s: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
    return buf.toString('utf8');
}

export async function spawnStream(
    file: string,
    args: string[],
    options: SpawnStreamOptions = {},
): Promise<SpawnStreamResult> {
    const { signal, onLine, maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES, timeout, ...spawnOpts } =
        options;

    return new Promise((resolve, reject) => {
        // Explicitly do NOT use detached:true — matches execFileWithAbort.
        const child = spawn(file, args, { ...spawnOpts, detached: false });
        const stdoutAcc = new CappedAccumulator(maxBufferBytes);
        const stderrAcc = new CappedAccumulator(maxBufferBytes);

        let aborted = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let spawnFailed = false;

        const sendKill = () => {
            try {
                child.kill('SIGTERM');
            } catch {
                // already exited
            }
            killTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // gone
                }
            }, KILL_GRACE_MS);
            if (killTimer.unref) killTimer.unref();
        };

        const onAbort = () => {
            aborted = true;
            sendKill();
        };

        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        if (timeout && timeout > 0) {
            timeoutTimer = setTimeout(() => {
                timedOut = true;
                sendKill();
            }, timeout);
            if (timeoutTimer.unref) timeoutTimer.unref();
        }

        if (child.stdout) {
            const rl = readline.createInterface({
                input: child.stdout,
                crlfDelay: Infinity,
            });
            rl.on('line', (line) => {
                stdoutAcc.append(line + '\n');
                onLine?.(line, 'stdout');
            });
        }
        if (child.stderr) {
            const rl = readline.createInterface({
                input: child.stderr,
                crlfDelay: Infinity,
            });
            rl.on('line', (line) => {
                stderrAcc.append(line + '\n');
                onLine?.(line, 'stderr');
            });
        }

        child.on('error', (err) => {
            spawnFailed = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (killTimer) clearTimeout(killTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(err);
        });

        child.on('close', (code, sig) => {
            if (spawnFailed) return;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (killTimer) clearTimeout(killTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({
                stdout: stdoutAcc.toString(),
                stderr: stderrAcc.toString(),
                code,
                signal: sig,
                timedOut,
                aborted,
            });
        });
    });
}
