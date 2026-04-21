import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FlowRegistry, type FlowEntry } from './registry.js';

describe('FlowRegistry', () => {
    let flowsDir: string;

    beforeEach(async () => {
        flowsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-registry-test-'));
    });

    afterEach(async () => {
        await fs.rm(flowsDir, { recursive: true, force: true });
    });

    describe('loadManifest()', () => {
        it('returns empty manifest when file is missing', async () => {
            const manifest = await FlowRegistry.loadManifest(flowsDir);
            expect(manifest).toEqual({});
        });

        it('loads manifest when present', async () => {
            const manifest = { flows: { login: { description: 'Login flow' } } };
            await fs.writeFile(
                path.join(flowsDir, '_manifest.json'),
                JSON.stringify(manifest),
            );
            const loaded = await FlowRegistry.loadManifest(flowsDir);
            expect(loaded).toEqual(manifest);
        });

        it('returns empty manifest when JSON is malformed', async () => {
            await fs.writeFile(
                path.join(flowsDir, '_manifest.json'),
                '{ not valid json',
            );
            const loaded = await FlowRegistry.loadManifest(flowsDir);
            expect(loaded).toEqual({});
        });
    });

    describe('list()', () => {
        it('returns flows sorted by name', async () => {
            await fs.writeFile(path.join(flowsDir, 'zulu.yaml'), 'appId: x');
            await fs.writeFile(path.join(flowsDir, 'alpha.yaml'), 'appId: x');
            await fs.writeFile(path.join(flowsDir, 'mike.yaml'), 'appId: x');
            const flows = await FlowRegistry.list(flowsDir);
            expect(flows.map((f) => f.name)).toEqual(['alpha', 'mike', 'zulu']);
        });

        it('ignores non-yaml files', async () => {
            await fs.writeFile(path.join(flowsDir, 'notes.md'), 'hello');
            await fs.writeFile(path.join(flowsDir, 'config.json'), '{}');
            await fs.writeFile(path.join(flowsDir, 'login.yaml'), 'appId: x');
            const flows = await FlowRegistry.list(flowsDir);
            expect(flows.map((f) => f.name)).toEqual(['login']);
        });

        it('ignores files starting with underscore', async () => {
            await fs.writeFile(path.join(flowsDir, '_helper.yaml'), 'appId: x');
            await fs.writeFile(path.join(flowsDir, 'login.yaml'), 'appId: x');
            const flows = await FlowRegistry.list(flowsDir);
            expect(flows.map((f) => f.name)).toEqual(['login']);
        });

        it('merges manifest metadata into entries', async () => {
            await fs.writeFile(path.join(flowsDir, 'login.yaml'), 'appId: x');
            await fs.writeFile(
                path.join(flowsDir, '_manifest.json'),
                JSON.stringify({
                    flows: {
                        login: {
                            description: 'Login flow',
                            tags: ['auth', 'setup'],
                            params: {
                                username: { required: true, description: 'Username' },
                            },
                        },
                    },
                }),
            );
            const flows = await FlowRegistry.list(flowsDir);
            expect(flows).toHaveLength(1);
            expect(flows[0]).toMatchObject({
                name: 'login',
                description: 'Login flow',
                tags: ['auth', 'setup'],
                params: { username: { required: true, description: 'Username' } },
            });
            expect(flows[0].path).toBe(path.join(flowsDir, 'login.yaml'));
        });

        it('returns entries without manifest metadata when no manifest exists', async () => {
            await fs.writeFile(path.join(flowsDir, 'login.yaml'), 'appId: x');
            const flows = await FlowRegistry.list(flowsDir);
            expect(flows).toHaveLength(1);
            expect(flows[0].description).toBeUndefined();
            expect(flows[0].tags).toBeUndefined();
            expect(flows[0].params).toBeUndefined();
        });

        it('throws ENOENT when flowsDir does not exist', async () => {
            await expect(
                FlowRegistry.list(path.join(flowsDir, 'nope')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('resolve()', () => {
        it('returns the flow entry when the file exists', async () => {
            const yamlPath = path.join(flowsDir, 'login.yaml');
            await fs.writeFile(yamlPath, 'appId: x');
            const flow = await FlowRegistry.resolve(flowsDir, 'login');
            expect(flow.path).toBe(yamlPath);
            expect(flow.name).toBe('login');
        });

        it('includes manifest metadata when present', async () => {
            await fs.writeFile(path.join(flowsDir, 'login.yaml'), 'appId: x');
            await fs.writeFile(
                path.join(flowsDir, '_manifest.json'),
                JSON.stringify({
                    flows: { login: { description: 'The login flow', tags: ['auth'] } },
                }),
            );
            const flow = await FlowRegistry.resolve(flowsDir, 'login');
            expect(flow.description).toBe('The login flow');
            expect(flow.tags).toEqual(['auth']);
        });

        it('throws when the flow file does not exist', async () => {
            await expect(FlowRegistry.resolve(flowsDir, 'nope')).rejects.toThrow(
                /not found/,
            );
        });
    });

    describe('applyParams()', () => {
        function flowWithParams(params: FlowEntry['params']): FlowEntry {
            return { name: 'test', path: '/test.yaml', params };
        }

        it('applies defaults for missing optional params', () => {
            const flow = flowWithParams({
                username: { default: 'admin' },
                password: { default: 'admin' },
            });
            const result = FlowRegistry.applyParams(flow, {});
            expect(result).toEqual({ username: 'admin', password: 'admin' });
        });

        it('prefers supplied values over defaults', () => {
            const flow = flowWithParams({ username: { default: 'admin' } });
            const result = FlowRegistry.applyParams(flow, { username: 'custom' });
            expect(result).toEqual({ username: 'custom' });
        });

        it('forwards supplied params not declared in the manifest', () => {
            const flow = flowWithParams({});
            const result = FlowRegistry.applyParams(flow, { EXTRA: 'value' });
            expect(result).toEqual({ EXTRA: 'value' });
        });

        it('throws when a required param is missing and has no default', () => {
            const flow = flowWithParams({ username: { required: true } });
            expect(() => FlowRegistry.applyParams(flow, {})).toThrow(/username/);
        });

        it('accepts a required param when supplied', () => {
            const flow = flowWithParams({ username: { required: true } });
            const result = FlowRegistry.applyParams(flow, { username: 'admin' });
            expect(result).toEqual({ username: 'admin' });
        });

        it('uses default instead of failing when required param has a default', () => {
            const flow = flowWithParams({
                username: { required: true, default: 'admin' },
            });
            const result = FlowRegistry.applyParams(flow, {});
            expect(result).toEqual({ username: 'admin' });
        });

        it('handles flows with no params declared', () => {
            const flow: FlowEntry = { name: 'x', path: '/x.yaml' };
            const result = FlowRegistry.applyParams(flow, { anything: 'goes' });
            expect(result).toEqual({ anything: 'goes' });
        });

        it('handles undefined supplied params', () => {
            const flow = flowWithParams({ username: { default: 'admin' } });
            const result = FlowRegistry.applyParams(flow, undefined);
            expect(result).toEqual({ username: 'admin' });
        });

        it('reports all missing required params at once', () => {
            const flow = flowWithParams({
                username: { required: true },
                password: { required: true },
            });
            expect(() => FlowRegistry.applyParams(flow, {})).toThrow(
                /username.*password|password.*username/,
            );
        });
    });
});
