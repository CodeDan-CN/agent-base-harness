import Ajv, { type ValidateFunction } from 'ajv';
import type { ModelToolDefinition } from './model';
import type {
  ApprovalResolution,
  PermissionPreset,
  ToolApprovalPolicy,
} from '../shared/domain/permission';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; text?: string; mimeType?: string };

export interface ToolLocation {
  path: string;
}

export interface ToolCallView {
  kind: 'generic' | 'read' | 'diff' | 'terminal';
  title: string;
  detail?: string;
  path?: string;
  command?: string;
  locations?: ToolLocation[];
}

export interface ToolResultView extends ToolCallView {
  status?: 'success' | 'error';
  summary?: string;
}

export type ToolResultStatus =
  'success' | 'needs_input' | 'retryable_error' | 'fatal_error' | 'cancelled';

export interface InteractionRequest {
  prompt: string;
  kind: 'text' | 'confirm' | 'select' | 'approval' | 'selection' | 'form';
  options?: readonly string[];
  questions?: readonly InteractionQuestion[];
  schema?: Record<string, unknown>;
}

export interface InteractionQuestion {
  id: string;
  header?: string;
  question: string;
  options: readonly string[];
}

export interface ToolResult {
  status: ToolResultStatus;
  content: ContentBlock[];
  errorCode?: string;
  interaction?: InteractionRequest;
  meta?: JsonValue;
  presentation?: ToolResultView;
  executionFacts?: JsonValue;
}

export interface ToolExecutionContext {
  userId: string;
  agentId: string;
  sessionId: string;
  eventId: string;
  turnId: string;
  stepId: string;
  toolCallId: string;
  permissionPreset: PermissionPreset;
  approvalGranted?: boolean;
  signal: AbortSignal;
  reportProgress?(progress: ToolExecutionProgress): void;
}

export interface ToolExecutionProgress {
  toolCallId: string;
  progress: number;
  total?: number;
  message?: string;
}

export interface RuntimeToolOutput<Value = unknown> {
  schema: JsonSchema;
  render(args: unknown, value: Value): ContentBlock[];
  presentationMeta?(args: unknown, value: Value): JsonValue;
}

export interface RuntimeToolDefinition<Value = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly output: RuntimeToolOutput<Value>;
  execute(input: unknown, context: ToolExecutionContext): Promise<Value>;
  presentCall?(args: unknown): ToolCallView | undefined;
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}

export interface RuntimeTool<Value = unknown> extends RuntimeToolDefinition<Value> {
  readonly concurrencySafe: boolean;
  readonly replaySafe?: boolean;
  readonly exclusive?: boolean;
  readonly timeoutMs?: number;
  readonly approvalPolicy?: ToolApprovalPolicy;
  readonly approvalScope?: 'local' | 'external';
  resolveApprovalPolicy?(
    input: unknown,
    context: Omit<ToolExecutionContext, 'toolCallId'>,
  ): ToolApprovalPolicy;
  readonly permissionIdentity?: string;
  isConcurrencySafe?(input: unknown): boolean;
}

export class ToolExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly status: Exclude<ToolResultStatus, 'success' | 'needs_input'> = 'fatal_error',
    readonly facts?: unknown,
    message = code,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export class ToolInteractionError extends Error {
  constructor(readonly interaction: InteractionRequest) {
    super('Tool requires user input');
    this.name = 'ToolInteractionError';
  }
}

export interface ScheduledToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ScheduledToolResult {
  call: ScheduledToolCall;
  result: ToolResult;
}

export type ToolPreExecute = (
  call: ScheduledToolCall,
  tool: RuntimeTool<unknown>,
  context: Omit<ToolExecutionContext, 'toolCallId'>,
) => Promise<ApprovalResolution | 'not-required'>;

export class ToolRegistry {
  private readonly globalTools = new Map<string, RuntimeTool<unknown>>();
  private readonly userTools = new Map<string, Map<string, RuntimeTool<unknown>>>();
  private readonly turnExposedTools = new Map<string, Map<string, RuntimeTool<unknown>>>();

