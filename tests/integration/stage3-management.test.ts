import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApplication } from '../../packages/server-core/src/application/application';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { ScopedFileSystem } from '../../packages/execution/src/filesystem/scoped-file-system';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { ShellExecutor } from '../../packages/execution/src/process/shell-executor';
import { createBuiltinTools } from '../../packages/runtime-core/src/builtin-tools';
import { ToolRegistry, ToolScheduler } from '../../packages/runtime-core/src/tools';
import { FixedClock, SequentialIdProvider } from '../../packages/test-kit/src/clock';
import { cleanupDir, makeTempDir, writeFile } from '../../packages/test-kit/src/temp';

describe('Stage 3 模型与 Skill 管理', () => {
  let root: string;
  let credentials: FakeCredentialStore;
  let app: ReturnType<typeof createWorkerApplication>;

  beforeEach(() => {
    root = makeTempDir('agent-stage3-');
    credentials = new FakeCredentialStore();
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequentialIdProvider('stage3'),
      credentialStore: credentials,
    });
  });

  afterEach(() => {
    app.close();
    cleanupDir(root);
  });

  it('模型服务、模型和默认项形成真实配置闭环，快照不回传密钥', async () => {
    const created = await app.saveModelService('user-a', {
      name: '测试服务',
      providerType: 'openai-compatible',
      endpoint: 'https://models.example.com/v1',
      enabled: true,
      config: { temperature: 0.2, apiKey: 'must-be-removed' },
      credential: { action: 'replace', value: 'stage3-secret' },
      expectedRevision: 0,
    });

    const afterService = await app.modelManagement('user-a');
    expect(afterService.revision).toBe(1);
    expect(afterService.services[0]).toMatchObject({
      id: created.id,
      credentialStatus: 'configured',
      endpoint: 'https://models.example.com/v1',
    });
    expect(JSON.stringify(afterService)).not.toContain('stage3-secret');
    expect(JSON.stringify(afterService)).not.toContain('must-be-removed');
    expect((await app.modelManagement('user-b')).services).toEqual([]);

    expect(() =>
      app.saveModel('user-a', {
        serviceId: created.id,
        remoteModelId: 'test-model',
        displayName: '测试模型',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        capabilities: { tools: true, streaming: true, vision: false },
        defaultParams: {},
        enabled: true,
        expectedRevision: 0,
      }),
    ).toThrowError(/revision/i);

    const model = app.saveModel('user-a', {
      serviceId: created.id,
      remoteModelId: 'test-model',
      displayName: '测试模型',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: afterService.revision,
    });
    const afterModel = await app.modelManagement('user-a');
    app.setDefaultModel('user-a', model.id, afterModel.revision);
    const complete = await app.modelManagement('user-a');
    expect(complete.defaultModelId).toBe(model.id);
    expect(complete.models[0]).toMatchObject({ remoteModelId: 'test-model', status: 'enabled' });
  });

  it('归档模型从远程列表重新添加时恢复原记录而不触发唯一键约束', async () => {
    const service = await app.saveModelService('user-a', {
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      endpoint: 'https://api.deepseek.com/',
      enabled: true,
      config: {},
      credential: { action: 'unchanged' },
      expectedRevision: 0,
    });
    const created = app.saveModel('user-a', {
      serviceId: service.id,
      remoteModelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      contextWindow: 1_000_000,
      maxOutputTokens: 4096,
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: 1,
    });
    app.archiveModel('user-a', created.id, 2);

    const restored = app.saveModel('user-a', {
      serviceId: service.id,
      remoteModelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      contextWindow: 1_000_000,
      maxOutputTokens: 4096,
      thinkingMode: 'enabled',
      reasoningEffort: 'high',
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: 3,
    });

    expect(restored.id).toBe(created.id);
    const snapshot = await app.modelManagement('user-a');
    expect(snapshot.services[0]?.providerPresetId).toBe('deepseek-official');
    expect(snapshot.models).toEqual([
      expect.objectContaining({
        id: created.id,
        status: 'enabled',
        thinkingMode: 'enabled',
        reasoningEffort: 'high',
      }),
    ]);
  });

  it('自动输出预算随上下文和压缩阈值变化并允许手动覆盖', async () => {
    const service = await app.saveModelService('user-a', {
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      endpoint: 'https://api.deepseek.com/',
      enabled: true,
      config: {},
      credential: { action: 'unchanged' },
      expectedRevision: 0,
    });
    const created = app.saveModel('user-a', {
      serviceId: service.id,
      remoteModelId: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      contextWindow: 1_000_000,
      compactionTriggerRatio: 0.8,
      maxOutputCapability: 384_000,
      requestMaxOutputTokens: null,
      maxOutputTokens: 200_000,
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: 1,
    });

    let snapshot = await app.modelManagement('user-a');
    expect(snapshot.models[0]).toMatchObject({
      requestMaxOutputTokens: null,
      maxOutputTokens: 200_000,
    });

    app.saveModel('user-a', {
      id: created.id,
      serviceId: service.id,
      remoteModelId: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      contextWindow: 1_000_000,
      compactionTriggerRatio: 0.7,
      maxOutputCapability: 384_000,
      requestMaxOutputTokens: null,
      maxOutputTokens: 300_000,
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: snapshot.revision,
    });
    snapshot = await app.modelManagement('user-a');
    expect(snapshot.models[0]).toMatchObject({
      requestMaxOutputTokens: null,
      maxOutputTokens: 300_000,
    });

    app.saveModel('user-a', {
      id: created.id,
      serviceId: service.id,
      remoteModelId: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      contextWindow: 1_000_000,
      compactionTriggerRatio: 0.7,
      maxOutputCapability: 384_000,
      requestMaxOutputTokens: 32_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: snapshot.revision,
    });
    expect((await app.modelManagement('user-a')).models[0]).toMatchObject({
      requestMaxOutputTokens: 32_000,
      maxOutputTokens: 32_000,
    });
  });

  it('旧模型按服务或规范化模型名恢复目录容量', async () => {
    const now = '2026-08-27T00:00:00.000Z';
    app.repos.models.createService({
      id: 'deepseek-service',
      userId: 'user-a',
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      endpoint: 'https://api.deepseek.com/',
      credentialRef: null,
      config: {},
      now,
    });
    app.repos.models.createModel({
      id: 'deepseek-model',
      userId: 'user-a',
      serviceId: 'deepseek-service',
      remoteModelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      metadataSource: 'legacy',
      capabilityMatchKind: 'unresolved',
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      source: 'manual',
      now,
    });
    app.repos.models.createService({
      id: 'local-service',
      userId: 'user-a',
      name: 'B70',
      providerType: 'openai-compatible',
      endpoint: 'http://10.1.18.86:8000/v1',
      credentialRef: null,
      config: {},
      now,
    });
    app.repos.models.createModel({
      id: 'local-model',
      userId: 'user-a',
      serviceId: 'local-service',
      remoteModelId: 'qwen36-27b',
      displayName: 'qwen36-27b',
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      metadataSource: 'legacy',
      capabilityMatchKind: 'unresolved',
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      source: 'manual',
      now,
    });

    const snapshot = await app.modelManagement('user-a');
    expect(snapshot.models.find((model) => model.id === 'deepseek-model')).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputCapability: 384_000,
      metadataSource: 'catalog',
      capabilityMatchKind: 'preset',
    });
    expect(snapshot.models.find((model) => model.id === 'local-model')).toMatchObject({
      contextWindow: 262_144,
      maxOutputCapability: 65_536,
      metadataSource: 'catalog',
      capabilityMatchKind: 'model-consensus',
    });
  });

  it('目录安装进入用户托管区，Skill 默认可绑定且列表按用户隔离', async () => {
    const source = path.join(root, 'source', 'weather-helper');
    mkdirSync(source, { recursive: true });
    writeFile(
      path.join(source, 'SKILL.md'),
      '---\nname: weather-helper\ndescription: 获取天气信息\nversion: 1.0.0\n---\n\n# Weather\n',
    );
    writeFile(path.join(source, 'scripts', 'check.sh'), "printf 'SKILL_COMMAND_OK\\n'\n");

    expect(app.installSkillDirectory('user-a', source)).toEqual({ skillName: 'weather-helper' });
    const installed = app.skillManagement('user-a');
    expect(installed.skills).toHaveLength(1);
    expect(installed.skills[0]).toMatchObject({
      name: 'weather-helper',
      enabled: true,
      status: 'valid',
      compatibilityStatus: 'compatible',
    });
    expect(JSON.stringify(installed)).not.toContain(source);
    expect(app.skillManagement('user-b').skills).toEqual([]);

    const tools = createBuiltinTools({
      appDataDir: app.appDataDir,
      repos: app.repos,
      fileSystem: new ScopedFileSystem(app.appDataDir),
      shell: new ShellExecutor(app.appDataDir, app.processRunner),
    });
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const scheduler = new ToolScheduler(registry);
    const context = {
      userId: 'user-a',
      sessionId: 'session-1',
      eventId: 'event-1',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    };
    const [loaded] = await scheduler.execute(
      [
        {
          id: 'tool-1',
          name: 'skill_load',
          arguments: { name: 'weather-helper' },
        },
      ],
      context,
    );
    expect(loaded?.result.status).toBe('success');
    const loadedText =
      loaded?.result.content[0]?.type === 'text' ? loaded.result.content[0].text : '';
    expect(loadedText).toContain('<skill_content name="weather-helper">');
    expect(loadedText).toContain('<skill_resources>');
    expect(loadedText).toContain('# Weather');
    const resourceBase = /Base directory for this skill: ([^\n]+)/.exec(loadedText)?.[1];
    expect(resourceBase).toBeTruthy();
    if (!resourceBase) throw new Error('Skill resource base missing');
    expect(resourceBase).toContain(
      path.join('workspaces', 'user-a', 'session-1', '.skill-resources'),
    );

    const [readResource] = await scheduler.execute(
      [
        {
          id: 'tool-read',
          name: 'read',
          arguments: { file_path: path.join(resourceBase, 'scripts', 'check.sh') },
        },
      ],
      context,
    );
    expect(readResource?.result.status, JSON.stringify(readResource)).toBe('success');
    expect(readResource?.result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('SKILL_COMMAND_OK') }),
    ]);

    const [executed] = await scheduler.execute(
      [
        {
          id: 'tool-2',
          name: 'bash',
          arguments: {
            command: `bash scripts/check.sh && printf '<html>ok</html>' > "$AGENT_ARTIFACTS_DIR/report.html"`,
            description: '执行 Skill 测试脚本',
            workdir: resourceBase,
          },
        },
      ],
      context,
    );
    expect(executed?.result.status, JSON.stringify(executed)).toBe('success');
    expect(executed?.result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('SKILL_COMMAND_OK') }),
    ]);
    expect(executed?.result.presentation).toMatchObject({
      status: 'success',
      locations: [{ path: 'artifacts/report.html' }],
    });
  });
});
