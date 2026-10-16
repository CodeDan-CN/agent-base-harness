import { afterEach, describe, expect, it } from 'vitest';
import { symlinkSync, unlinkSync } from 'node:fs';
import { ScopedFileSystem } from '../../packages/execution/src/filesystem/scoped-file-system';
import {
  agentMemoryProfilePath,
  ensureAgentMemoryProfile,
} from '../../packages/execution/src/workspace/agent-memory-profile';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

describe('4.7.5 Agent shallow memory isolation', () => {
  let root = '';

  afterEach(() => {
    if (root) cleanupDir(root);
  });

  it('shares one profile across an Agent sessions but not across Agents', async () => {
    root = makeTempDir();
    ensureAgentMemoryProfile(root, 'user-a', 'dylan', 'Dylan memory');
    ensureAgentMemoryProfile(root, 'user-a', 'finance', 'Finance memory');
    const files = new ScopedFileSystem(root);

    expect((await files.read(scope('dylan', 's1'), 'agent-memory://profile')).content).toContain(
      'Dylan memory',
    );
    await files.read(scope('dylan', 's2'), 'agent-memory://profile');
    await files.write(scope('dylan', 's2'), 'agent-memory://profile', 'Dylan updated');

    expect((await files.read(scope('dylan', 's1'), 'agent-memory://profile')).content).toContain(
      'Dylan updated',
    );
    expect((await files.read(scope('finance', 's3'), 'agent-memory://profile')).content).toContain(
      'Finance memory',
    );
  });

  it('rejects a symlink that redirects one Agent profile to another Agent', async () => {
    root = makeTempDir();
    const dylan = ensureAgentMemoryProfile(root, 'user-a', 'dylan', 'Dylan memory');
    const finance = ensureAgentMemoryProfile(root, 'user-a', 'finance', 'Finance memory');
    unlinkSync(dylan);
    symlinkSync(finance, dylan);

    const files = new ScopedFileSystem(root);
    await expect(files.read(scope('dylan', 's1'), 'agent-memory://profile')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    expect(agentMemoryProfilePath(root, 'user-a', 'dylan')).toBe(dylan);
  });
});

function scope(agentId: string, sessionId: string) {
  return { userId: 'user-a', agentId, sessionId };
}
