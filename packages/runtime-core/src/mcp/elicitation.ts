import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolExecutionContext } from '../tools';

/** 连接在 runExclusive 内只关联一个实际调用；服务正文不产生授权。 */
export class ElicitationBridge {
  private readonly active = new WeakMap<
    Client,
    { context: ToolExecutionContext; count: number; waiting: boolean }
  >();

  attach(client: Client, serverName: string): void {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const state = this.active.get(client);
      if (
        !state?.context.requestConfirmation ||
        state.context.signal.aborted ||
        extra.signal.aborted
      ) {
        throw new Error('MCP_ELICITATION_OUTSIDE_CALL');
      }
      if (state.waiting || ++state.count > 4) throw new Error('MCP_ELICITATION_LIMIT');
      const params = request.params;
      if (params.mode === 'url') throw new Error('MCP_ELICITATION_UNSUPPORTED_FORM');
      const fields = Object.entries(params.requestedSchema.properties);
      const field = fields[0];
      if (fields.length !== 1 || !field || field[1].type !== 'boolean') {
        throw new Error('MCP_ELICITATION_UNSUPPORTED_FORM');
      }
      const description = field[1].description ?? field[1].title ?? field[0];
      const prompt = `服务 ${serverName} 请求确认（本次工具调用）：\n${params.message}\n\n确认项：${description}`;
      if (Buffer.byteLength(prompt, 'utf8') > 36 * 1024)
        throw new Error('MCP_ELICITATION_TOO_LARGE');
      state.waiting = true;
      try {
        const signal = AbortSignal.any([state.context.signal, extra.signal]);
        const action = await state.context.requestConfirmation({
          toolCallId: state.context.toolCallId,
          prompt,
          signal,
        });
        if (signal.aborted) return { action: 'cancel' };
        if (action === 'accept') return { action, content: { [field[0]]: true } };
        return { action: action === 'decline' ? 'decline' : 'cancel' };
      } finally {
        state.waiting = false;
      }
    });
  }

  async run<T>(client: Client, context: ToolExecutionContext, work: () => Promise<T>): Promise<T> {
    if (this.active.has(client)) throw new Error('MCP_ELICITATION_CALL_CONFLICT');
    const lifetime = new AbortController();
    this.active.set(client, {
      context: { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) },
      count: 0,
      waiting: false,
    });
    try {
      return await work();
    } finally {
      lifetime.abort();
      this.active.delete(client);
    }
  }
}
