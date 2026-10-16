import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const electronExecutable =
  process.platform === 'darwin'
    ? path.join(
        process.cwd(),
        'node_modules',
        'electron',
        'dist',
        'Electron.app',
        'Contents',
        'MacOS',
        'Electron',
      )
    : path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron');

type Envelope =
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

interface TestClient {
  query(method: string, params?: unknown): Promise<Envelope>;
  command(method: string, params?: unknown): Promise<Envelope>;
}

interface ModelRequest {
  messages?: Array<{ role?: string; content?: string }>;
}

test('受派智能体执行过程实时嵌入父会话并可在完成后回看', async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), 'agent-harness-delegation-ui-e2e-'));
  const requests: ModelRequest[] = [];
  let targetAgentId = '';
  const server = await startDelegationServer(requests, () => targetAgentId);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model server unavailable');
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [process.cwd()],
    env: { ...process.env, AGENT_CLIENT_APP_DATA: appData },
  });

  try {
    const page = await app.firstWindow();
    await login(page);
    await page.waitForFunction(() => document.documentElement.dataset.smoke === 'ok', undefined, {
      timeout: 40_000,
    });
    await configureModel(page, `http://127.0.0.1:${address.port}/v1`);
    targetAgentId = await createDelegatedAgent(page);

    await page.getByRole('button', { name: '新对话', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '消息输入' });
    await composer.fill('请让金融研究员完成调查并汇总');
    await composer.press('Enter');

    await expect
      .poll(() => requests.map((request) => requestKind(request, targetAgentId)), {
        timeout: 20_000,
      })
      .toContain('child');
    const delegationCard = page.locator('.delegation-card');
    await expect(delegationCard).toBeVisible();
    await expect(delegationCard).toHaveAttribute('open', '');
    await expect(delegationCard).toContainText('Dylan');
    await expect(delegationCard).toContainText('金融研究员');

    const childExecution = delegationCard.locator('.embedded-execution-card');
    await expect(childExecution).toBeVisible();
    await expect(childExecution).toContainText('金融研究员的执行过程');
    await expect(childExecution.locator('.execution-step')).toHaveCount(2, { timeout: 20_000 });

    await expect(page.getByText('Dylan 已整合受派报告。', { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const parentExecution = page.locator('.execution-card:not(.embedded-execution-card)').last();
    const parentToggle = parentExecution.locator(
      ':scope > .execution-header .execution-header-toggle',
    );
    if ((await parentToggle.getAttribute('aria-expanded')) !== 'true') await parentToggle.click();
    const parentTools = parentExecution
      .locator(':scope > .execution-body > div > .execution-step > .tool-execution-panel')
      .last();
    if ((await parentTools.getAttribute('open')) === null) {
      await parentTools.locator(':scope > summary').click();
    }
    const completedDelegation = parentTools.locator('.delegation-card');
    if ((await completedDelegation.getAttribute('open')) === null) {
      await completedDelegation.locator(':scope > summary').click();
    }
    const completedChildExecution = completedDelegation.locator('.embedded-execution-card');
    const childToggle = completedChildExecution.locator(
      ':scope > .execution-header .execution-header-toggle',
    );
    if ((await childToggle.getAttribute('aria-expanded')) !== 'true') await childToggle.click();
    const childTools = completedChildExecution.locator(
      ':scope > .execution-body > div > .execution-step > .tool-execution-panel',
    );
    if ((await childTools.getAttribute('open')) === null) {
      await childTools.locator(':scope > summary').click();
    }
    await expect(childTools).toContainText('capability_search');
    await expect(completedDelegation).toContainText('金融智能体完成调查。');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(appData, { recursive: true, force: true });
  }
});

async function login(page: Page): Promise<void> {
  await page.getByLabel('账号').fill('user-a');
  await page.getByLabel('密码').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.auth-screen')).toHaveCount(0);
}

async function configureModel(page: Page, endpoint: string): Promise<void> {
  await page.evaluate(
    async ({ endpoint }) => {
      const client = (globalThis as unknown as { agentClient: TestClient }).agentClient;
      const unwrap = async (promise: Promise<Envelope>) => {
        const result = await promise;
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.result as Record<string, unknown>;
      };
      const service = await unwrap(
        client.command('model-service.save', {
          name: '委派 UI 测试模型',
          providerType: 'openai-compatible',
          endpoint,
          enabled: true,
          config: {},
          credential: { action: 'unchanged' },
          expectedRevision: 0,
        }),
      );
      const afterService = await unwrap(client.query('model-management.snapshot'));
      const model = await unwrap(
        client.command('model.save', {
          serviceId: service.id,
          remoteModelId: 'delegation-ui-model',
          displayName: 'Delegation UI Model',
          contextWindow: 8192,
          maxOutputTokens: 512,
          capabilities: { tools: true, streaming: true, vision: false },
          defaultParams: {},
          enabled: true,
          expectedRevision: afterService.revision,
        }),
      );
      const afterModel = await unwrap(client.query('model-management.snapshot'));
      await unwrap(
        client.command('model.default.set', {
          modelId: model.id,
          expectedRevision: afterModel.revision,
        }),
      );
    },
    { endpoint },
  );
}

async function createDelegatedAgent(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const client = (globalThis as unknown as { agentClient: TestClient }).agentClient;
    const unwrap = async (promise: Promise<Envelope>) => {
      const result = await promise;
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return result.result as Record<string, unknown>;
    };
    const before = await unwrap(client.query('agent-management.snapshot'));
    const agent = await unwrap(
      client.command('agent.create', {
        name: '金融研究员',
        description: '执行金融调查',
        avatarKey: null,
        instructions: '你是金融研究员，请清晰展示调查过程。',
        defaultModelId: null,
        permissionPreset: 'guarded',
        expectedRevision: before.revision,
      }),
    );
    const afterCreate = await unwrap(client.query('agent-management.snapshot'));
    await unwrap(
      client.command('agent.delegate.toggle', {
        callerAgentId: before.defaultAgentId,
        calleeAgentId: agent.id,
        enabled: true,
        expectedRevision: afterCreate.revision,
      }),
    );
    return String(agent.id);
  });
}

