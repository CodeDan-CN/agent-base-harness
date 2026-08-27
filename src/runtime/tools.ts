import type { RuntimeToolDefinition } from './model';

export type ToolResultStatus =
  'success' | 'needs_input' | 'retryable_error' | 'fatal_error' | 'cancelled';

export interface InteractionRequest {
  prompt: string;
  kind: 'text' | 'confirm' | 'select' | 'approval' | 'selection' | 'form';
  options?: readonly string[];
  schema?: Record<string, unknown>;
}

export interface ToolResult {
  status: ToolResultStatus;
  output: unknown;
  errorCode?: string;
  interaction?: InteractionRequest;
}

export interface ToolExecutionContext {
  userId: string;
  sessionId: string;
  eventId: string;
  turnId: string;
  toolCallId: string;
  signal: AbortSignal;
}

export interface RuntimeTool {
  readonly definition: RuntimeToolDefinition;
  readonly concurrencySafe: boolean;
  readonly replaySafe?: boolean;
  readonly exclusive?: boolean;
  readonly timeoutMs?: number;
  isConcurrencySafe?(input: unknown): boolean;
  validateOutput?(output: unknown): boolean;
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
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

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  register(tool: RuntimeTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): RuntimeTool | undefined {
    return this.tools.get(name);
  }

  definitions(): RuntimeToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

export class ToolScheduler {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly parallelism = 4,
  ) {}

  async execute(
    calls: readonly ScheduledToolCall[],
    context: Omit<ToolExecutionContext, 'toolCallId'>,
  ): Promise<ScheduledToolResult[]> {
    const output: ScheduledToolResult[] = new Array(calls.length);

    // 只有显式声明 concurrencySafe 且非 exclusive 的连续调用才并发；其余调用形成屏障。
    let start = 0;
    while (start < calls.length) {
      const first = calls[start];
      const tool = first ? this.registry.get(first.name) : undefined;
      if (!first) break;
      if (!tool || !isSafe(tool, first.arguments) || tool.exclusive) {
        const result = await this.executeOne(first, context);
        output[start] = result;
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end < calls.length) {
        const next = calls[end];
        const nextTool = next ? this.registry.get(next.name) : undefined;
        if (!nextTool || !isSafe(nextTool, next?.arguments) || nextTool.exclusive) break;
        end += 1;
      }
      let groupCursor = start;
      const groupWorker = async (): Promise<void> => {
        while (groupCursor < end) {
          const index = groupCursor;
          groupCursor += 1;
          const call = calls[index];
          if (call) output[index] = await this.executeOne(call, context);
        }
      };
      const limit = Math.min(this.parallelism, end - start);
      await Promise.all(Array.from({ length: limit }, () => groupWorker()));
      start = end;
    }

    return output;
  }

  private async executeOne(
    call: ScheduledToolCall,
    context: Omit<ToolExecutionContext, 'toolCallId'>,
  ): Promise<ScheduledToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return { call, result: { status: 'fatal_error', output: null, errorCode: 'TOOL_NOT_FOUND' } };
    }
    if (context.signal.aborted) return { call, result: { status: 'cancelled', output: null } };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await executeWithTimeout(tool, call, context);
        if (!isJsonSerializable(result.output)) {
          return {
            call,
            result: { status: 'fatal_error', output: null, errorCode: 'INVALID_TOOL_OUTPUT' },
          };
        }
        if (
          result.status === 'success' &&
          tool.validateOutput &&
          !tool.validateOutput(result.output)
        ) {
          return {
            call,
            result: { status: 'fatal_error', output: null, errorCode: 'INVALID_TOOL_OUTPUT' },
          };
        }
        if (result.status !== 'retryable_error' || attempt === 2) return { call, result };
      } catch {
        return {
          call,
          result: { status: 'fatal_error', output: null, errorCode: 'TOOL_EXECUTION_FAILED' },
        };
      }
    }
    return {
      call,
      result: { status: 'fatal_error', output: null, errorCode: 'TOOL_RETRY_EXHAUSTED' },
    };
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
    const cancellation = new Promise<ToolResult>((resolve) => {
      if (controller.signal.aborted) {
        resolve({ status: context.signal.aborted ? 'cancelled' : 'fatal_error', output: null });
        return;
      }
      controller.signal.addEventListener(
        'abort',
        () =>
          resolve({
            status: context.signal.aborted ? 'cancelled' : 'fatal_error',
            output: null,
            errorCode: timedOut ? 'TOOL_TIMEOUT' : undefined,
          }),
        { once: true },
      );
    });
    return await Promise.race([
      tool.execute(call.arguments, {
        ...context,
        toolCallId: call.id,
        signal: controller.signal,
      }),
      cancellation,
    ]);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
  }
}

function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value ?? null);
    return true;
  } catch {
    return false;
  }
}
