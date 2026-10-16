import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { credentialRefOf } from '../../packages/execution/src/credential/credential-store';
import { OpenAiCompatibleAdapter } from '../../packages/execution/src/llm/openai-compatible-adapter';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import {
  LlmAdapterRegistry,
  type LlmAdapter,
  type ModelStreamEvent,
} from '../../packages/runtime-core/src/model';
import { ToolRegistry } from '../../packages/runtime-core/src/tools';
import { createWorkerApplication, type WorkerApplication } from '../../packages/server-core/src/application/application';

const apiKey = process.env.LIVE_MODEL_API_KEY;
const endpoint = process.env.LIVE_MODEL_ENDPOINT;
const remoteModelId = process.env.LIVE_MODEL_ID;
const liveEnabled = Boolean(apiKey && endpoint && remoteModelId);

describe.runIf(liveEnabled)('真实 OpenAI-compatible Runtime', () => {
  let root = '';
  let app: WorkerApplication;
  let lastModelEvents: ModelStreamEvent[] = [];

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-live-'));
    const credentialStore = new FakeCredentialStore();
    const scope = { userId: 'user-a', purpose: 'model-service', entityId: 'live-service' };
    await credentialStore.set(scope, apiKey!);
    const adapters = new LlmAdapterRegistry();
    const providerAdapter = new OpenAiCompatibleAdapter({ credentialStore });
    const recordingAdapter: LlmAdapter = {
      providerType: providerAdapter.providerType,
      generate: (request, signal) => providerAdapter.generate(request, signal),
      async *stream(request, signal) {
        lastModelEvents = [];
        for await (const event of providerAdapter.stream(request, signal)) {
          lastModelEvents.push(event);
          yield event;
        }
      },
    };
    adapters.register(recordingAdapter);
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: 'live_echo',
        description: '原样返回输入文本。用户要求验证工具调用时必须使用此工具。',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      concurrencySafe: true,
      replaySafe: true,
      async execute(input) {
        return { status: 'success', output: input };
      },
    });
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      credentialStore,
      llmAdapters: adapters,
      tools,
    });
    const now = new Date().toISOString();
    app.repos.models.createService({
      id: 'live-service',
      userId: 'user-a',
      name: 'Live OpenAI-compatible',
      providerType: 'openai-compatible',
      endpoint: endpoint!,
      credentialRef: credentialRefOf(scope),
      config: { temperature: 0 },
      now,
    });
    app.repos.models.createModel({
      id: 'live-model',
      userId: 'user-a',
      serviceId: 'live-service',
      remoteModelId: remoteModelId!,
      displayName: remoteModelId!,
      contextWindow: 1_000_000,
      maxOutputTokens: 1024,
      capabilities: { tools: true, streaming: true },
      defaultParams: {},
      source: 'manual',
      now,
    });
    app.repos.models.setDefaultModel('user-a', 'live-model', now);
  });

  afterAll(async () => {
    await app?.runtime.shutdown();
    app?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('完成真实流式文本调用并记录 Provider usage', async () => {
    app.runtime.createSession('user-a', { sessionId: 'live-text', title: 'Live text' });
    app.runtime.submitInput('user-a', {
      sessionId: 'live-text',
      content: '不要调用工具，只回复精确文本：LIVE_OK',
      idempotencyKey: 'live-text-1',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle();
    const snapshot = app.runtime.snapshot('user-a', 'live-text') as LiveSnapshot;
    expect(snapshot.turns[0]).toMatchObject({ status: 'completed' });
    expect(snapshot.messages.at(-1)?.content).toContain('LIVE_OK');
    expect(snapshot.usage.inputTokens).toBeGreaterThan(0);
    expect(snapshot.usage.outputTokens).toBeGreaterThan(0);
    expect(snapshot.streaming[0]).toMatchObject({ finalized: true });
  }, 60_000);

  it('完成真实 Tool Calling 与工具结果回送后的第二 Step', async () => {
    app.runtime.createSession('user-a', { sessionId: 'live-tool', title: 'Live tool' });
    app.runtime.submitInput('user-a', {
      sessionId: 'live-tool',
      content: '请务必调用 live_echo，参数 text 为 ping；拿到结果后只回复 TOOL_OK。',
      idempotencyKey: 'live-tool-1',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle();
    const snapshot = app.runtime.snapshot('user-a', 'live-tool') as LiveSnapshot;
    expect(
      snapshot.turns[0],
      JSON.stringify({
        turn: snapshot.turns[0],
        trajectory: snapshot.trajectory,
        lastModelEvents,
      }),
    ).toMatchObject({ status: 'completed', stepCount: 2 });
    expect(snapshot.trajectory.toolCalls[0]).toMatchObject({
      name: 'live_echo',
      status: 'success',
    });
    expect(snapshot.messages.at(-1)?.content).toContain('TOOL_OK');
  }, 60_000);
});

interface LiveSnapshot {
  turns: Array<{ status: string; stepCount: number; endReason: string | null }>;
  messages: Array<{ role: string; content: string }>;
  usage: { inputTokens: number; outputTokens: number };
  streaming: Array<{ finalized: boolean }>;
  trajectory: { toolCalls: Array<{ name: string; status: string }> };
}
