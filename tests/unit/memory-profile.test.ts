import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectRuntime } from '../../packages/protocol/src/client/projection';
import { ScopedFileSystem } from '../../packages/execution/src/filesystem/scoped-file-system';
import {
  agentMemoryProfilePath,
  ensureAgentMemoryProfile,
} from '../../packages/execution/src/workspace/agent-memory-profile';
import { userMemoryProfilePath } from '../../packages/execution/src/workspace/session-workspace';
import { ContextProjector } from '../../packages/runtime-core/src/context-projector';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agent memory profile', () => {
  it('creates one profile per agent without overwriting existing memory', () => {
    const root = createRoot();
    const userAPath = ensureAgentMemoryProfile(root, 'user-a', 'agent-a');
    const userBPath = ensureAgentMemoryProfile(root, 'user-b', 'agent-b');
    writeFileSync(userAPath, '- 助手名称：小爱同学\n', 'utf8');

    ensureAgentMemoryProfile(root, 'user-a', 'agent-a');

    expect(readFileSync(userAPath, 'utf8')).toBe('- 助手名称：小爱同学\n');
    expect(readFileSync(userBPath, 'utf8')).toBe('');
    expect(userAPath).not.toBe(userBPath);
  });

  it('injects only the current agent profile into the stable system message', () => {
    const root = createRoot();
    writeFileSync(
      ensureAgentMemoryProfile(root, 'user-a', 'agent-a'),
      '- 助手名称：小爱同学\n',
      'utf8',
    );
    writeFileSync(
      ensureAgentMemoryProfile(root, 'user-a', 'agent-b'),
      '- 助手名称：小智同学\n',
      'utf8',
    );
    const projector = new ContextProjector();

    const context = projector.project({
      userId: 'user-a',
      agentId: 'agent-a',
      agentMemoryProfile: '- 助手名称：小爱同学',
      projection: projectRuntime([]),
      eventId: 'event-1',
      turnId: 'turn-1',
      contextWindow: 8_192,
      reservedOutputTokens: 1_024,
      safetyTokens: 512,
      tools: [],
      skills: [],
    });

    expect(context.messages[0]?.content).toContain('<agent_memory_profile>');
    expect(context.messages[0]?.content).toContain('助手名称：小爱同学');
    expect(context.messages[0]?.content).not.toContain('助手名称：小智同学');
    expect(context.messages[0]?.content).toContain('先 read 当前“agent-memory://profile”');
    expect(context.messages[0]?.content).toContain('复杂或详细的长期记忆继续使用');
  });

  it('treats ../memory-profile.md as outside the session workspace', () => {
    const root = createRoot();
    const fileSystem = new ScopedFileSystem(root);

    expect(
      fileSystem.isOutsideWorkspace(
        { userId: 'user-a', sessionId: 'session-1' },
        '../memory-profile.md',
      ),
    ).toBe(true);
    expect(userMemoryProfilePath(root, 'user-a')).toBe(
      path.join(root, 'workspaces', 'user-a', 'memory-profile.md'),
    );
    expect(agentMemoryProfilePath(root, 'user-a', 'agent-a')).toBe(
      path.join(root, 'users', 'user-a', 'agents', 'agent-a', 'memory-profile.md'),
    );
  });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-profile-test-'));
  roots.push(root);
  return root;
}
