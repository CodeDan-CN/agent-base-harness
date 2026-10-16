import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRunner } from '../../packages/execution/src/process/process-runner';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== 'darwin')('Stage 4.5.5 macOS file sandbox', () => {
  it('allows workspace writes and denies writes outside the declared root', async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), 'agent-permission-'));
    temporaryRoots.push(container);
    const workspace = path.join(container, 'workspace');
    const outside = path.join(container, 'outside');
    const runner = new ProcessRunner({ allowedRoots: [container] });
    await runner.run({
      cmd: '/bin/mkdir',
      args: ['-p', workspace, outside],
      cwd: container,
    });

    const result = await runner.run({
      cmd: '/bin/bash',
      args: ['-c', 'touch inside.txt; touch ../outside/blocked.txt'],
      cwd: workspace,
      sandbox: { mode: 'workspace-write', writableRoots: [workspace] },
    });

    expect(result.exitCode).not.toBe(0);
    await expect(access(path.join(workspace, 'inside.txt'))).resolves.toBeUndefined();
    await expect(access(path.join(outside, 'blocked.txt'))).rejects.toBeDefined();
  });

  it('denies project writes in read-only mode', async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), 'agent-read-only-'));
    temporaryRoots.push(container);
    const temporary = path.join(container, 'tmp');
    const runner = new ProcessRunner({ allowedRoots: [container] });
    await runner.run({
      cmd: '/bin/mkdir',
      args: ['-p', temporary],
      cwd: container,
    });

    const result = await runner.run({
      cmd: '/usr/bin/touch',
      args: ['blocked.txt'],
      cwd: container,
      sandbox: { mode: 'read-only', writableRoots: [temporary] },
    });

    expect(result.exitCode).not.toBe(0);
    await expect(access(path.join(container, 'blocked.txt'))).rejects.toBeDefined();
  });
});
