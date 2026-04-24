import { describe, it, expect } from 'vitest';
import { getByPath, existsAtPath } from './jsonpath.js';

describe('getByPath', () => {
    it('resolves a plain dotted path', () => {
        expect(getByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
    });

    it('resolves a bracketed array index', () => {
        expect(getByPath({ items: [10, 20, 30] }, 'items[1]')).toBe(20);
    });

    it('resolves mixed dot + bracket paths', () => {
        const obj = { data: { items: [{ id: 'a' }, { id: 'b' }] } };
        expect(getByPath(obj, 'data.items[1].id')).toBe('b');
    });

    it('resolves quoted bracket keys with dots', () => {
        const obj = { 'weird.key': 7 };
        expect(getByPath(obj, "['weird.key']")).toBe(7);
    });

    it('returns undefined for missing paths', () => {
        expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined();
        expect(getByPath({ a: [1, 2] }, 'a[5]')).toBeUndefined();
    });

    it('returns undefined when the root is null/undefined', () => {
        expect(getByPath(null, 'a')).toBeUndefined();
        expect(getByPath(undefined, 'a')).toBeUndefined();
    });

    it('returns the root when path is empty', () => {
        expect(getByPath({ a: 1 }, '')).toEqual({ a: 1 });
    });
});

describe('existsAtPath', () => {
    it('returns true for resolvable paths with values', () => {
        expect(existsAtPath({ a: 0 }, 'a')).toBe(true);
        expect(existsAtPath({ a: null }, 'a')).toBe(true);
    });

    it('returns false when the value is undefined', () => {
        expect(existsAtPath({ a: undefined }, 'a')).toBe(false);
    });

    it('returns false for missing paths', () => {
        expect(existsAtPath({ a: 1 }, 'b')).toBe(false);
    });
});
