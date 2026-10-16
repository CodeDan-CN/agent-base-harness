import type { CredentialStore } from '../credential/credential-store';
import type {
  LlmAdapter,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  RuntimeMessage,
} from '../../../runtime-core/src/model';
import { validateModelResponse } from '../../../runtime-core/src/model';
import { OpenAiStreamNormalizer } from '../../../runtime-core/src/provider-normalizers';
import { readAssistantPhase } from '../../../protocol/src/client/assistant-output-policy';
import type { Logger } from '../logging/logger';

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleAdapterOptions {
  credentialStore: CredentialStore;
  fetch?: FetchFn;
  providerType?: string;
  onCredentialLoaded?: (secret: string) => void;
  logger?: Pick<Logger, 'warn'>;
}

/** OpenAI Chat Completions 兼容 Provider。明文凭据仅在发送边界短暂读取。 */
export class OpenAiCompatibleAdapter implements LlmAdapter {
  readonly providerType: string;
  private readonly credentialStore: CredentialStore;
  private readonly fetch: FetchFn;
  private readonly onCredentialLoaded?: (secret: string) => void;
  private readonly logger?: Pick<Logger, 'warn'>;

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.providerType = options.providerType ?? 'openai-compatible';
    this.credentialStore = options.credentialStore;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onCredentialLoaded = options.onCredentialLoaded;
    this.logger = options.logger;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const startedAt = Date.now();
    const response = await this.request(request, false, signal);
    const payload = (await response.json()) as unknown;
    const diagnostics = new ResponseDiagnostics();
    diagnostics.observePayload(payload);
    if (isProviderErrorPayload(payload)) {
      this.warnResponseAnomaly(request, false, startedAt, diagnostics, 'provider_error');
      throw providerError('MODEL_PROVIDER_REQUEST_FAILED');
    }
    const completion = parseCompletion(payload);
    diagnostics.observeCompletion(completion);
    if (isContentFilteredPayload(payload)) {
      this.warnResponseAnomaly(request, false, startedAt, diagnostics, 'content_filtered');
      throw providerError('MODEL_CONTENT_FILTERED');
    }
    if (!completion.content.trim() && completion.toolCalls.length === 0) {
      this.warnResponseAnomaly(request, false, startedAt, diagnostics, 'empty_response');
    }
    return completion;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const startedAt = Date.now();
    const response = await this.request(request, true, signal);
    const normalizer = new OpenAiStreamNormalizer();
    const diagnostics = new ResponseDiagnostics();
    try {
      if (!response.body) throw providerError('MODEL_STREAM_INCOMPLETE');
      for await (const frame of parseSseData(response.body)) {
        if (signal.aborted) throw providerError('MODEL_REQUEST_ABORTED');
        if (frame.event === 'error') {
          throw providerError('MODEL_PROVIDER_REQUEST_FAILED');
        }
        if (frame.data === '[DONE]') {
          diagnostics.sawDone = true;
          break;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(frame.data) as unknown;
        } catch {
          throw providerError(
            diagnostics.sawFinish ? 'MODEL_PROVIDER_INVALID_RESPONSE' : 'MODEL_STREAM_INCOMPLETE',
          );
        }
        diagnostics.observePayload(payload);
        if (isProviderErrorPayload(payload)) {
          throw providerError('MODEL_PROVIDER_REQUEST_FAILED');
        }
        const events = normalizer.push(payload);
        for (const event of events) diagnostics.observeEvent(event);
        if (isContentFilteredPayload(payload)) {
          throw providerError('MODEL_CONTENT_FILTERED');
        }
        for (const event of events) {
          yield event;
        }
      }
      if (signal.aborted) throw providerError('MODEL_REQUEST_ABORTED');
      // 兼容只发送 finish_reason 或 [DONE] 的服务；裸 EOF 不能提交工具调用。
      if (!diagnostics.sawFinish && !diagnostics.sawDone) {
        throw providerError('MODEL_STREAM_INCOMPLETE');
      }
    } catch (error) {
      const code = signal.aborted
        ? 'MODEL_REQUEST_ABORTED'
        : error instanceof Error && error.name === 'MODEL_PROVIDER_REQUEST_FAILED'
          ? 'MODEL_PROVIDER_REQUEST_FAILED'
          : error instanceof Error && error.name === 'MODEL_CONTENT_FILTERED'
            ? 'MODEL_CONTENT_FILTERED'
            : error instanceof Error && error.name === 'MODEL_PROVIDER_INVALID_RESPONSE'
              ? 'MODEL_PROVIDER_INVALID_RESPONSE'
              : 'MODEL_STREAM_INCOMPLETE';
      this.warnResponseAnomaly(
        request,
        true,
        startedAt,
        diagnostics,
        code === 'MODEL_REQUEST_ABORTED'
          ? 'aborted'
          : code === 'MODEL_PROVIDER_REQUEST_FAILED'
            ? 'provider_error'
            : code === 'MODEL_CONTENT_FILTERED'
              ? 'content_filtered'
              : code === 'MODEL_PROVIDER_INVALID_RESPONSE'
                ? 'invalid_response'
                : 'stream_incomplete',
      );
      // 不传播 transport / provider 原始错误正文，以免上层日志泄漏请求内容。
      throw providerError(code);
    }
    const completed = normalizer.complete();
    if (completed.type === 'completed') {
      diagnostics.observeCompletion(completed.response);
      if (!completed.response.content.trim() && completed.response.toolCalls.length === 0) {
        this.warnResponseAnomaly(request, true, startedAt, diagnostics, 'empty_response');
      }
    }
    yield completed;
  }

  private warnResponseAnomaly(
    request: ModelRequest,
    stream: boolean,
    startedAt: number,
    diagnostics: ResponseDiagnostics,
    reason: string,
  ): void {
    try {
      this.logger?.warn('模型响应异常', {
        event: 'model_response_anomaly',
        reason,
        requestId: boundedMetadata(request.requestId),
        model: boundedMetadata(request.model.remoteModelId),
        providerType: boundedMetadata(request.model.providerType),
        purpose: request.purpose,
        stream,
        durationMs: Date.now() - startedAt,
        ...diagnostics.fields(),
      });
    } catch {
      // 诊断写入失败不改变模型结果与 Runtime 的恢复决策。
    }
  }

  private async request(
    request: ModelRequest,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    const credential = await this.resolveCredential(request.model.credentialRef);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credential) headers.authorization = `Bearer ${credential}`;
    const requestBody = JSON.stringify(buildRequestBody(request, stream));
    const requestStartedAt = Date.now();

    let response: Response;
    try {
      response = await this.fetch(completionUrl(request.model.endpoint), {
        method: 'POST',
        headers,
        body: requestBody,
        signal,
        redirect: 'error',
      });
    } catch (error) {
      this.logger?.warn('模型服务网络请求失败', {
        requestId: request.requestId,
        model: request.model.remoteModelId,
        providerType: request.model.providerType,
        endpoint: completionUrl(request.model.endpoint),
        durationMs: Date.now() - requestStartedAt,
        requestBodyBytes: new TextEncoder().encode(requestBody).byteLength,
        messageCount: request.messages.length,
        toolCount: request.tools.length,
        maxOutputTokens: request.maxOutputTokens,
        stream,
        cause: error instanceof Error ? error.message : String(error),
      });
      if (signal.aborted) throw providerError('MODEL_REQUEST_ABORTED', error);
      throw providerError('MODEL_PROVIDER_UNAVAILABLE', error);
    }
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      this.logger?.warn('模型服务拒绝请求', {
        requestId: request.requestId,
        model: request.model.remoteModelId,
        providerType: request.model.providerType,
        endpoint: completionUrl(request.model.endpoint),
        httpStatus: response.status,
        httpStatusText: response.statusText,
        durationMs: Date.now() - requestStartedAt,
        requestBodyBytes: new TextEncoder().encode(requestBody).byteLength,
        messageCount: request.messages.length,
        messageRoles: request.messages.map((message) => message.role),
        assistantToolCallMessages: request.messages.filter(
          (message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
        ).length,
        toolResultMessages: request.messages.filter((message) => message.role === 'tool').length,
        reasoningHistoryMessages: request.messages.filter((message) =>
          Boolean(message.reasoningContent),
        ).length,
        toolCount: request.tools.length,
        toolSchemaBytes: new TextEncoder().encode(JSON.stringify(request.tools)).byteLength,
        maxOutputTokens: request.maxOutputTokens,
        stream,
        errorBodyPreview: boundedProviderErrorBody(errorBody),
      });
      if (response.status === 401 || response.status === 403) {
        throw providerError('MODEL_AUTHENTICATION_FAILED');
      }
      if (response.status === 408 || response.status === 429) {
        throw providerError('MODEL_RATE_LIMITED');
      }
      if (
        response.status === 400 &&
        /context(?:\s+window|\s+length)?|maximum context|too many tokens|token limit/i.test(
          errorBody,
        )
      ) {
        throw providerError('MODEL_CONTEXT_WINDOW_EXCEEDED');
      }
      throw providerError('MODEL_PROVIDER_REQUEST_FAILED');
    }
    return response;
  }

  private async resolveCredential(ref: string | null): Promise<string | null> {
    if (!ref) return null;
    const credential = await this.credentialStore.getByRef(ref);
    if (!credential) throw providerError('MODEL_CREDENTIAL_MISSING');
    this.onCredentialLoaded?.(credential);
    return credential;
  }
}

