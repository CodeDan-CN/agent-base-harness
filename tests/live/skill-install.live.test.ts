import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { credentialRefOf } from '../../packages/execution/src/credential/credential-store';
import { createWorkerApplication } from '../../packages/server-core/src/application/application';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

const sourceDirectory = process.env.LIVE_SKILL_DIRECTORY;
const apiKey = process.env.LIVE_MODEL_API_KEY;
const endpoint = process.env.LIVE_MODEL_ENDPOINT;
const remoteModelId = process.env.LIVE_MODEL_ID;
const agentLiveEnabled = Boolean(sourceDirectory && apiKey && endpoint && remoteModelId);
const live = sourceDirectory ? describe : describe.skip;

live('真实标准 Skill 目录导入', () => {
  let appData: string;
  let app: ReturnType<typeof createWorkerApplication>;

  beforeEach(() => {
    appData = makeTempDir('agent-live-skill-');
    app = createWorkerApplication({
      appDataDir: appData,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
    });
  });

  afterEach(() => {
    app.close();
    cleanupDir(appData);
  });

  it('解析、复制到用户托管区、入库并启用，但不执行 Skill 脚本', () => {
    const installed = installAndEnable(app, sourceDirectory!);
    const snapshot = app.skillManagement('user-a');
    const skill = snapshot.skills.find((item) => item.name === installed.skillName);

    expect(skill).toMatchObject({
      name: installed.skillName,
      enabled: true,
      status: 'valid',
      compatibilityStatus: 'compatible',
    });
    expect(JSON.stringify(snapshot)).not.toContain(sourceDirectory);
    expect(
      existsSync(path.join(appData, 'skills', 'user-a', installed.skillName, 'SKILL.md')),
    ).toBe(true);

    expect(app.skillManagement('user-b').skills).toEqual([]);
  });

  it.runIf(agentLiveEnabled)(
    '真实 Agent 加载 Skill、执行受控宿主命令并生成查询答复',
    async () => {
      const installed = installAndEnable(app, sourceDirectory!);
      const scope = { userId: 'user-a', purpose: 'model-service', entityId: 'skill-live' };
      await app.credentialStore.set(scope, apiKey!);
      const now = new Date().toISOString();
      app.repos.models.createService({
        id: 'skill-live',
        userId: 'user-a',
        name: 'Skill live model',
        providerType: 'openai-compatible',
        endpoint: endpoint!,
        credentialRef: credentialRefOf(scope),
        config: { temperature: 0 },
        now,
      });
      app.repos.models.createModel({
        id: 'skill-live-model',
        userId: 'user-a',
        serviceId: 'skill-live',
        remoteModelId: remoteModelId!,
        displayName: remoteModelId!,
        contextWindow: 1_000_000,
        maxOutputTokens: 2048,
        capabilities: { tools: true, streaming: true },
        defaultParams: {},
        source: 'manual',
        now,
      });
      app.repos.models.setDefaultModel('user-a', 'skill-live-model', now);

      app.runtime.createSession('user-a', { sessionId: 'skill-agent-live', title: '12306' });
      app.runtime.submitInput('user-a', {
        sessionId: 'skill-agent-live',
        content:
          `请使用已启用的 ${installed.skillName} Skill 查询 2026-09-01 北京到上海的车次。` +
          '必须先调用 skill_load，再根据 <skill_resources> 返回的 Base directory 执行 Skill 脚本并使用 --json；最后简要回答查询结果。',
        idempotencyKey: 'skill-agent-live-1',
        startNewEvent: true,
      });
      await app.runtime.waitForIdle();
      const snapshot = app.runtime.snapshot('user-a', 'skill-agent-live') as AgentSkillSnapshot;
      const calls = snapshot.trajectory.toolCalls;
      const callSummary = calls.map((call) => ({ name: call.name, status: call.status }));

      expect(snapshot.turns[0], JSON.stringify(callSummary)).toMatchObject({ status: 'completed' });
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'skill_load', status: 'success' }),
          expect.objectContaining({ name: 'host_command', status: 'success' }),
        ]),
      );
      expect(snapshot.messages.at(-1)).toMatchObject({ role: 'assistant' });
      expect(snapshot.messages.at(-1)?.content.length).toBeGreaterThan(20);
    },
    180_000,
  );
});

function installAndEnable(
  app: ReturnType<typeof createWorkerApplication>,
  source: string,
): { skillName: string } {
  const installed = app.installSkillDirectory('user-a', source);
  const snapshot = app.skillManagement('user-a');
  app.setSkillEnabled('user-a', installed.skillName, true, snapshot.revision);
  return installed;
}

interface AgentSkillSnapshot {
  turns: Array<{ status: string; stepCount: number; endReason: string | null }>;
  messages: Array<{ role: string; content: string }>;
  trajectory: { toolCalls: Array<{ name: string; status: string }> };
}
