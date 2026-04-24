import { describe, it, expect } from 'vitest';
import { applyPatch, JsonPatchError } from './json-patch.js';

describe('applyPatch — replace', () => {
    it('replaces a nested object field', () => {
        const doc = { data: { customerStatusV3: { loginStatus: 'SUCCESS' } } };
        const out = applyPatch(doc, [
            { op: 'replace', path: '/data/customerStatusV3/loginStatus', value: 'OP2_INTERCEPT' },
        ]);
        expect(out).toEqual({ data: { customerStatusV3: { loginStatus: 'OP2_INTERCEPT' } } });
    });

    it('replaces an array element by index', () => {
        const doc = { items: ['a', 'b', 'c'] };
        applyPatch(doc, [{ op: 'replace', path: '/items/1', value: 'B' }]);
        expect(doc.items).toEqual(['a', 'B', 'c']);
    });

    it('replaces the whole document when path is empty', () => {
        const out = applyPatch({ a: 1 } as Record<string, unknown>, [{ op: 'replace', path: '', value: { b: 2 } }]);
        expect(out).toEqual({ b: 2 });
    });

    it('throws when replacing a missing key', () => {
        expect(() => applyPatch({ a: 1 }, [{ op: 'replace', path: '/missing', value: 2 }])).toThrow(JsonPatchError);
    });
});

describe('applyPatch — add', () => {
    it('adds a new field to an object', () => {
        const doc: Record<string, unknown> = { a: 1 };
        applyPatch(doc, [{ op: 'add', path: '/b', value: 2 }]);
        expect(doc).toEqual({ a: 1, b: 2 });
    });

    it('overwrites an existing field (RFC 6902 behavior)', () => {
        const doc: Record<string, unknown> = { a: 1 };
        applyPatch(doc, [{ op: 'add', path: '/a', value: 99 }]);
        expect(doc.a).toBe(99);
    });

    it('inserts into an array at a specific index', () => {
        const doc = { items: [1, 2, 4] };
        applyPatch(doc, [{ op: 'add', path: '/items/2', value: 3 }]);
        expect(doc.items).toEqual([1, 2, 3, 4]);
    });

    it('appends with the "-" token', () => {
        const doc = { items: [1, 2, 3] };
        applyPatch(doc, [{ op: 'add', path: '/items/-', value: 4 }]);
        expect(doc.items).toEqual([1, 2, 3, 4]);
    });

    it('rejects "-" for non-add ops', () => {
        const doc = { items: [1] };
        expect(() => applyPatch(doc, [{ op: 'replace', path: '/items/-', value: 2 }])).toThrow(JsonPatchError);
    });
});

describe('applyPatch — remove', () => {
    it('removes an object key', () => {
        const doc: Record<string, unknown> = { a: 1, b: 2 };
        applyPatch(doc, [{ op: 'remove', path: '/a' }]);
        expect(doc).toEqual({ b: 2 });
    });

    it('removes an array element, shifting later items', () => {
        const doc = { items: ['a', 'b', 'c'] };
        applyPatch(doc, [{ op: 'remove', path: '/items/1' }]);
        expect(doc.items).toEqual(['a', 'c']);
    });

    it('rejects removing the root document', () => {
        expect(() => applyPatch({ a: 1 }, [{ op: 'remove', path: '' }])).toThrow(JsonPatchError);
    });

    it('rejects removing a missing key', () => {
        expect(() => applyPatch({ a: 1 }, [{ op: 'remove', path: '/missing' }])).toThrow(JsonPatchError);
    });
});

describe('applyPatch — pointer escaping', () => {
    it('unescapes ~1 to /', () => {
        const doc: Record<string, unknown> = { 'a/b': 1 };
        applyPatch(doc, [{ op: 'replace', path: '/a~1b', value: 2 }]);
        expect(doc['a/b']).toBe(2);
    });

    it('unescapes ~0 to ~', () => {
        const doc: Record<string, unknown> = { 'a~b': 1 };
        applyPatch(doc, [{ op: 'replace', path: '/a~0b', value: 2 }]);
        expect(doc['a~b']).toBe(2);
    });
});

describe('applyPatch — composition', () => {
    it('applies multiple ops in sequence', () => {
        const doc: Record<string, unknown> = { a: 1, b: { c: 2 } };
        applyPatch(doc, [
            { op: 'replace', path: '/a', value: 10 },
            { op: 'add', path: '/b/d', value: 3 },
            { op: 'remove', path: '/b/c' },
        ]);
        expect(doc).toEqual({ a: 10, b: { d: 3 } });
    });
});