function boundedProviderErrorBody(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 2_000) : '[空响应正文]';
}

function buildRequestBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...request.model.params,
    model: request.model.remoteModelId,
    messages: request.messages.map(toOpenAiMessage),
    max_tokens: request.maxOutputTokens,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  return body;
}

function toOpenAiMessage(message: RuntimeMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    if (!message.toolCallId) throw providerError('MODEL_CONTEXT_INVALID');
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function parseCompletion(value: unknown): ModelResponse {
  const root = record(value);
  const choice = arrayAt(root, 'choices')?.[0];
  const choiceRecord = record(choice);
  const message = record(choiceRecord?.message);
  if (!choiceRecord || !message) throw providerError('MODEL_PROVIDER_INVALID_RESPONSE');
  const rawContent = stringAt(message, 'content') ?? '';
  const phase = readAssistantPhase(message.phase);
  const explicitReasoning =
    stringAt(message, 'reasoning_content') ?? stringAt(message, 'reasoning') ?? '';
  const split = splitThinkContent(rawContent);
  const content = split.content;
  const reasoning = [explicitReasoning, split.reasoning].filter(Boolean).join('\n');
  const toolCalls = (arrayAt(message, 'tool_calls') ?? []).map((raw, index) => {
    const call = record(raw);
    const fn = record(call?.function);
    const name = stringAt(fn, 'name');
    if (!name) throw providerError('MODEL_PROVIDER_INVALID_RESPONSE');
    return {
      id: stringAt(call, 'id') ?? `tool-call-${index}`,
      name,
      arguments: parseArguments(stringAt(fn, 'arguments') ?? '{}'),
    };
  });
  const usage = record(root?.usage);
  return validateModelResponse({
    content,
    ...(phase ? { phase } : {}),
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    usage: {
      inputTokens: integerAt(usage, 'prompt_tokens') ?? 0,
      outputTokens: integerAt(usage, 'completion_tokens') ?? 0,
    },
    stopReason: normalizeFinishReason(stringAt(choiceRecord, 'finish_reason'), toolCalls.length),
  });
}

function splitThinkContent(content: string): { content: string; reasoning: string } {
  const reasoning: string[] = [];
  const visible = content.replace(/<think>([\s\S]*?)(?:<\/think>|$)/gi, (_match, value: string) => {
    reasoning.push(value);
    return '';
  });
  return { content: visible, reasoning: reasoning.join('\n') };
}

function completionUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (!normalizedPath.endsWith('/chat/completions')) {
    url.pathname = `${normalizedPath}/chat/completions`;
  }
  return url.toString();
}

