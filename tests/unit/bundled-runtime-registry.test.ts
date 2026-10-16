import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BundledRuntimeError,
  loadBundledRuntime,
} from '../../packages/execution/src/runtime/bundled-runtime-registry';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('macOS arm64 Bundled Runtime Registry', () => {
  it('加载匹配目标且可执行的 Runtime Pack', () => {
    const root = makeRuntimePack();
    const snapshot = loadBundledRuntime(root, {
      platform: 'darwin',
      arch: 'arm64',
      required: true,
    });

    expect(snapshot).toMatchObject({
      platform: 'darwin',
      arch: 'arm64',
      node: { version: '24.20.0' },
      python: { version: '3.13.15' },
      mcp: { memory: { version: '2026.7.4' } },
    });
    expect(snapshot?.binDir).toBe(path.join(root, 'bin'));
  });

  it('打包环境缺失或目标不匹配时明确失败', () => {
    const root = makeRuntimePack();
    expect(() =>
      loadBundledRuntime(root, { platform: 'darwin', arch: 'x64', required: true }),
    ).toThrow(BundledRuntimeError);
    expect(
      loadBundledRuntime(path.join(root, 'missing'), {
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBeNull();
  });

  it('拒绝逃出 Runtime Pack 根目录的 manifest 路径', () => {
    const root = makeRuntimePack({ nodeExecutable: '../outside-node' });
    expect(() =>
      loadBundledRuntime(root, { platform: 'darwin', arch: 'arm64', required: true }),
    ).toThrow('Runtime Pack path escapes its root');
  });
});

function makeRuntimePack(options: { nodeExecutable?: string } = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bundled-runtime-registry-'));
  roots.push(root);
  for (const relative of ['bin', 'node/bin', 'python/bin', 'mcp/server-memory']) {
    mkdirSync(path.join(root, relative), { recursive: true });
  }
  for (const relative of ['node/bin/node', 'python/bin/python3']) {
    const executable = path.join(root, relative);
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executable, 0o755);
  }
  writeFileSync(path.join(root, 'mcp/server-memory/index.mjs'), '', 'utf8');
  writeFileSync(
    path.join(root, 'runtime-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      target: { platform: 'darwin', arch: 'arm64' },
      node: { version: '24.20.0', executable: options.nodeExecutable ?? 'node/bin/node' },
      python: { version: '3.13.15', executable: 'python/bin/python3' },
      mcp: {
        memory: {
          package: '@modelcontextprotocol/server-memory',
          version: '2026.7.4',
          entrypoint: 'mcp/server-memory/index.mjs',
        },
      },
      binDir: 'bin',
    }),
    'utf8',
  );
  return root;
}
