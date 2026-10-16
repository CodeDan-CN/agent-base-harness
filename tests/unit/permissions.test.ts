import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScopedFileSystem } from '../../packages/execution/src/filesystem/scoped-file-system';
import { ProcessRunner } from '../../packages/execution/src/process/process-runner';
import { ShellExecutor } from '../../packages/execution/src/process/shell-executor';
import { createFirstPartyTools } from '../../packages/runtime-core/src/first-party-tools';
import { ToolRegistry, ToolScheduler, type RuntimeTool } from '../../packages/runtime-core/src/tools';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const tool = (name: string, execute = vi.fn(async () => ({ ok: true }))): RuntimeTool<unknown> => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  concurrencySafe: false,
  replaySafe: false,
  approvalPolicy: 'always',
  permissionIdentity: 'test:' + name,
  execute,
});

const context = {
  userId: 'user-a',
  sessionId: 'session-a',
  eventId: 'event-a',
  turnId: 'turn-a',
  stepId: 'step-a',
  permissionPreset: 'guarded' as const,
  signal: new AbortController().signal,
};

describe('Stage 4.5.5 tool approval gate', () => {
  it('does not execute a rejected call', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register(tool('external_write', execute));
    const scheduler = new ToolScheduler(registry, 1, async () => 'rejected');

    const [result] = await scheduler.execute(
      [{ id: 'call-a', name: 'external_write', arguments: {} }],
      context,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result?.result).toMatchObject({
      status: 'fatal_error',
      errorCode: 'APPROVAL_REJECTED',
    });
  });

  it('resumes the same call after approval', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register(tool('external_write', execute));
    const scheduler = new ToolScheduler(registry, 1, async () => 'session-granted');

    const [result] = await scheduler.execute(
      [{ id: 'call-a', name: 'external_write', arguments: {} }],
      context,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result?.result.status).toBe('success');
  });

  it('passes an approval grant into the resumed tool call', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register(tool('write', execute));
    const scheduler = new ToolScheduler(registry, 1, async () => 'allowed-once');

    const [result] = await scheduler.execute(
      [{ id: 'call-a', name: 'write', arguments: {} }],
      context,
    );

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ approvalGranted: true, permissionPreset: 'guarded' }),
    );
    expect(result?.result.status).toBe('success');
  });

  it('allows one exact external file write only after approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-file-approval-'));
    temporaryRoots.push(root);
    const appDataDir = path.join(root, 'app-data');
    const outside = path.join(root, 'outside.txt');
    const fileSystem = new ScopedFileSystem(appDataDir);
    const shell = new ShellExecutor(appDataDir, new ProcessRunner({ allowedRoots: [root] }));
    const write = createFirstPartyTools({ fileSystem, shell }).find(({ name }) => name === 'write')!;
    const registry = new ToolRegistry();
    registry.register(write);
    const scheduler = new ToolScheduler(registry, 1, async () => 'allowed-once');

    const [result] = await scheduler.execute(
      [
        {
          id: 'external-write',
          name: 'write',
          arguments: { file_path: outside, content: 'approved' },
        },
      ],
      { ...context, permissionPreset: 'approval-required' },
    );

    expect(result?.result.status).toBe('success');
    await expect(access(outside)).resolves.toBeUndefined();
    expect(await readFile(outside, 'utf8')).toBe('approved');
  });
});
