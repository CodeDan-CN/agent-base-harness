import { describe, expect, it } from 'vitest';
import {
  matchModelCapability,
  simplifyModelsDevCatalog,
  validateCatalog,
} from '../../packages/runtime-core/src/model-catalog';
import {
  applyThinkingSettings,
  getProviderPreset,
  inferProviderPresetFromEndpoint,
  normalizeReasoningEffort,
  supportedReasoningEffortsFor,
} from '../../packages/runtime-core/src/provider-presets';
import { pruneToolResultText, selectCheckpointMessages } from '../../packages/runtime-core/src/surface-compactor';
import { projectRuntime } from '../../packages/protocol/src/client/projection';
import { ContextProjector } from '../../packages/runtime-core/src/context-projector';
import {
  maximumManualOutputBudget,
  recommendedOutputBudget,
} from '../../packages/protocol/src/client/model-output-policy';
import bundledCatalog from '../../resources/model-catalog.json';

describe('Stage 4 模型能力与上下文管理', () => {
  it('输出自动预算取压缩余量与模型能力的较小值', () => {
    expect(
      recommendedOutputBudget({
        contextWindow: 1_000_000,
        compactionTriggerRatio: 0.8,
        maxOutputCapability: 384_000,
      }),
    ).toBe(200_000);
    expect(
      recommendedOutputBudget({
        contextWindow: 1_000_000,
        compactionTriggerRatio: 0.5,
        maxOutputCapability: 384_000,
      }),
    ).toBe(384_000);
    expect(
      maximumManualOutputBudget({
        contextWindow: 32_768,
        maxOutputCapability: 65_536,
      }),
    ).toBe(32_767);
  });

  it('内置离线目录可解析且包含模型能力记录', () => {
    const catalog = validateCatalog(bundledCatalog);
    expect(catalog.providers.length).toBeGreaterThan(100);
    expect(
      catalog.providers.reduce((total, provider) => total + provider.models.length, 0),
    ).toBeGreaterThan(6000);
  });

  it('当前 DeepSeek 按服务匹配，本地模型名忽略符号和大小写后取主流容量', () => {
    const catalog = validateCatalog(bundledCatalog);
    expect(
      matchModelCapability(catalog, {
        modelId: 'deepseek-v4-flash-0731',
        apiEndpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        providerPresetId: 'alibaba-bailian',
      }),
    ).toMatchObject({
      model: { context: 1_000_000, output: 384_000 },
      matchKind: 'preset',
    });
    expect(
      matchModelCapability(catalog, {
        modelId: 'qwen36-27b',
        apiEndpoint: 'http://10.1.18.86:8000/v1',
      }),
    ).toMatchObject({
      model: { context: 262_144, output: 65_536 },
      matchKind: 'model-consensus',
    });
  });

  it('百炼 DeepSeek V4 快照按真实档位归一化思考强度', () => {
    expect(supportedReasoningEffortsFor('alibaba-bailian', 'deepseek-v4-flash-0731')).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(normalizeReasoningEffort('alibaba-bailian', 'deepseek-v4-flash-0731', 'medium')).toBe(
      'high',
    );
    expect(
      applyThinkingSettings(
        'alibaba-bailian',
        'deepseek-v4-flash-0731',
        { thinkingMode: 'enabled', reasoningEffort: 'low' },
        {},
      ),
    ).toEqual({ enable_thinking: true, reasoning_effort: 'low' });
  });

  it('精简 models.dev 数据时过滤坏记录并稳定排序', () => {
    const catalog = simplifyModelsDevCatalog(
      {
        zeta: {
          api: 'https://api.zeta.example/v1',
          models: {
            broken: { limit: { context: 0, output: 10 } },
            good: { id: 'model-z', limit: { context: 32000, input: 30000, output: 2000 } },
          },
        },
        alpha: {
          baseURL: 'https://api.alpha.example/v1',
          models: { good: { id: 'model-a', context: 16000, output: 1000 } },
        },
      },
      '2026-08-26T00:00:00.000Z',
    );

    expect(validateCatalog(catalog).providers.map((provider) => provider.id)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(catalog.providers[1]?.models).toEqual([
      { id: 'model-z', context: 32000, input: 30000, output: 2000 },
    ]);
  });

  it('自定义 OpenAI-compatible 仅在能力一致时按 model id 回退匹配', () => {
    const catalog = validateCatalog({
      schemaVersion: 1,
      source: 'https://models.dev/api.json',
      generatedAt: 'now',
      providers: [
        { id: 'one', apiHosts: [], models: [{ id: 'shared', context: 8000, output: 1000 }] },
        { id: 'two', apiHosts: [], models: [{ id: 'shared', context: 16000, output: 1000 }] },
      ],
    });

    expect(matchModelCapability(catalog, { modelId: 'shared' })).toMatchObject({
      model: null,
      matchKind: 'unresolved',
      conflicts: ['one', 'two'],
    });
  });

  it('DeepSeek 与百炼预制映射思考开关和强度，自定义供应商不注入字段', () => {
    expect(
      applyThinkingSettings(
        'deepseek-official',
        'deepseek-chat',
        { thinkingMode: 'enabled', reasoningEffort: 'low' },
        { temperature: 0.2 },
      ),
    ).toEqual({ temperature: 0.2, thinking: { type: 'enabled' }, reasoning_effort: 'low' });
    expect(
      applyThinkingSettings(
        'alibaba-bailian',
        'qwen-plus',
        { thinkingMode: 'disabled', reasoningEffort: null },
        {},
      ),
    ).toEqual({ enable_thinking: false });
    expect(
      applyThinkingSettings(
        null,
        'custom-model',
        { thinkingMode: 'enabled', reasoningEffort: 'high' },
        { a: 1 },
      ),
    ).toEqual({ a: 1 });
    expect(getProviderPreset('deepseek-official')?.defaultEndpoint).toContain('deepseek.com');
  });

  it('阶段 4 前创建的官方 Endpoint 可恢复预制思考控件，未知网关不猜测', () => {
    expect(inferProviderPresetFromEndpoint('https://api.deepseek.com/')).toMatchObject({
      id: 'deepseek-official',
    });
    expect(
      inferProviderPresetFromEndpoint(
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      ),
    ).toMatchObject({ id: 'alibaba-bailian' });
    expect(inferProviderPresetFromEndpoint('https://gateway.example.com/v1')).toBeNull();
  });

  it('长工具结果按 Unicode 码点保留头尾，短结果不裁剪', () => {
    expect(pruneToolResultText('短结果')).toBeNull();
    const pruned = pruneToolResultText('😀'.repeat(9000));
    expect(pruned).toContain('原始结果仍保留在事件日志中');
    expect([...pruned!].filter((character) => character === '😀')).toHaveLength(5120);
  });

  it('运行检查点只选择完整的历史 Turn，不吞掉当前 Turn', () => {
    const projection = projectRuntime([]);
    projection.messages.push(
      { seq: 1, role: 'user', content: 'a'.repeat(100), eventId: 'e', turnId: 'old' },
      { seq: 2, role: 'assistant', content: 'b'.repeat(100), eventId: 'e', turnId: 'old' },
      { seq: 3, role: 'user', content: 'current', eventId: 'e', turnId: 'current' },
    );
    expect(
      selectCheckpointMessages(projection, 'current', 10).map((message) => message.seq),
    ).toEqual([1, 2]);
  });

  it('首 Step 按 Session 摘要、Event 摘要、最新问题的优先顺序投影', () => {
    const projection = projectRuntime([]);
    projection.events.set('event-a', {
      id: 'event-a',
      title: '事项 A',
      status: 'open',
      summary: '事件细节摘要',
      summaryVersion: 1,
      summaryThroughSeq: 8,
      createdAt: 'now',
      updatedAt: 'now',
    });
    projection.sessionMemorySummary = {
      summary: '会话整体摘要',
      summaryVersion: 1,
      coveredThroughSeq: 8,
      summaryTokens: 10,
      inputTokens: 20,
      outputTokens: 10,
      updatedAt: 'now',
    };
    projection.messages.push({
      seq: 9,
      role: 'user',
      content: '最新问题',
      eventId: 'event-a',
      turnId: 'turn-current',
    });

    const context = new ContextProjector().project({
      projection,
      eventId: 'event-a',
      turnId: 'turn-current',
      contextWindow: 10000,
      inputCapability: 9000,
      reservedOutputTokens: 1000,
      safetyTokens: 2048,
      tools: [
        {
          name: 'capability_search',
          description: 'Search Skill and MCP candidates together.',
          inputSchema: { type: 'object' },
        },
      ],
      skills: [
        {
          id: 'weather-helper',
          userId: 'user-a',
          skillName: 'weather-helper',
          description: '获取天气信息',
          sourceType: 'local',
          sourceRef: null,
          rootPath: '/tmp/weather-helper',
          metadata: {},
          contentDigest: 'digest',
          enabled: true,
          status: 'valid',
          compatibilityStatus: 'compatible',
          createdAt: 'now',
          updatedAt: 'now',
        },
      ],
    });

    expect(context.messages[0]?.content).toContain('capability_search');
    expect(context.messages[0]?.content).toContain('agent-memory://profile');
    expect(context.messages[0]?.content).toContain('复杂或详细的长期记忆继续使用');
    expect(context.messages[0]?.content).not.toContain('weather-helper');
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]).toMatchObject({ role: 'system' });
    expect(context.messages[0]?.content).toContain('当前会话所属的智能体');
    expect(context.messages[0]?.content).toContain('会话历史摘要：\n会话整体摘要');
    expect(context.messages[0]?.content).toContain('当前事件摘要：\n事件细节摘要');
    expect(context.messages[1]).toEqual({ role: 'user', content: '最新问题' });
    expect(context.budgetTokens).toBe(8000);
    expect(context.softTriggerTokens).toBe(8000);
    expect(context.tokenBreakdown.historyTokens).toBeGreaterThan(0);
    expect(context.tokenBreakdown.currentTurnTokens).toBeGreaterThan(0);
    expect(context.tokenBreakdown.fixedTokens).toBeGreaterThan(0);
    expect(
      context.tokenBreakdown.fixedTokens +
        context.tokenBreakdown.historyTokens +
        context.tokenBreakdown.currentTurnTokens,
    ).toBe(context.estimatedInputTokens);
  });
});
