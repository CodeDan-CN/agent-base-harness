import type { ModelResponse, ModelStreamEvent, ModelToolCall } from './model';

interface ToolAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

/** 将 OpenAI-compatible SSE data 对象归一化为 Runtime 流事件。 */
export class OpenAiStreamNormalizer {
  private readonly tools = new Map<number, ToolAccumulator>();
  private readonly thinkTags = new ThinkTagStreamParser();
  private content = '';
  private reasoning = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private finishReason = 'stop';

  push(value: unknown): ModelStreamEvent[] {
    const root = record(value);
    const choice = arrayAt(root, 'choices')?.[0];
    const choiceRecord = record(choice);
    const delta = record(choiceRecord?.delta);
    const events: ModelStreamEvent[] = [];
    const explicitReasoning =
      stringAt(delta, 'reasoning_content') ?? stringAt(delta, 'reasoning') ?? '';
    if (explicitReasoning) {
      this.reasoning += explicitReasoning;
      events.push({ type: 'reasoning_delta', delta: explicitReasoning });
    }
    const text = stringAt(delta, 'content');
    if (text) {
      for (const segment of this.thinkTags.push(text)) {
        if (segment.kind === 'reasoning') {
          this.reasoning += segment.text;
          events.push({ type: 'reasoning_delta', delta: segment.text });
        } else {
          this.content += segment.text;
          events.push({ type: 'text_delta', delta: segment.text });
        }
      }
    }
    for (const rawCall of arrayAt(delta, 'tool_calls') ?? []) {
      const call = record(rawCall);
      const index = numberAt(call, 'index') ?? 0;
      const fn = record(call?.function);
      const current = this.tools.get(index) ?? { id: '', name: '', argumentsText: '' };
      const id = stringAt(call, 'id');
      const name = stringAt(fn, 'name');
      // 部分兼容服务在后续参数 delta 中发送空 id/name，不得覆盖首帧元数据。
      if (id) current.id = id;
      if (name) current.name = name;
      const argumentsDelta = stringAt(fn, 'arguments') ?? '';
      current.argumentsText += argumentsDelta;
      this.tools.set(index, current);
      events.push({
        type: 'tool_call_delta',
        index,
        id: id || undefined,
        name: name || undefined,
        argumentsDelta,
      });
    }
    this.finishReason = stringAt(choiceRecord, 'finish_reason') ?? this.finishReason;
    const usage = record(root?.usage);
    this.inputTokens = numberAt(usage, 'prompt_tokens') ?? this.inputTokens;
    this.outputTokens = numberAt(usage, 'completion_tokens') ?? this.outputTokens;
    return events;
  }

  complete(): ModelStreamEvent {
    for (const segment of this.thinkTags.flush()) {
      if (segment.kind === 'reasoning') this.reasoning += segment.text;
      else this.content += segment.text;
    }
    return {
      type: 'completed',
      response: buildResponse(
        this.content,
        this.reasoning,
        this.tools,
        this.inputTokens,
        this.outputTokens,
        this.finishReason,
      ),
    };
  }
}

/** 将 Anthropic Messages SSE 事件归一化为 Runtime 流事件。 */
export class AnthropicStreamNormalizer {
  private readonly tools = new Map<number, ToolAccumulator>();
  private content = '';
  private reasoning = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private finishReason = 'end_turn';

