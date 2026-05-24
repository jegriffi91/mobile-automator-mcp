/**
 * Convergence tests for `loupeToHierarchy`.
 *
 * The load-bearing claim of the Loupe backend is that a tree fed through this
 * converter is interchangeable with one produced by the Maestro
 * `HierarchyParser` — downstream code (diffing, structural hashing, synthesis)
 * cannot tell which driver recorded the session.
 *
 * The cross-driver test pairs a Loupe `/accessibility` payload with the
 * equivalent Maestro JSON hierarchy and asserts:
 *   • Same identifiable-element set: every `(id, accessibilityLabel, text, role)`
 *     tuple present in one tree is present in the other.
 *   • Identical root `structuralHash` (the FNV-1a fingerprint that downstream
 *     diffing relies on for O(1) equality).
 */

import { describe, it, expect } from 'vitest';
import { loupeToHierarchy, type LoupeAccessibilityTree } from './hierarchy.js';
import { HierarchyParser } from '../maestro/hierarchy.js';
import { computeStructuralHash } from '../maestro/structural-hash.js';
import { flattenToElements } from '../maestro/hierarchy-differ.js';
import type { UIHierarchyNode, UIElement } from '../types.js';

const LOUPE_LOGIN_SCREEN: LoupeAccessibilityTree = {
    rootRefs: ['n1'],
    nodes: {
        n1: {
            ref: 'n1',
            role: 'Application',
            frame: { x: 0, y: 0, width: 375, height: 812 },
            isVisible: true,
            children: ['n2', 'n3', 'n4', 'n5'],
        },
        n2: {
            ref: 'n2',
            role: 'TextField',
            testID: 'username',
            label: 'Username',
            frame: { x: 20, y: 100, width: 335, height: 44 },
            isVisible: true,
            isInteractive: true,
            children: [],
        },
        n3: {
            ref: 'n3',
            role: 'SecureTextField',
            testID: 'password',
            label: 'Password',
            traits: ['secureTextEntry'],
            frame: { x: 20, y: 160, width: 335, height: 44 },
            isVisible: true,
            isInteractive: true,
            children: [],
        },
        n4: {
            ref: 'n4',
            role: 'Button',
            testID: 'login_button',
            label: 'Log In',
            frame: { x: 20, y: 220, width: 335, height: 50 },
            isVisible: true,
            isInteractive: true,
            children: [],
        },
        n5: {
            ref: 'n5',
            role: 'Link',
            label: 'Forgot password?',
            frame: { x: 20, y: 290, width: 335, height: 30 },
            isVisible: true,
            isInteractive: true,
            children: [],
        },
    },
};

const MAESTRO_LOGIN_JSON = JSON.stringify({
    attributes: { class: 'Application' },
    children: [
        {
            attributes: {
                'resource-id': 'username',
                accessibilityLabel: 'Username',
                class: 'TextField',
                bounds: '[20,100][355,144]',
            },
        },
        {
            attributes: {
                'resource-id': 'password',
                accessibilityLabel: 'Password',
                class: 'SecureTextField',
                bounds: '[20,160][355,204]',
                secureTextEntry: true,
            },
        },
        {
            attributes: {
                'resource-id': 'login_button',
                accessibilityLabel: 'Log In',
                class: 'Button',
                bounds: '[20,220][355,270]',
            },
        },
        {
            attributes: {
                accessibilityLabel: 'Forgot password?',
                class: 'Link',
                bounds: '[20,290][355,320]',
            },
        },
    ],
});

interface Identity {
    id?: string;
    accessibilityLabel?: string;
    text?: string;
    role: string;
}

function collectIdentities(node: UIHierarchyNode, out: Identity[] = []): Identity[] {
    const hasIdentity = node.id || node.accessibilityLabel || node.text;
    if (hasIdentity) {
        out.push({
            id: node.id,
            accessibilityLabel: node.accessibilityLabel,
            text: node.text,
            role: node.role,
        });
    }
    for (const c of node.children) collectIdentities(c, out);
    return out;
}