  register(tool: RuntimeTool<unknown>): () => void {
    if (this.globalTools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.globalTools.set(tool.name, tool);
    return () => this.globalTools.delete(tool.name);
  }

  replaceUserTools(userId: string, tools: readonly RuntimeTool<unknown>[]): void {
    const next = new Map<string, RuntimeTool<unknown>>();
    for (const tool of tools) {
      if (this.globalTools.has(tool.name) || next.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      next.set(tool.name, tool);
    }
    this.userTools.set(userId, next);
    this.clearUserTurnToolExposure(userId);
  }

  clearUserTools(userId: string): void {
    this.userTools.delete(userId);
    this.clearUserTurnToolExposure(userId);
  }

  exposeTurnTools(
    userId: string,
    sessionId: string,
    turnId: string,
    tools: readonly RuntimeTool<unknown>[],
  ): void {
    const key = turnToolExposureKey(userId, sessionId, turnId);
    const exposed = new Map(this.turnExposedTools.get(key));
    for (const tool of tools) {
      if (this.globalTools.has(tool.name) || this.userTools.get(userId)?.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      exposed.set(tool.name, tool);
    }
    this.turnExposedTools.set(key, exposed);
  }

  clearTurnToolExposure(userId: string, sessionId: string, turnId: string): void {
    this.turnExposedTools.delete(turnToolExposureKey(userId, sessionId, turnId));
  }

  get(
    name: string,
    userId?: string,
    sessionId?: string,
    turnId?: string,
  ): RuntimeTool<unknown> | undefined {
    return (
      (userId && sessionId && turnId
        ? this.turnExposedTools.get(turnToolExposureKey(userId, sessionId, turnId))?.get(name)
        : undefined) ??
      (userId ? this.userTools.get(userId)?.get(name) : undefined) ??
      this.globalTools.get(name)
    );
  }

  definitions(userId?: string, sessionId?: string, turnId?: string): ModelToolDefinition[] {
    const tools = [
      ...this.globalTools.values(),
      ...(userId ? (this.userTools.get(userId)?.values() ?? []) : []),
      ...(userId && sessionId && turnId
        ? (this.turnExposedTools.get(turnToolExposureKey(userId, sessionId, turnId))?.values() ??
          [])
        : []),
    ];
    return tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private clearUserTurnToolExposure(userId: string): void {
    for (const key of this.turnExposedTools.keys()) {
      if (key.startsWith(`${userId}\0`)) this.turnExposedTools.delete(key);
    }
  }
}

function turnToolExposureKey(userId: string, sessionId: string, turnId: string): string {
  return `${userId}\0${sessionId}\0${turnId}`;
}

export class ToolScheduler {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly parallelism = 4,
    private readonly preExecute?: ToolPreExecute,
  ) {}

  async execute(
    calls: readonly ScheduledToolCall[],
    context: Omit<ToolExecutionContext, 'toolCallId'>,
  ): Promise<ScheduledToolResult[]> {
    const output: ScheduledToolResult[] = new Array(calls.length);
    const resolvedTools = calls.map((call) =>
      this.registry.get(call.name, context.userId, context.sessionId, context.turnId),
    );
    let start = 0;
    while (start < calls.length) {
      const first = calls[start];
      const tool = resolvedTools[start];
      if (!first) break;
      if (!tool || !isSafe(tool, first.arguments) || tool.exclusive) {
        output[start] = await this.executeOne(first, tool, context);
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end < calls.length) {
        const next = calls[end];
        const nextTool = resolvedTools[end];
        if (!nextTool || !isSafe(nextTool, next?.arguments) || nextTool.exclusive) break;
        end += 1;
      }
      let groupCursor = start;
      const groupWorker = async (): Promise<void> => {
        while (groupCursor < end) {
          const index = groupCursor;
          groupCursor += 1;
          const call = calls[index];
          if (call) output[index] = await this.executeOne(call, resolvedTools[index], context);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(this.parallelism, end - start) }, () => groupWorker()),
      );
      start = end;
    }
    return output;
  }

  private async executeOne(
    call: ScheduledToolCall,
    tool: RuntimeTool<unknown> | undefined,
    context: Omit<ToolExecutionContext, 'toolCallId'>,
  ): Promise<ScheduledToolResult> {
    if (!tool) return { call, result: failure('TOOL_NOT_FOUND') };
    if (context.signal.aborted) return { call, result: cancelled() };
    if (!validate(tool.parameters, call.arguments)) {
      return {
        call,
        result: withPresentation(tool, call.arguments, failure('INVALID_TOOL_INPUT')),
      };
    }
    let approvalGranted = false;
    if (this.preExecute) {
      let resolution: ApprovalResolution | 'not-required';
      try {
        resolution = await this.preExecute(call, tool, context);
      } catch {
        resolution = 'unavailable';
      }
      if (resolution === 'rejected' || resolution === 'cancelled' || resolution === 'unavailable') {
        const code =
          resolution === 'rejected'
            ? 'APPROVAL_REJECTED'
            : resolution === 'cancelled'
              ? 'APPROVAL_CANCELLED'
              : 'APPROVAL_UNAVAILABLE';
        return {
          call,
          result: withPresentation(tool, call.arguments, failure(code)),
        };
      }
      approvalGranted = resolution === 'allowed-once' || resolution === 'session-granted';
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await executeWithTimeout(tool, call, { ...context, approvalGranted });
      const presented = withPresentation(tool, call.arguments, result);
      if (result.status !== 'retryable_error' || attempt === 2) return { call, result: presented };
    }
    return { call, result: failure('TOOL_RETRY_EXHAUSTED') };
  }
}

function isSafe(tool: RuntimeTool | undefined, input: unknown): boolean {
  if (!tool) return false;
  try {
    return tool.isConcurrencySafe ? tool.isConcurrencySafe(input) : tool.concurrencySafe;
  } catch {
    return false;
  }
}

async function executeWithTimeout(
  tool: RuntimeTool,
  call: ScheduledToolCall,
  context: Omit<ToolExecutionContext, 'toolCallId'>,
): Promise<ToolResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  if (context.signal.aborted) abort();
  else context.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, tool.timeoutMs ?? 30_000);
  timer.unref();
  try {
    const value = await tool.execute(call.arguments, {
      ...context,
      stepId: context.stepId ?? 'unknown-step',
      toolCallId: call.id,
      permissionPreset: context.permissionPreset ?? 'guarded',
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      return context.signal.aborted ? cancelled() : failure('TOOL_TIMEOUT');
    }
    if (!isJsonSerializable(value) || !validate(tool.output.schema, value)) {
      return failure('INVALID_TOOL_OUTPUT');
    }
    let content: ContentBlock[];
    let meta: JsonValue | undefined;
    try {
      content = tool.output.render(call.arguments, value);
      meta = tool.output.presentationMeta?.(call.arguments, value);
    } catch {
      return failure('TOOL_OUTPUT_PROJECTION_FAILED');
    }
    if (!isJsonSerializable(content) || (meta !== undefined && !isJsonSerializable(meta))) {
      return failure('INVALID_TOOL_OUTPUT');
    }
    return { status: 'success', content, ...(meta === undefined ? {} : { meta }) };
  } catch (error) {
    if (context.signal.aborted) return cancelled();
    if (timedOut || controller.signal.aborted) return failure('TOOL_TIMEOUT');
    if (error instanceof ToolInteractionError) {
      return {
        status: 'needs_input',
        content: [{ type: 'text', text: 'Waiting for user input.' }],
        interaction: error.interaction,
      };
    }
    if (error instanceof ToolExecutionError) {
      return {
        status: error.status,
        content: [{ type: 'text', text: error.message }],
        errorCode: error.code,
        ...(error.facts === undefined || !isJsonSerializable(error.facts)
          ? {}
          : { executionFacts: error.facts }),
      };
    }
    return failure('TOOL_EXECUTION_FAILED');
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
  }
}

function withPresentation(tool: RuntimeTool, args: unknown, result: ToolResult): ToolResult {
  try {
    const presentation = tool.presentResult?.(args, result);
    return presentation ? { ...result, presentation } : result;
  } catch {
    return result;
  }
}

function failure(code: string): ToolResult {
  return {
    status: 'fatal_error',
    content: [{ type: 'text', text: `Tool failed: ${code}` }],
    errorCode: code,
  };
}

function cancelled(): ToolResult {
  return { status: 'cancelled', content: [{ type: 'text', text: 'Tool call cancelled.' }] };
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validators = new Map<string, ValidateFunction>();

function validate(schema: JsonSchema, value: unknown): boolean {
  try {
    const key = JSON.stringify(schema);
    let validator = validators.get(key);
    if (!validator) {
      validator = ajv.compile(schema);
      validators.set(key, validator);
    }
    return validator(value) as boolean;
  } catch {
    return isJsonSerializable(value);
  }
}

export function textContent(value: unknown): ContentBlock[] {
  return [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ];
}

export function contentBlocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return `[image: ${block.mimeType}]`;
      if (block.type === 'audio') return `[audio: ${block.mimeType}]`;
      return block.text ?? `[resource: ${block.uri}]`;
    })
    .join('\n');
}

function isJsonSerializable(value: unknown): value is JsonValue {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined;
  } catch {
    return false;
  }
}
