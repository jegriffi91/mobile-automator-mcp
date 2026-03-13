/**
 * StubServer unit tests — path normalization and stub loading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { StubServer } from './runner.js';

describe('StubServer', () => {
  let tmpDir: string;
  let wiremockRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stub-server-test-'));
    wiremockRoot = path.join(tmpDir, 'wiremock');
    const mappingsDir = path.join(wiremockRoot, 'mappings');
    const filesDir = path.join(wiremockRoot, '__files');
    await fs.mkdir(mappingsDir, { recursive: true });
    await fs.mkdir(filesDir, { recursive: true });

    // Write a sample mapping
    await fs.writeFile(
      path.join(mappingsDir, 'test-stub.json'),
      JSON.stringify({
        priority: 1,
        request: { method: 'GET', urlPathPattern: '/api/test' },
        response: { status: 200, bodyFileName: 'test_response.json', headers: { 'Content-Type': 'application/json' } },
      }),
      'utf-8',
    );

    // Write a sample fixture
    await fs.writeFile(
      path.join(filesDir, 'test_response.json'),
      JSON.stringify({ message: 'hello' }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadStubs', () => {
    it('should load stubs from the WireMock root directory', async () => {
      const server = new StubServer();
      const count = await server.loadStubs(wiremockRoot);
      expect(count).toBe(1);
    });

    it('should normalize a path ending in mappings/ and still load correctly', async () => {
      const server = new StubServer();
      // Simulate the pre-fix bug: caller passes the mappings/ subdirectory
      const mappingsPath = path.join(wiremockRoot, 'mappings');
      const count = await server.loadStubs(mappingsPath);
      expect(count).toBe(1);
    });

    it('should throw a descriptive error for a nonexistent directory', async () => {
      const server = new StubServer();
      await expect(server.loadStubs('/tmp/nonexistent-wiremock-dir')).rejects.toThrow(
        /Failed to load stubs/,
      );
    });
  });

  describe('start and stop', () => {
    it('should start on an auto-selected port and stop cleanly', async () => {
      const server = new StubServer();
      await server.loadStubs(wiremockRoot);
      const port = await server.start(0);
      expect(port).toBeGreaterThan(0);
      await server.stop();
    });

    it('should throw if started twice', async () => {
      const server = new StubServer();
      await server.loadStubs(wiremockRoot);
      await server.start(0);
      await expect(server.start(0)).rejects.toThrow('already running');
      await server.stop();
    });
  });
});
