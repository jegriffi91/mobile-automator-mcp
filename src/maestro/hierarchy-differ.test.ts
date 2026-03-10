import { describe, it, expect } from 'vitest';
import { HierarchyDiffer } from './hierarchy-differ.js';
import type { UIHierarchyNode } from '../types.js';

describe('HierarchyDiffer', () => {
    function makeNode(
        overrides: Partial<UIHierarchyNode> & { role: string },
    ): UIHierarchyNode {
        return {
            children: [],
            ...overrides,
        };
    }

    describe('diff', () => {
        it('should detect no changes when trees are identical', () => {
            const tree: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({ role: 'Button', id: 'login_button', text: 'Login' }),
                    makeNode({ role: 'TextField', id: 'username_field' }),
                ],
            });

            const result = HierarchyDiffer.diff(tree, tree);
            expect(result.elementsAdded).toHaveLength(0);
            expect(result.elementsRemoved).toHaveLength(0);
        });

        it('should detect added elements', () => {
            const before: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({ role: 'Button', id: 'login_button', text: 'Login' }),
                ],
            });

            const after: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({ role: 'Button', id: 'login_button', text: 'Login' }),
                    makeNode({ role: 'StaticText', id: 'error_toast', text: 'Auth failed' }),
                ],
            });

            const result = HierarchyDiffer.diff(before, after);
            expect(result.elementsAdded).toHaveLength(1);
            expect(result.elementsAdded[0].id).toBe('error_toast');
            expect(result.elementsAdded[0].text).toBe('Auth failed');
            expect(result.elementsRemoved).toHaveLength(0);
        });

        it('should detect removed elements', () => {
            const before: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({ role: 'Button', id: 'login_button', text: 'Login' }),
                    makeNode({ role: 'ActivityIndicator', id: 'loading_spinner' }),
                ],
            });

            const after: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({ role: 'Button', id: 'login_button', text: 'Login' }),
                ],
            });

            const result = HierarchyDiffer.diff(before, after);
            expect(result.elementsAdded).toHaveLength(0);
            expect(result.elementsRemoved).toHaveLength(1);
            expect(result.elementsRemoved[0].id).toBe('loading_spinner');
        });

        it('should detect both adds and removes (screen transition)', () => {
            const before: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({ role: 'Button', id: 'login_button', text: 'Login' }),
                    makeNode({ role: 'TextField', id: 'username_field' }),
                ],
            });

            const after: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({ role: 'Text', id: 'dashboard_title', text: 'Dashboard' }),
                    makeNode({ role: 'List', id: 'lore_list' }),
                ],
            });

            const result = HierarchyDiffer.diff(before, after);
            expect(result.elementsAdded).toHaveLength(2);
            expect(result.elementsRemoved).toHaveLength(2);
        });

        it('should handle nested children correctly', () => {
            const before: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({
                        role: 'View',
                        children: [
                            makeNode({ role: 'Button', id: 'btn1', text: 'A' }),
                        ],
                    }),
                ],
            });

            const after: UIHierarchyNode = makeNode({
                role: 'Application',
                children: [
                    makeNode({
                        role: 'View',
                        children: [
                            makeNode({ role: 'Button', id: 'btn1', text: 'A' }),
                            makeNode({ role: 'Text', id: 'toast', text: 'Error' }),
                        ],
                    }),
                ],
            });

            const result = HierarchyDiffer.diff(before, after);
            expect(result.elementsAdded).toHaveLength(1);
            expect(result.elementsAdded[0].id).toBe('toast');
        });

        it('should pass through settleDurationMs and actionId', () => {
            const tree = makeNode({ role: 'Application' });
            const result = HierarchyDiffer.diff(tree, tree, 42, 1500);
            expect(result.actionId).toBe(42);
            expect(result.settleDurationMs).toBe(1500);
        });
    });

    describe('areEqual', () => {
        it('should return true for identical JSON strings', () => {
            const json = JSON.stringify(makeNode({ role: 'App', id: 'root' }));
            expect(HierarchyDiffer.areEqual(json, json)).toBe(true);
        });

        it('should return true for trees with same elements in different structure', () => {
            const tree1 = makeNode({
                role: 'App',
                children: [
                    makeNode({ role: 'Button', id: 'a' }),
                    makeNode({ role: 'Text', id: 'b', text: 'hello' }),
                ],
            });
            // Same elements, same tree — should be equal
            const tree2 = makeNode({
                role: 'App',
                children: [
                    makeNode({ role: 'Button', id: 'a' }),
                    makeNode({ role: 'Text', id: 'b', text: 'hello' }),
                ],
            });
            expect(HierarchyDiffer.areEqual(JSON.stringify(tree1), JSON.stringify(tree2))).toBe(true);
        });

        it('should return false when an element is added', () => {
            const tree1 = makeNode({
                role: 'App',
                children: [makeNode({ role: 'Button', id: 'a' })],
            });
            const tree2 = makeNode({
                role: 'App',
                children: [
                    makeNode({ role: 'Button', id: 'a' }),
                    makeNode({ role: 'Text', id: 'toast', text: 'error' }),
                ],
            });
            expect(HierarchyDiffer.areEqual(JSON.stringify(tree1), JSON.stringify(tree2))).toBe(false);
        });

        it('should return false for invalid JSON', () => {
            expect(HierarchyDiffer.areEqual('not json', '{}')).toBe(false);
        });
    });
});
