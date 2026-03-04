import { describe, it, expect } from 'vitest';
import { PayloadValidator } from './validator.js';

describe('PayloadValidator', () => {
    it('should match identical objects', () => {
        const result = PayloadValidator.validate(
            { name: 'Alice', age: 30 },
            { name: 'Alice', age: 30 }
        );
        expect(result.matched).toBe(true);
        expect(result.mismatches).toHaveLength(0);
    });

    it('should report primitive mismatches with dot path', () => {
        const result = PayloadValidator.validate(
            { name: 'Bob' },
            { name: 'Alice' }
        );
        expect(result.matched).toBe(false);
        expect(result.mismatches[0]).toContain('name');
        expect(result.mismatches[0]).toContain('"Alice"');
        expect(result.mismatches[0]).toContain('"Bob"');
    });

    it('should report missing keys', () => {
        const result = PayloadValidator.validate(
            { name: 'Alice' },
            { name: 'Alice', email: 'alice@example.com' }
        );
        expect(result.matched).toBe(false);
        expect(result.mismatches[0]).toContain('email');
        expect(result.mismatches[0]).toContain('missing');
    });

    it('should handle nested objects', () => {
        const result = PayloadValidator.validate(
            { data: { hero: { title: 'Dashboard' } } },
            { data: { hero: { title: 'Home' } } }
        );
        expect(result.matched).toBe(false);
        expect(result.mismatches[0]).toContain('data.hero.title');
    });

    it('should handle arrays with matching elements', () => {
        const result = PayloadValidator.validate(
            { items: [{ id: 1 }, { id: 2 }] },
            { items: [{ id: 1 }, { id: 2 }] }
        );
        expect(result.matched).toBe(true);
    });

    it('should report when actual array is too short', () => {
        const result = PayloadValidator.validate(
            { items: [{ id: 1 }] },
            { items: [{ id: 1 }, { id: 2 }] }
        );
        expect(result.matched).toBe(false);
        expect(result.mismatches.some(m => m.includes('too short'))).toBe(true);
    });

    it('should report when actual array has extra elements', () => {
        const result = PayloadValidator.validate(
            { items: [1, 2, 3] },
            { items: [1] }
        );
        expect(result.matched).toBe(false);
        expect(result.mismatches.some(m => m.includes('3 elements but only 1 expected'))).toBe(true);
    });

    it('should pass when expected is null', () => {
        const result = PayloadValidator.validate(
            { name: 'Alice' },
            { name: null as unknown as string }
        );
        expect(result.matched).toBe(true);
    });

    it('should report type mismatches (object vs primitive)', () => {
        const result = PayloadValidator.validate(
            { data: 'hello' },
            { data: { nested: true } }
        );
        expect(result.matched).toBe(false);
        expect(result.mismatches[0]).toContain('expected object');
    });

    it('should ignore extra keys in actual (only walks expected)', () => {
        const result = PayloadValidator.validate(
            { name: 'Alice', extra: 'ignored' },
            { name: 'Alice' }
        );
        expect(result.matched).toBe(true);
    });
});
