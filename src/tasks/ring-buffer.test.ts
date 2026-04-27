import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
    it('retains pushes within caps and preserves FIFO order', () => {
        const buf = new RingBuffer({ maxLines: 5 });
        buf.push('a');
        buf.push('b');
        buf.push('c');
        expect(buf.size()).toBe(3);
        expect(buf.snapshot()).toEqual(['a', 'b', 'c']);
    });

    it('evicts oldest lines once line cap is exceeded', () => {
        const buf = new RingBuffer({ maxLines: 3 });
        buf.push('a');
        buf.push('b');
        buf.push('c');
        buf.push('d');
        buf.push('e');
        expect(buf.size()).toBe(3);
        expect(buf.snapshot()).toEqual(['c', 'd', 'e']);
    });

    it('evicts oldest lines once byte cap is exceeded', () => {
        // each 'aaaa' line = 4 + 1 (newline) = 5 bytes; cap at 12 bytes → keep 2 lines
        const buf = new RingBuffer({ maxLines: 100, maxBytes: 12 });
        buf.push('aaaa');
        buf.push('bbbb');
        buf.push('cccc');
        expect(buf.size()).toBeLessThanOrEqual(2);
        expect(buf.snapshot()).toEqual(['bbbb', 'cccc']);
        expect(buf.bytes()).toBeLessThanOrEqual(12);
    });

    it('truncates a single line exceeding the byte cap (preserves rather than drops)', () => {
        const buf = new RingBuffer({ maxLines: 10, maxBytes: 64 });
        const huge = 'x'.repeat(500);
        buf.push(huge);
        expect(buf.size()).toBe(1);
        const snap = buf.snapshot();
        expect(snap[0].endsWith('… [truncated]')).toBe(true);
        // Stored size should fit within the cap.
        expect(Buffer.byteLength(snap[0], 'utf8') + 1).toBeLessThanOrEqual(64);
    });

    it('snapshot returns a copy, not a live reference', () => {
        const buf = new RingBuffer();
        buf.push('a');
        buf.push('b');
        const snap = buf.snapshot();
        snap.push('mutated');
        expect(buf.snapshot()).toEqual(['a', 'b']);
    });

    it('snapshot(maxTail) returns the last N lines only', () => {
        const buf = new RingBuffer();
        for (let i = 0; i < 10; i++) buf.push(`line-${i}`);
        expect(buf.snapshot(3)).toEqual(['line-7', 'line-8', 'line-9']);
        expect(buf.snapshot(0)).toEqual([]);
        expect(buf.snapshot(100)).toHaveLength(10);
    });

    it('totalPushed is monotonic and includes evicted lines', () => {
        const buf = new RingBuffer({ maxLines: 2 });
        buf.push('a');
        buf.push('b');
        buf.push('c');
        buf.push('d');
        expect(buf.totalPushed()).toBe(4);
        expect(buf.size()).toBe(2);
    });

    it('clear() resets state but not totalPushed', () => {
        const buf = new RingBuffer();
        buf.push('a');
        buf.push('b');
        const pushedBefore = buf.totalPushed();
        buf.clear();
        expect(buf.size()).toBe(0);
        expect(buf.bytes()).toBe(0);
        expect(buf.snapshot()).toEqual([]);
        expect(buf.totalPushed()).toBe(pushedBefore);
    });

    it('handles empty input', () => {
        const buf = new RingBuffer();
        expect(buf.size()).toBe(0);
        expect(buf.bytes()).toBe(0);
        expect(buf.snapshot()).toEqual([]);
        expect(buf.totalPushed()).toBe(0);
    });
});
