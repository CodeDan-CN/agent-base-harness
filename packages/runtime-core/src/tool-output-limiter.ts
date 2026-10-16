import { estimateTextTokens } from '../../protocol/src/token-estimate';

export interface ToolOutputLimitOptions {
  /** Estimated tokens per rendered tool message, including notices and message framing. */
  toolOutputTokenLimit?: number;
  /** Exact runtime tool names, including the public names of MCP tools. */
  toolOutputTokenLimits?: Readonly<Record<string, number>>;
}

const MESSAGE_OVERHEAD_TOKENS = 4;
const DEFAULT_TOKEN_LIMIT = 4096;
const MIN_TOKEN_LIMIT = 128;

/** Immutable host configuration; invalid limits fail before a driver starts. */
export class ToolOutputLimiter {
  private readonly defaultLimit: number;
  private readonly overrides: ReadonlyMap<string, number>;

  constructor(options: ToolOutputLimitOptions = {}) {
    this.defaultLimit = options.toolOutputTokenLimit ?? DEFAULT_TOKEN_LIMIT;
    validateLimit(this.defaultLimit);
    const entries = Object.entries(options.toolOutputTokenLimits ?? {});
    for (const [name, limit] of entries) {
      if (!name.trim()) throw new Error('Tool output limit requires a non-empty tool name');
      validateLimit(limit);
    }
    this.overrides = new Map(entries);
  }

  limitFor(toolName: string): number {
    return this.overrides.get(toolName) ?? this.defaultLimit;
  }
}

/** Bound the complete model-facing text without changing the original tool result. */
export function limitToolOutput(text: string, limit: number, sourceSeq: number): string | null {
  validateLimit(limit);
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 1) {
    throw new Error('Tool output reference requires a positive safe event sequence');
  }
  if (estimateTextTokens(text) + MESSAGE_OVERHEAD_TOKENS <= limit) return null;

  const middle = '\n\n[...中间内容已省略...]\n\n';
  // Keep the locator at the end so a later pressure-based head/tail prune retains it.
  const reference = `\n\n[工具结果已裁剪，仅含部分内容；原始结果：当前会话 tool.result seq=${sourceSeq}]`;
  const contentTokens = limit - MESSAGE_OVERHEAD_TOKENS - estimateTextTokens(middle + reference);
  const points = Array.from(text);
  const headUnits = Math.floor(contentTokens * 0.8) * 4;
  let usedUnits = 0;
  let headEnd = 0;
  while (headEnd < points.length && usedUnits + cost(points[headEnd]!) <= headUnits) {
    usedUnits += cost(points[headEnd++]!);
  }
  const tailUnits = contentTokens * 4 - usedUnits;
  let tailUsed = 0;
  let tailStart = points.length;
  while (tailStart > headEnd && tailUsed + cost(points[tailStart - 1]!) <= tailUnits) {
    tailUsed += cost(points[--tailStart]!);
  }
  return points.slice(0, headEnd).join('') + middle + points.slice(tailStart).join('') + reference;
}

// Same ASCII/non-ASCII weighting as the shared request estimator, in quarter tokens.
function cost(point: string): number {
  return point.codePointAt(0)! <= 0x7f ? 1 : 4;
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < MIN_TOKEN_LIMIT) {
    throw new Error(`Tool output token limit must be a safe integer >= ${MIN_TOKEN_LIMIT}`);
  }
}
