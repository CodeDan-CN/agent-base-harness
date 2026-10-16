import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from '../../packages/protocol/src/token-estimate';
import {
  ToolOutputLimiter,
  limitToolOutput,
} from '../../packages/runtime-core/src/tool-output-limiter';
import { pruneToolResultText } from '../../packages/runtime-core/src/surface-compactor';

describe('工具结果入模限额', () => {
  it('未超限及刚好达到限额的结果保持原文，计算包含消息开销', () => {
    expect(limitToolOutput('短结果', 128, 1)).toBeNull();
    expect(limitToolOutput('a'.repeat(124 * 4), 128, 1)).toBeNull();
    expect(limitToolOutput('a'.repeat(124 * 4 + 1), 128, 1)).not.toBeNull();
  });

  it.each(['a', '中文', '😀', 'a中😀\n', '{"key":"数据"}\n'])(
    '对 %s 文本的完整输出计费，保留头尾和原文定位',
    (unit) => {
      const text = 'HEAD-' + unit.repeat(20_000) + '-TAIL';
      for (const limit of [128, 129, 256, 1024, 4096]) {
        const output = limitToolOutput(text, limit, Number.MAX_SAFE_INTEGER)!;
        expect(output.startsWith('HEAD-')).toBe(true);
        expect(output).toContain('-TAIL');
        expect(output).toContain('仅含部分内容');
        expect(output).toContain(`tool.result seq=${Number.MAX_SAFE_INTEGER}`);
        expect(estimateTextTokens(output) + 4).toBeLessThanOrEqual(limit);
        expect(Buffer.from(output).toString('utf8')).toBe(output);
        expect(limitToolOutput(output, limit, 1)).toBeNull();
      }
    },
  );

  it('全局配置与精确工具名覆盖冻结，不受调用方后续修改影响', () => {
    const overrides = { mcp_memory_search: 512, large_read: 4096 };
    const limiter = new ToolOutputLimiter({
      toolOutputTokenLimit: 256,
      toolOutputTokenLimits: overrides,
    });
    overrides.mcp_memory_search = 1024;
    expect(limiter.limitFor('mcp_memory_search')).toBe(512);
    expect(limiter.limitFor('large_read')).toBe(4096);
    expect(limiter.limitFor('other')).toBe(256);
    expect(limiter.limitFor('toString')).toBe(256);
  });

  it('后续压力裁剪仍保留原始定位，且不会突破入模限额', () => {
    const limited = limitToolOutput('a'.repeat(100000), 4096, 42)!;
    const pruned = pruneToolResultText(limited)!;
    expect(pruned).toContain('tool.result seq=42');
    expect(estimateTextTokens(pruned) + 4).toBeLessThanOrEqual(4096);
    expect(pruned.length).toBeLessThan(limited.length);
  });

  it.each([0, -1, 127, 128.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '启动时拒绝无效限额 %s',
    (limit) => {
      expect(() => new ToolOutputLimiter({ toolOutputTokenLimit: limit })).toThrow('safe integer');
      expect(() => new ToolOutputLimiter({ toolOutputTokenLimits: { read: limit } })).toThrow(
        'safe integer',
      );
    },
  );
});