/** 只累加诊断所需计数；不保留正文、推理、工具名称或参数副本。 */
class ResponseDiagnostics {
  sawDone = false;
  sawFinish = false;
  private rawFinishReason: string | null = null;
  private dataFrameCount = 0;
  private contentChars = 0;
  private contentNonWhitespaceChars = 0;
  private reasoningChars = 0;
  private readonly toolIndexes = new Set<number>();
  private toolCallCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private usageReported = false;

  observePayload(payload: unknown): void {
    this.dataFrameCount += 1;
    const root = record(payload);
    const choice = record(arrayAt(root, 'choices')?.[0]);
    const finishReason = stringAt(choice, 'finish_reason');
    if (finishReason?.trim()) {
      this.rawFinishReason = boundedMetadata(finishReason);
      this.sawFinish = true;
    }
    const usage = record(root?.usage);
    if (usage) {
      this.usageReported = true;
      this.inputTokens = integerAt(usage, 'prompt_tokens') ?? this.inputTokens;
      this.outputTokens = integerAt(usage, 'completion_tokens') ?? this.outputTokens;
    }
  }

  observeEvent(event: ModelStreamEvent): void {
    if (event.type === 'text_delta') {
      this.contentChars += event.delta.length;
      this.contentNonWhitespaceChars += event.delta.replace(/\s/g, '').length;
    } else if (event.type === 'reasoning_delta') {
      this.reasoningChars += event.delta.length;
    } else if (event.type === 'tool_call_delta') {
      this.toolIndexes.add(event.index);
      this.toolCallCount = this.toolIndexes.size;
    }
  }

