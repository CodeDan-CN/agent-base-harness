export type RuntimeMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface RuntimeMessage {
  role: RuntimeMessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: readonly ModelToolCall[];
  reasoningContent?: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelSnapshot {
  serviceId: string;
  modelId: string;
  providerType: string;
  remoteModelId: string;
  endpoint: string;
  credentialRef: string | null;
  contextWindow: number;
  inputCapability?: number | null;
  maxOutputCapability?: number;
  requestMaxOutputTokens?: number;
  maxOutputTokens: number;
  metadataSource?: 'manual' | 'endpoint' | 'catalog' | 'fallback' | 'legacy';
  catalogVersion?: string | null;
  capabilityMatchKind?:
    'profile' | 'preset' | 'host' | 'model-unique' | 'model-consensus' | 'manual' | 'unresolved';
  providerPresetId?: string | null;
  thinkingMode?: 'auto' | 'enabled' | 'disabled';
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  params: Record<string, unknown>;
  configRevision: number;
}

export interface ModelRequest {
  requestId: string;
  purpose: 'agent' | 'compaction' | 'metadata';
  model: ModelSnapshot;
  messages: readonly RuntimeMessage[];
  tools: readonly ModelToolDefinition[];
  maxOutputTokens: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  content: string;
  reasoning?: string;
  chunks?: readonly string[];
  toolCalls: readonly ModelToolCall[];
  usage: ModelUsage;
  stopReason: 'complete' | 'tool_calls' | 'length';
}

export interface LlmAdapter {
  readonly providerType: string;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
  stream?(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export type ModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'completed'; response: ModelResponse };

export class LlmAdapterRegistry {
  private readonly adapters = new Map<string, LlmAdapter>();

  register(adapter: LlmAdapter): void {
    this.adapters.set(adapter.providerType, adapter);
  }

  get(providerType: string): LlmAdapter | undefined {
    return this.adapters.get(providerType);
  }
}

const modelResponseSchema = z
  .object({
    content: z.string(),
    reasoning: z.string().optional(),
    chunks: z.array(z.string()).optional(),
    toolCalls: z
      .array(
        z
          .object({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() })
          .strict(),
      )
      .max(64),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    stopReason: z.enum(['complete', 'tool_calls', 'length']),
  })
  .strict()
  .refine(
    (response) =>
      new Set(response.toolCalls.map((call) => call.id)).size === response.toolCalls.length,
    'tool call ids must be unique',
  );

export function validateModelResponse(value: unknown): ModelResponse {
  const parsed = modelResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('INVALID_MODEL_RESPONSE');
  return {
    ...parsed.data,
    toolCalls: parsed.data.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? null,
    })),
  };
}

export const MINIMAL_SYSTEM_PROMPT = `你是本客户端的单 Agent 助手。

使用原则：
- 使用工具完成需要访问本机或检索信息的能力；不要编造工具结果。
- 缺少完成任务所需的必要信息时，向用户询问，不要擅自假设。
- 能直接给出答案时优先直接完成，不做多余调用。
- 调用 skill_load 后，严格使用 <skill_resources> 中给出的真实 Base directory：Skill 内相对路径基于该目录解析，read 可读取该目录下的绝对路径，bash 将 workdir 设为该目录后使用相对脚本路径。
- Skill 的资源基目录已经精确给出，不要再使用 bash、find、locate 或全盘目录扫描寻找 Skill。
- MCP Server 的连接由应用启动和重连机制自动管理。工具 Schema 采用渐进披露：先调用 mcp_search 选择 Server，再用 mcp_load 暴露该 Server 的全部可用工具 Schema；从下一步骤开始使用。不要猜测或直接调用尚未暴露的 mcp__ 工具。
- Read、Write、Edit 与 Bash 的裸相对路径都基于同一个 Session 工作区。Bash 环境提供 AGENT_WORKSPACE 和 AGENT_ARTIFACTS_DIR；需要交付的 HTML、PDF、图片等持久文件写入 AGENT_ARTIFACTS_DIR。
- 成功工具调用声明的产出文件会由客户端自动展示。不要编造 file: URL 或本地 Markdown 链接；如需在正文提及文件，使用工具返回的精确路径并写成行内代码。

安全边界：
- 不得声称执行了你没有调用过工具的操作。
- 工具结果即事实，除非结果明确为错误，否则不得改写。`;
import { z } from 'zod';