  push(value: unknown): ModelStreamEvent[] {
    const root = record(value);
    const type = stringAt(root, 'type');
    const events: ModelStreamEvent[] = [];
    if (type === 'message_start') {
      const usage = record(record(root?.message)?.usage);
      this.inputTokens = numberAt(usage, 'input_tokens') ?? this.inputTokens;
    } else if (type === 'content_block_start') {
      const index = numberAt(root, 'index') ?? 0;
      const block = record(root?.content_block);
      if (stringAt(block, 'type') === 'tool_use') {
        this.tools.set(index, {
          id: stringAt(block, 'id') ?? '',
          name: stringAt(block, 'name') ?? '',
          argumentsText: safeJson(block?.input),
        });
      }
    } else if (type === 'content_block_delta') {
      const index = numberAt(root, 'index') ?? 0;
      const delta = record(root?.delta);
      const deltaType = stringAt(delta, 'type');
      if (deltaType === 'text_delta') {
        const text = stringAt(delta, 'text') ?? '';
        this.content += text;
        if (text) events.push({ type: 'text_delta', delta: text });
      } else if (deltaType === 'thinking_delta') {
        const thinking = stringAt(delta, 'thinking') ?? '';
        this.reasoning += thinking;
        if (thinking) events.push({ type: 'reasoning_delta', delta: thinking });
      } else if (deltaType === 'input_json_delta') {
        const argumentsDelta = stringAt(delta, 'partial_json') ?? '';
        const current = this.tools.get(index) ?? { id: '', name: '', argumentsText: '' };
        if (current.argumentsText === '{}') current.argumentsText = '';
        current.argumentsText += argumentsDelta;
        this.tools.set(index, current);
        events.push({ type: 'tool_call_delta', index, argumentsDelta });
      }
    } else if (type === 'message_delta') {
      this.finishReason = stringAt(record(root?.delta), 'stop_reason') ?? this.finishReason;
      const usage = record(root?.usage);
      this.outputTokens = numberAt(usage, 'output_tokens') ?? this.outputTokens;
    }
    return events;
  }

  complete(): ModelStreamEvent {
    return {
      type: 'completed',
      response: buildResponse(
        this.content,
        this.reasoning,
        this.tools,
        this.inputTokens,
        this.outputTokens,
        this.finishReason,
      ),
    };
  }
}

function buildResponse(
  content: string,
  reasoning: string,
  tools: Map<number, ToolAccumulator>,
  inputTokens: number,
  outputTokens: number,
  finishReason: string,
): ModelResponse {
  const toolCalls: ModelToolCall[] = [...tools.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, tool]) => ({
      id: tool.id || `tool-call-${index}`,
      name: tool.name,
      arguments: parseJson(tool.argumentsText),
    }));
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    usage: { inputTokens, outputTokens },
    stopReason:
      toolCalls.length > 0 || finishReason === 'tool_calls' || finishReason === 'tool_use'
        ? 'tool_calls'
        : finishReason === 'length' || finishReason === 'max_tokens'
          ? 'length'
          : 'complete',
  };
}

interface ThinkSegment {
  kind: 'content' | 'reasoning';
  text: string;
}

/** 兼容把思考内容放在正文 `<think>` 标签中的 OpenAI-compatible 服务。 */
class ThinkTagStreamParser {
  private buffer = '';
  private inThink = false;

  push(delta: string): ThinkSegment[] {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): ThinkSegment[] {
    return this.drain(true);
  }

  private drain(flush: boolean): ThinkSegment[] {
    const output: ThinkSegment[] = [];
    while (this.buffer) {
      const marker = this.inThink ? '</think>' : '<think>';
      const markerIndex = this.buffer.toLocaleLowerCase().indexOf(marker);
      if (markerIndex >= 0) {
        this.emit(output, this.buffer.slice(0, markerIndex));
        this.buffer = this.buffer.slice(markerIndex + marker.length);
        this.inThink = !this.inThink;
        continue;
      }
      const retained = flush ? 0 : suffixPrefixLength(this.buffer.toLocaleLowerCase(), marker);
      const available = this.buffer.length - retained;
      this.emit(output, this.buffer.slice(0, available));
      this.buffer = this.buffer.slice(available);
      break;
    }
    return output;
  }

  private emit(output: ThinkSegment[], text: string): void {
    if (text) output.push({ kind: this.inThink ? 'reasoning' : 'content', text });
  }
}

function suffixPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === 'string' ? found : undefined;
}

function numberAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const found = value?.[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

function arrayAt(value: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const found = value?.[key];
  return Array.isArray(found) ? found : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value || '{}') as unknown;
  } catch {
    return { raw: value };
  }
}