  observeCompletion(response: ModelResponse): void {
    this.contentChars = response.content.length;
    this.contentNonWhitespaceChars = response.content.replace(/\s/g, '').length;
    this.reasoningChars = response.reasoning?.length ?? 0;
    this.toolCallCount = response.toolCalls.length;
    this.inputTokens = response.usage.inputTokens;
    this.outputTokens = response.usage.outputTokens;
  }

  fields(): Record<string, unknown> {
    return {
      rawFinishReason: this.rawFinishReason,
      sawFinish: this.sawFinish,
      sawDone: this.sawDone,
      dataFrameCount: this.dataFrameCount,
      contentChars: this.contentChars,
      contentNonWhitespaceChars: this.contentNonWhitespaceChars,
      reasoningChars: this.reasoningChars,
      toolCallCount: this.toolCallCount,
      usageReported: this.usageReported,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
    };
  }
}

function boundedMetadata(value: string): string {
  return value.replace(/\p{Cc}/gu, '').slice(0, 256);
}

function isProviderErrorPayload(value: unknown): boolean {
  const root = record(value);
  return root?.error != null || root?.type === 'error';
}

function isContentFilteredPayload(value: unknown): boolean {
  const choice = record(arrayAt(record(value), 'choices')?.[0]);
  return stringAt(choice, 'finish_reason') === 'content_filter';
}

interface SseFrame {
  data: string;
  event?: string;
}

function parseSseFrame(block: string): SseFrame | undefined {
  const lines = block.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.slice(6)
    .trim();
  return data || event === 'error' ? { data, event } : undefined;
}

async function* parseSseData(stream: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const frame = parseSseFrame(block);
        if (frame) yield frame;
      }
      if (done) break;
    }
    const frame = parseSseFrame(buffer);
    if (frame) yield frame;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function normalizeFinishReason(
  value: string | undefined,
  toolCount: number,
): ModelResponse['stopReason'] {
  if (toolCount > 0 || value === 'tool_calls') return 'tool_calls';
  return value === 'length' ? 'length' : 'complete';
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { raw: value };
  }
}

function providerError(code: string, cause?: unknown): Error {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.name = code;
  return error;
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

function integerAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const found = value?.[key];
  return typeof found === 'number' && Number.isInteger(found) && found >= 0 ? found : undefined;
}

function arrayAt(value: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const found = value?.[key];
  return Array.isArray(found) ? found : undefined;
}
