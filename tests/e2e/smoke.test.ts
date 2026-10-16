import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const electronBin =
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
const electronExecutable = electronBin;
const QUEUE_PANEL_FLASH_WINDOW_MS = 120;

type Envelope =
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
interface TestClient {
  query(method: string, params?: unknown): Promise<Envelope>;
  command(method: string, params?: unknown): Promise<Envelope>;
}

test('S1-E2E-001 首次启动完整链路：migration、双用户、Worker ready、bootstrap/health 可用', async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), 'agent-harness-e2e-'));

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
    await expect(page.getByRole('heading', { name: '新对话' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '今天我能帮你做什么？' })).toBeVisible();

    await page.locator('.profile-button').click();
    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('heading', { name: 'Agent 模型管理' })).toBeVisible();
    await page.getByRole('button', { name: '技能与插件' }).click();
    await expect(page.getByRole('heading', { name: '技能与插件' })).toBeVisible();
    await page.getByRole('button', { name: '返回' }).click();

    const bootstrap = await page.evaluate(async () => {
      const client = (globalThis as unknown as { agentClient: TestClient }).agentClient;
      return client.query('app.bootstrap');
    });
    expect(bootstrap.ok).toBe(true);
    const result = bootstrap.ok ? (bootstrap.result as { activeUser: { id: string } }) : null;
    expect(result?.activeUser.id).toBe('user-a');

    const health = await page.evaluate(async () => {
      const client = (globalThis as unknown as { agentClient: TestClient }).agentClient;
      return client.query('system.health');
    });
    expect(health.ok).toBe(true);

    await page.locator('.profile-button').click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await login(page, 'user-b');
    const switched = await page.evaluate(async () => {
      const client = (globalThis as unknown as { agentClient: TestClient }).agentClient;
      return client.query('app.bootstrap');
    });
    expect(switched).toMatchObject({ ok: true, result: { activeUser: { id: 'user-b' } } });
  } finally {
    await app.close();
    rmSync(appData, { recursive: true, force: true });
  }
});

test('S4-E2E-001 归档模型可重新添加并按具体模型选择有效思考等级', async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), 'agent-harness-thinking-e2e-'));
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
    const restored = await page.evaluate(async () => {
      const client = (globalThis as unknown as { agentClient: TestClient }).agentClient;
      const unwrap = async (promise: Promise<Envelope>) => {
        const result = await promise;
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.result as Record<string, unknown>;
      };
      const service = await unwrap(
        client.command('model-service.save', {
          name: 'DeepSeek',
          providerType: 'openai-compatible',
          endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          enabled: true,
          config: {},
          credential: { action: 'unchanged' },
          expectedRevision: 0,
        }),
      );
      const created = await unwrap(
        client.command('model.save', {
          serviceId: service.id,
          remoteModelId: 'deepseek-v4-flash-0731',
          displayName: 'DeepSeek V4 Flash 0731',
          contextWindow: 1_000_000,
          requestMaxOutputTokens: null,
          maxOutputTokens: 200_000,
          capabilities: { tools: true, streaming: true, vision: false },
          defaultParams: {},
          enabled: true,
          expectedRevision: 1,
        }),
      );
      await unwrap(client.command('model.archive', { id: created.id, expectedRevision: 2 }));
      const restoredModel = await unwrap(
        client.command('model.save', {
          serviceId: service.id,
          remoteModelId: 'deepseek-v4-flash-0731',
          displayName: 'DeepSeek V4 Flash 0731',
          contextWindow: 1_000_000,
          requestMaxOutputTokens: null,
          maxOutputTokens: 200_000,
          capabilities: { tools: true, streaming: true, vision: false },
          defaultParams: {},
          enabled: true,
          expectedRevision: 3,
        }),
      );
      return { createdId: created.id, restoredId: restoredModel.id };
    });
    expect(restored.restoredId).toBe(restored.createdId);

    await page.locator('.profile-button').click();
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: /^DeepSeek 1 个模型/ }).click();
    const thinkingMode = page.getByLabel('思考模式');
    await expect(thinkingMode).toBeVisible();
    await thinkingMode.click();
    await page.getByRole('option', { name: '开启思考' }).click();
    await expect(page.getByText('思考设置已保存。')).toBeVisible();
    const reasoningEffort = page.getByLabel('思考强度');
    await expect(reasoningEffort).toBeVisible();
    await reasoningEffort.click();
    await expect(page.getByRole('option')).toHaveCount(3);
    await expect(page.getByRole('option')).toHaveText(['低', '高', '最高']);
    await page.getByRole('option', { name: '低', exact: true }).click();
    await expect(reasoningEffort).toContainText('低');

    await page
      .getByRole('button', { name: '设置 DeepSeek V4 Flash 0731 的上下文' })
      .click();
    const contextDialog = page.getByRole('dialog', {
      name: 'DeepSeek V4 Flash 0731 上下文设置',
    });
    await expect(contextDialog.getByRole('radio', { name: '自动推荐' })).toBeChecked();
    await expect(contextDialog.getByLabel('单次输出上限 Token')).toHaveValue('200000');
    await contextDialog.getByLabel('压缩触发阈值').click();
    await page.getByRole('option', { name: '70%', exact: true }).click();
    await expect(contextDialog.getByLabel('单次输出上限 Token')).toHaveValue('300000');
    await contextDialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('上下文设置已保存。')).toBeVisible();

    const snapshot = await page.evaluate(async () => {
      const client = (globalThis as unknown as { agentClient: TestClient }).agentClient;
      return client.query('model-management.snapshot');
    });
    expect(snapshot.ok).toBe(true);
    const model = snapshot.ok
      ? (
          snapshot.result as {
            models: Array<{
              thinkingMode: string;
              reasoningEffort: string;
              requestMaxOutputTokens: number | null;
              maxOutputTokens: number;
            }>;
          }
        ).models[0]
      : null;
    expect(model).toMatchObject({
      thinkingMode: 'enabled',
      reasoningEffort: 'low',
      requestMaxOutputTokens: null,
      maxOutputTokens: 300_000,
    });
  } finally {
    await app.close();
    rmSync(appData, { recursive: true, force: true });
  }
});