describe('loupeToHierarchy — golden conversion', () => {
    it('maps testID → id, label → accessibilityLabel, value/text/placeholder → text', () => {
        const tree = loupeToHierarchy(LOUPE_LOGIN_SCREEN);
        expect(tree.role).toBe('Application');
        expect(tree.children).toHaveLength(4);

        const [username, password, button, link] = tree.children;
        expect(username).toMatchObject({
            id: 'username',
            accessibilityLabel: 'Username',
            role: 'TextField',
        });
        expect(password).toMatchObject({
            id: 'password',
            accessibilityLabel: 'Password',
            role: 'SecureTextField',
            isSecure: true,
        });
        expect(button).toMatchObject({
            id: 'login_button',
            accessibilityLabel: 'Log In',
            role: 'Button',
        });
        expect(link).toMatchObject({
            accessibilityLabel: 'Forgot password?',
            role: 'Link',
        });
        expect(link.id).toBeUndefined();
    });

    it('attaches a structuralHash to the root', () => {
        const tree = loupeToHierarchy(LOUPE_LOGIN_SCREEN);
        expect(tree.structuralHash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('treats the secureTextEntry trait alone as a secure field', () => {
        const tree = loupeToHierarchy({
            rootRefs: ['a'],
            nodes: {
                a: {
                    ref: 'a',
                    role: 'TextField',
                    testID: 'pin',
                    traits: ['secureTextEntry'],
                    isVisible: true,
                    children: [],
                },
            },
        });
        expect(tree.isSecure).toBe(true);
    });

    it('drops nodes that are invisible AND have no identity', () => {
        const tree = loupeToHierarchy({
            rootRefs: ['a'],
            nodes: {
                a: {
                    ref: 'a',
                    role: 'View',
                    isVisible: true,
                    children: ['b', 'c'],
                },
                b: {
                    ref: 'b',
                    role: 'Spacer',
                    isVisible: false,
                    children: [],
                },
                c: {
                    ref: 'c',
                    role: 'Label',
                    label: 'Hidden but identified',
                    isVisible: false,
                    children: [],
                },
            },
        });
        // 'b' (no identity, invisible) dropped; 'c' (identified, invisible) kept.
        expect(tree.children).toHaveLength(1);
        expect(tree.children[0].accessibilityLabel).toBe('Hidden but identified');
    });

    it('guards against ref cycles', () => {
        const tree = loupeToHierarchy({
            rootRefs: ['a'],
            nodes: {
                a: { ref: 'a', role: 'A', isVisible: true, children: ['b'] },
                b: { ref: 'b', role: 'B', isVisible: true, children: ['a'] },
            },
        });
        // Should terminate; 'a' shouldn't appear twice.
        expect(tree.role).toBe('A');
        expect(tree.children[0].role).toBe('B');
        expect(tree.children[0].children).toHaveLength(0);
    });
});

describe('loupeToHierarchy ⇄ Maestro HierarchyParser — convergence', () => {
    it('produces the same identifiable-element set as HierarchyParser for the same screen', () => {
        const loupe = loupeToHierarchy(LOUPE_LOGIN_SCREEN);
        const maestro = HierarchyParser.parse(MAESTRO_LOGIN_JSON);

        const loupeIds = collectIdentities(loupe).sort(byKey);
        const maestroIds = collectIdentities(maestro).sort(byKey);

        expect(loupeIds).toEqual(maestroIds);
    });

    it('produces the same root structuralHash as HierarchyParser for the same screen', () => {
        const loupe = loupeToHierarchy(LOUPE_LOGIN_SCREEN);
        const maestro = HierarchyParser.parse(MAESTRO_LOGIN_JSON);

        // computeStructuralHash is order-independent — re-running guarantees a
        // stable comparison even if either tree's child order shifts.
        expect(computeStructuralHash(loupe)).toBe(computeStructuralHash(maestro));
        expect(loupe.structuralHash).toBe(maestro.structuralHash);
    });

    it('produces the same flattenToElements output (the synthesizer input) as HierarchyParser', () => {
        // flattenToElements is the boundary between hierarchy parsing and
        // synthesis. If two trees produce identical UIElement[] arrays here,
        // the synthesized Maestro YAML will be byte-identical (modulo timestamps).
        const loupe = loupeToHierarchy(LOUPE_LOGIN_SCREEN);
        const maestro = HierarchyParser.parse(MAESTRO_LOGIN_JSON);

        const loupeEls = flattenToElements(loupe).map(normalize).sort(byElementKey);
        const maestroEls = flattenToElements(maestro).map(normalize).sort(byElementKey);

        expect(loupeEls).toEqual(maestroEls);
    });
});

function normalize(el: UIElement): UIElement {
    // Strip optional fields that don't affect synthesis (bounds/point are
    // resolved later) so the equality check focuses on selector identity.
    return {
        id: el.id,
        accessibilityLabel: el.accessibilityLabel,
        text: el.text,
        role: el.role,
        ...(el.isSecure ? { isSecure: el.isSecure } : {}),
    };
}

function byElementKey(a: UIElement, b: UIElement): number {
    const k = (e: UIElement) =>
        `${e.id ?? ''}|${e.accessibilityLabel ?? ''}|${e.text ?? ''}|${e.role ?? ''}`;
    return k(a).localeCompare(k(b));
}

function byKey(a: Identity, b: Identity): number {
    const ak = `${a.id ?? ''}|${a.accessibilityLabel ?? ''}|${a.text ?? ''}|${a.role}`;
    const bk = `${b.id ?? ''}|${b.accessibilityLabel ?? ''}|${b.text ?? ''}|${b.role}`;
    return ak.localeCompare(bk);
}