async function startDelegationServer(
  requests: ModelRequest[],
  targetAgentId: () => string,
): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest;
      requests.push(body);
      const selectedAgentId = targetAgentId();
      const messages = body.messages ?? [];
      const serialized = JSON.stringify(messages);
      const isChild = serialized.includes('你是金融研究员');
      const childHasSearchResult =
        isChild &&
        messages.some(
          (message) => message.role === 'tool' && message.content?.includes('"candidates"'),
        );
      const parentHasDelegationResult = !isChild && serialized.includes('delegationId');
      const parentHasSearchResult =
        !isChild && !parentHasDelegationResult && serialized.includes(selectedAgentId);

      const toolCalls =
        isChild && !childHasSearchResult
          ? [toolCall('child-search', 'capability_search', {})]
          : parentHasSearchResult
            ? [
                toolCall('delegate-finance', 'agent_call', {
                  targetAgentId: selectedAgentId,
                  task: '调查目标公司的基本情况并返回简明结论。',
                  allowSharedMemory: false,
                }),
              ]
            : !isChild && !parentHasDelegationResult
              ? [toolCall('search-agent', 'capability_search', {})]
              : undefined;
      const content = childHasSearchResult
        ? '金融智能体完成调查。'
        : parentHasDelegationResult
          ? 'Dylan 已整合受派报告。'
          : '';
      const reasoning = childHasSearchResult
        ? '我正在核对受派任务与现有能力，并整理调查结论。'
        : '';
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls ? 'tool_calls' : 'stop',
            },
          ],
        })}\n\n`,
      );
      setTimeout(
        () => {
          response.end(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
          );
        },
        isChild ? 1_600 : 0,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    index: 0,
    id,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function requestKind(request: ModelRequest, targetAgentId: string): string {
  const serialized = JSON.stringify(request.messages ?? []);
  if (serialized.includes('你是金融研究员')) return 'child';
  if (serialized.includes('delegationId')) return 'parent-after-delegation';
  if (serialized.includes(targetAgentId)) return 'parent-after-search';
  return 'parent';
}