test('S3-E2E-001 真实 Client 连续追问保留阶段 2 最近问答上下文', async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), 'agent-harness-memory-e2e-'));
  const requests: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
  const server = await startModelServer(requests);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model server address unavailable');

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

    await page.getByRole('button', { name: '新对话', exact: true }).click();
    const input = page.getByRole('textbox', { name: '消息输入' });
    await expect(input).toBeEnabled();
    await input.fill('你记住你叫小爱同学');
    await input.press('Enter');
    const reasoningToggle = page.getByRole('button', {name: '模型推理', exact: true});
    await expect(reasoningToggle).toBeVisible({timeout: 20_000});
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.reasoning-scroll')).toHaveCount(0);
    expect(await page.locator('.reasoning-panel').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
    await reasoningToggle.click();
    await expect(page.locator('.reasoning-scroll')).toBeVisible();
    await expect(page.getByText('好的，我记住了，我叫小爱同学。', { exact: true })).toBeVisible({timeout: 20_000});
    await expect(page.locator('.send-button')).toContainText('发送');
    await expect(page.locator('.execution-card')).toHaveCount(1);
    await expect(page.locator('.assistant-response strong')).toHaveText('小爱同学');

    await input.fill('你叫什么');
    await input.press('Enter');
    await expect(page.getByText('我叫小爱同学。', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.execution-card')).toHaveCount(2);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '你记住你叫小爱同学' }),
        expect.objectContaining({
          role: 'assistant',
          content: '好的，我记住了，我叫**小爱同学**。',
        }),
        expect.objectContaining({ role: 'user', content: '你叫什么' }),
      ]),
    );

    await expect(page.locator('.send-button')).toContainText('发送');
    const messageScroller = page.locator('.message-scroller');
    await messageScroller.evaluate((element) => {
      element.style.height = '220px';
      element.style.maxHeight = '220px';
      element.scrollTop = 0;
    });
    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __idleQueuePanelObserved?: boolean;
        __idleQueuePanelObserver?: MutationObserver;
      };
      state.__idleQueuePanelObserved = false;
      state.__idleQueuePanelObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (
              node instanceof Element &&
              (node.matches('.queue-panel') || node.querySelector('.queue-panel'))
            ) {
              state.__idleQueuePanelObserved = true;
            }
          }
        }
      });
      state.__idleQueuePanelObserver.observe(document.body, { childList: true, subtree: true });
    });
    await input.fill('调用历史搜索工具');
    await input.press('Enter');
    const submittedMessage = page.locator('.message.user').last();
    await expect(submittedMessage).toContainText('调用历史搜索工具');
    await expect
      .poll(async () => {
        const scrollerRect = await messageScroller.boundingBox();
        const messageRect = await submittedMessage.boundingBox();
        return scrollerRect && messageRect ? Math.round(messageRect.y - scrollerRect.y) : -1;
      })
      .toBeGreaterThanOrEqual(14);
    await expect
      .poll(async () => {
        const scrollerRect = await messageScroller.boundingBox();
        const messageRect = await submittedMessage.boundingBox();
        return scrollerRect && messageRect ? Math.round(messageRect.y - scrollerRect.y) : 999;
      })
      .toBeLessThanOrEqual(18);
    await page.waitForTimeout(QUEUE_PANEL_FLASH_WINDOW_MS);
    expect(
      await page.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __idleQueuePanelObserved?: boolean;
          __idleQueuePanelObserver?: MutationObserver;
        };
        state.__idleQueuePanelObserver?.disconnect();
        return state.__idleQueuePanelObserved;
      }),
    ).toBe(false);
    await messageScroller.evaluate((element) => {
      element.style.removeProperty('height');
      element.style.removeProperty('max-height');
    });
    await expect(page.locator('.execution-commentary').getByText('正在调用历史搜索工具。', {exact: true})).toBeVisible();
    await expect(page.locator('.streaming-output')).toHaveCount(0);
    await expect(page.getByText('工具执行完成。', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(input).toHaveAttribute('placeholder', '给 AI 助手发送消息...');
    await expect(page.locator('.execution-narrative-panel')).toHaveCount(0);
    await expect(
      page.locator('.message.assistant > .assistant-block > .markdown-content', {
        hasText: '正在调用历史搜索工具。',
      }),
    ).toHaveCount(0);
    await expect(page.locator('.send-button')).toContainText('发送');
    await page.locator('.execution-header-toggle').last().click();
    await expect(page.getByText('执行内容', { exact: true }).last()).toBeVisible();
    await expect(page.locator('.execution-commentary').getByText('正在调用历史搜索工具。', {exact: true})).toHaveCount(1);
    await page.screenshot({path: 'test-results/thinking-mode-4.6.0.png', fullPage: true});
    const executionDetails = page.locator('.tool-execution-panel').last();
    await expect(executionDetails).not.toHaveAttribute('open');
    await executionDetails.locator(':scope > summary').click();
    await expect(executionDetails).toHaveAttribute('open', '');
    const toolCard = page.locator('.tool-card').last();
    await expect(toolCard).not.toHaveAttribute('open');
    expect(await executionDetails.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
    expect(await toolCard.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');

    await expect(toolCard.getByText('event_search', { exact: true })).toBeVisible();
    await toolCard.locator('summary').click();
    await expect(toolCard.getByText('输入', { exact: true })).toBeVisible();
    await expect(toolCard.getByText('输出', { exact: true })).toBeVisible();
    await expect(toolCard.locator('code').first()).toContainText('query');
    await page.emulateMedia({colorScheme: 'dark'});
    expect(await executionDetails.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await toolCard.locator('summary').click();
    await page.screenshot({path: 'test-results/execution-details-borderless.png', fullPage: true});
    await page.emulateMedia({colorScheme: 'light'});

    await expect(page.locator('.assistant-block > .markdown-content strong').last()).toHaveText(
      '完成',
    );

    await page.getByRole('button', { name: '重命名会话' }).click();
    const renameDialog = page.getByRole('dialog', { name: '重命名会话' });
    await expect(renameDialog).toBeVisible();
    await renameDialog.getByLabel('会话名称').fill('模型性能测试');
    await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(renameDialog).not.toBeVisible();
    await expect(page.getByRole('heading', { name: '模型性能测试' })).toBeVisible();

    await page.locator('.profile-button').click();
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '调用统计' }).click();
    await expect(page.getByRole('heading', { name: '模型调用统计' })).toBeVisible();
    await expect(page.locator('.statistics-row')).toHaveCount(4);
    await expect(page.locator('.metric-card').first()).toContainText('4');
    await expect(page.locator('.statistics-row-main').first()).toContainText('e2e-model');
    await expect(page.locator('.statistics-row-main').first()).toContainText('模型性能测试');
    await page.locator('.statistics-row-main').first().click();
    await expect(page.locator('.statistics-detail').first()).toContainText('请求 ID');
    await expect(page.locator('.statistics-detail').first()).toContainText('输入 Token');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(appData, { recursive: true, force: true });
  }
});

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
          name: 'E2E 本地模型',
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
          remoteModelId: 'e2e-model',
          displayName: 'E2E Model',
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

async function login(page: Page, loginName = 'user-a', password = '123456'): Promise<void> {
  await page.getByLabel('账号').fill(loginName);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.auth-screen')).toHaveCount(0);
}

async function startModelServer(
  requests: Array<{ messages?: Array<{ role?: string; content?: string }> }>,
): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      requests.push(body);
      const requestIndex = requests.length;
      const content =
        requestIndex === 1
          ? '好的，我记住了，我叫**小爱同学**。'
          : requestIndex === 2
            ? '我叫**小爱同学**。'
            : requestIndex === 3
              ? '正在调用历史搜索工具。'
              : requestIndex === 4
                ? '工具执行**完成**。'
                : '';
      const toolCalls =
        requestIndex === 3
          ? [
              {
                index: 0,
                id: 'e2e-tool-call',
                function: { name: 'event_search', arguments: '{"query":"小爱"}' },
              },
            ]
          : undefined;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                ...(requestIndex < 3 ? { reasoning_content: '正在**分析**用户请求。' } : {}),
                ...(requestIndex === 3 ? { phase: 'commentary' } : {}),
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls ? 'tool_calls' : 'stop',
            },
          ],
        })}\n\n`,
      );
      setTimeout(() => {
        response.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 8 },
          })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      }, 1500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}
