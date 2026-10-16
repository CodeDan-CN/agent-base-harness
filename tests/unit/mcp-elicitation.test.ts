import { describe, expect, it, vi } from 'vitest';
import { ElicitationBridge } from '../../packages/runtime-core/src/mcp/elicitation';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolExecutionContext } from '../../packages/runtime-core/src/tools';

const params = {
  message: 'TEST_ONLY draft',
  requestedSchema: {
    type: 'object',
    properties: { approved: { type: 'boolean', default: true } },
  },
};
function fixture() {
  let handle: (request: unknown, extra: { signal: AbortSignal }) => Promise<unknown>;
  const client = {
    setRequestHandler: (_schema: unknown, callback: typeof handle) => {
      handle = callback;
    },
  } as unknown as Client;
  const bridge = new ElicitationBridge();
  bridge.attach(client, 'TEST_ONLY');
  const controller = new AbortController();
  const context = {
    toolCallId: 'call-1',
    signal: controller.signal,
    requestConfirmation: vi.fn(async () => 'accept' as const),
  } as unknown as ToolExecutionContext;
  return {
    bridge,
    client,
    context,
    controller,
    invoke: (p = params) => handle({ params: p }, { signal: controller.signal }),
  };
}
describe('MCP confirmation bridge', () => {
  it('limits repeated forms and rejects overlapping calls', async () => {
    const f = fixture();
    await f.bridge.run(f.client, f.context, async () => {
      await expect(f.bridge.run(f.client, f.context, async () => null)).rejects.toThrow(
        'MCP_ELICITATION_CALL_CONFLICT',
      );
      for (let i = 0; i < 4; i++) await f.invoke();
      await expect(f.invoke()).rejects.toThrow('MCP_ELICITATION_LIMIT');
    });
    expect(f.context.requestConfirmation).toHaveBeenCalledTimes(4);
  });
  it('aborts a waiting form when the parent call finishes', async () => {
    const f = fixture();
    let request: Promise<unknown> | undefined;
    f.context.requestConfirmation = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('cancel'), { once: true });
      });
    await f.bridge.run(f.client, f.context, async () => {
      request = f.invoke();
    });
    expect(await request).toEqual({ action: 'cancel' });
  });
  it('requires explicit host response, preserving exact field without applying defaults', async () => {
    const f = fixture();
    expect(await f.bridge.run(f.client, f.context, () => f.invoke())).toEqual({
      action: 'accept',
      content: { approved: true },
    });
    expect(f.context.requestConfirmation).toHaveBeenCalledOnce();
    expect(f.context.requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call-1',
        prompt: expect.stringContaining('TEST_ONLY'),
      }),
    );
    await expect(f.invoke()).rejects.toThrow('MCP_ELICITATION_OUTSIDE_CALL');
  });
  it.each(['decline', 'cancel'] as const)('returns %s without content', async (decision) => {
    const f = fixture();
    f.context.requestConfirmation = async () => decision;
    expect(await f.bridge.run(f.client, f.context, () => f.invoke())).toEqual({ action: decision });
  });
  it('fails closed without host callback or for unknown fields', async () => {
    const f = fixture();
    delete f.context.requestConfirmation;
    await expect(f.bridge.run(f.client, f.context, () => f.invoke())).rejects.toThrow(
      'MCP_ELICITATION_OUTSIDE_CALL',
    );
    const g = fixture();
    await expect(
      g.bridge.run(g.client, g.context, () =>
        g.invoke({
          ...params,
          requestedSchema: {
            type: 'object',
            properties: { approved: { type: 'string', default: true } },
          },
        }),
      ),
    ).rejects.toThrow('MCP_ELICITATION_UNSUPPORTED_FORM');
    expect(g.context.requestConfirmation).not.toHaveBeenCalled();
  });
  it('rejects oversize and cancelled calls, and cleans up after failure', async () => {
    const f = fixture();
    await expect(
      f.bridge.run(f.client, f.context, () => f.invoke({ ...params, message: 'x'.repeat(40000) })),
    ).rejects.toThrow('MCP_ELICITATION_TOO_LARGE');
    f.controller.abort();
    await expect(f.bridge.run(f.client, f.context, () => f.invoke())).rejects.toThrow();
    expect(f.context.requestConfirmation).not.toHaveBeenCalled();
  });
});
