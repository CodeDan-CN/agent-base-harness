import { describe, expect, it } from 'vitest';
import {
  compactionGenerationMetadata,
  createCompactionRequest,
  limitCompactionText,
} from '../../packages/runtime-core/src/compaction-policy';
import type { ModelSnapshot } from '../../packages/runtime-core/src/model';
import { estimateTextTokens } from '../../packages/protocol/src/token-estimate';
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  validateAndUpcastRuntimeEvent,
} from '../../packages/protocol/src/client/runtime';
import { textResponse } from '../../packages/test-kit/src/runtime';

const model: ModelSnapshot = {
  serviceId: 'service',
  modelId: 'model',
  providerType: 'fake',
  remoteModelId: 'fake',
  endpoint: 'https://invalid.local',
  credentialRef: null,
  contextWindow: 32000,
  maxOutputTokens: 4096,
  requestMaxOutputTokens: 4096,
  maxOutputCapability: 32768,
  params: {},
  configRevision: 1,
};

function plan(overrides: Partial<Parameters<typeof createCompactionRequest>[0]> = {}) {
  return createCompactionRequest({
    requestId: 'summary',
    model,
    instructions: '生成运行检查点。',
    content: '材料'.repeat(7000),
    sourceTokens: 14000,
    safetyTokens: 2048,
    ...overrides,
  });
}

describe('摘要比例预算与直接限长', () => {
  it.each([8000, 32000, 32768, 128000, 250000])(
    '按本次用户模型的 %i 窗口动态计算，不复用其他模型的预算',
    (contextWindow) => {
      const sourceTokens = Math.floor(contextWindow * 0.4);
      const result = plan({
        model: { ...model, contextWindow, maxOutputCapability: 200000 },
        content: '材'.repeat(sourceTokens),
        sourceTokens,
      });
      expect(result.targetTokens).toBe(Math.floor(contextWindow * 0.25));
      expect(result.request.maxOutputTokens).toBe(Math.floor(contextWindow * 0.4));
      expect(result.request.model.contextWindow).toBe(contextWindow);
      expect(model.contextWindow).toBe(32000);
    },
  );

  it('32,000 窗口使用 8,000 目标和 12,800 生成上限，业务请求仍为 4,096', () => {
    const result = plan();
    expect(result.targetTokens).toBe(8000);
    expect(result.request.maxOutputTokens).toBe(12800);
    expect(result.request.model.maxOutputTokens).toBe(4096);
    expect(result.request.model.requestMaxOutputTokens).toBe(4096);
    expect(result.request.messages[0]?.content).toContain('8000 个中文字符');
    expect(result.request.messages[0]?.content).toContain('12800 token');
    expect(result.request.messages[0]?.content).toContain('禁止扩写凑字数');
    expect(result.estimatedInputTokens + result.request.maxOutputTokens + 2048).toBeLessThanOrEqual(
      32000,
    );
  });

  it('输入较长时按包含长度提示的完整请求收紧生成额度', () => {
    const result = plan({ content: '材'.repeat(27000), sourceTokens: 27000 });
    expect(result.request.maxOutputTokens).toBeLessThan(4096);
    expect(result.request.maxOutputTokens).toBeGreaterThan(0);
    expect(result.estimatedInputTokens).toBe(
      result.request.messages.reduce(
        (sum, message) => sum + estimateTextTokens(message.content) + 4,
        0,
      ),
    );
    expect(result.estimatedInputTokens + result.request.maxOutputTokens + 2048).toBeLessThanOrEqual(
      32000,
    );
    expect(result.targetTokens).toBeLessThan(result.request.maxOutputTokens);
  });

  it.each([
    { model: { ...model, maxOutputCapability: 2048 }, expected: 2048 },
    { model: { ...model, maxOutputCapability: undefined }, expected: 4096 },
  ])('遵守模型输出能力，缺失能力时保守沿用已知上限 $expected', ({ model, expected }) => {
    expect(plan({ model }).request.maxOutputTokens).toBe(expected);
  });

  it('短材料降低正文目标，不要求凑满窗口比例', () => {
    expect(plan({ content: '短材料', sourceTokens: 100 }).targetTokens).toBeLessThan(100);
  });

  it.each([
    { content: '材'.repeat(32000), sourceTokens: 32000 },
    { model: { ...model, inputCapability: 15000 } },
  ])('输入没有合法预算时不构造超窗口请求', (overrides) => {
    expect(() => plan(overrides)).toThrowError(
      expect.objectContaining({
        name: 'COMPACTION_INPUT_BUDGET_EXCEEDED',
      }),
    );
  });

  it('混合中文、英文和 emoji 的直接截断不超过估算限额，也不切开 Unicode 字符', () => {
    const content = '事实abc😀\n'.repeat(200);
    for (const limit of [1, 2, 3, 7, 128, 4096]) {
      const result = limitCompactionText(content, limit);
      expect(estimateTextTokens(result)).toBeLessThanOrEqual(limit);
      expect(content.startsWith(result)).toBe(true);
      expect(result.isWellFormed()).toBe(true);
    }
    expect(limitCompactionText(' 完整摘要 ', 100)).toBe('完整摘要');
  });

  it('生成触顶及本地截断都记录事实，事件往返不把 length 改成 complete', () => {
    const request = plan();
    for (const response of [
      { ...textResponse('可用摘要'), stopReason: 'length' as const },
      textResponse('摘'.repeat(14000)),
    ]) {
      const summary = limitCompactionText(response.content, request.request.maxOutputTokens);
      const metadata = compactionGenerationMetadata(request, response, summary);
      const event = validateAndUpcastRuntimeEvent(
        'compaction.ended',
        RUNTIME_EVENT_SCHEMA_VERSION,
        {
          compactionId: 'c',
          eventId: 'e',
          status: 'completed',
          summaryGeneration: metadata,
        },
      );
      expect(event).toMatchObject({
        summaryGeneration: { truncated: true, stopReason: response.stopReason },
      });
      expect(estimateTextTokens(summary)).toBeLessThanOrEqual(12800);
    }
    expect(
      validateAndUpcastRuntimeEvent('compaction.ended', RUNTIME_EVENT_SCHEMA_VERSION, {
        compactionId: 'old',
        eventId: 'e',
        status: 'completed',
      }),
    ).toEqual({ compactionId: 'old', eventId: 'e', status: 'completed' });
  });
});
