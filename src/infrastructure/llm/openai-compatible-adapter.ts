import type { CredentialStore } from '../credential/credential-store';
import type {
  LlmAdapter,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  RuntimeMessage,
} from '../../runtime/model';
import { validateModelResponse } from '../../runtime/model';
import { OpenAiStreamNormalizer } from '../../runtime/provider-normalizers';
import { readAssistantPhase } from '../../client-contracts/assistant-output-policy';
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
    const response = await this.request(request, false, signal);
    const payload = (await response.json()) as unknown;
    return parseCompletion(payload);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const response = await this.request(request, true, signal);
    if (!response.body) throw providerError('MODEL_PROVIDER_INVALID_RESPONSE');

    const normalizer = new OpenAiStreamNormalizer();
    let receivedData = false;
    for await (const data of parseSseData(response.body)) {
      if (data === '[DONE]') break;
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        throw providerError('MODEL_PROVIDER_INVALID_RESPONSE');
      }
      receivedData = true;
      for (const event of normalizer.push(payload)) yield event;
    }
    if (!receivedData) throw providerError('MODEL_STREAM_INCOMPLETE');
    yield normalizer.complete();
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

async function* parseSseData(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
    const data = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) yield data;
  } finally {
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
