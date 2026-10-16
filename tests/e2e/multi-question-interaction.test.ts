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

test('多问题交互逐题提供推荐选项与其他输入', async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), 'agent-harness-questions-e2e-'));
  const requests: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
  const server = await startQuestionServer(requests);
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
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '消息输入' });
    await composer.fill('帮我规划一个 12 个月 POC');
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const enter = new KeyboardEvent('keydown', {
        bubbles: true,
        isComposing: true,
        key: 'Enter',
      });
      Object.defineProperty(enter, 'keyCode', { value: 229 });
      element.dispatchEvent(enter);
    });
    await expect(page.locator('.message.user')).toHaveCount(0);
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await composer.press('Enter');
    await expect(page.locator('.session-title-viewport')).toContainText('帮我规划一个 12 个月 POC');
    await expect(page.locator('.message.user')).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => requests.length).toBeGreaterThan(0);

    const card = page.locator('.interaction-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('.interaction-question')).toHaveCount(1);
    await expect(card.getByLabel('问题进度')).toContainText('1 / 3');
    const choiceLayout = await card.locator('.interaction-choices').evaluate((element) => {
      const container = element.getBoundingClientRect();
      return [...element.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          left: Math.round(rect.left - container.left),
          top: Math.round(rect.top - container.top),
          width: Math.round(rect.width),
        };
      });
    });
    expect(choiceLayout).toHaveLength(4);
    expect(new Set(choiceLayout.map((choice) => choice.left)).size).toBe(1);
    expect(new Set(choiceLayout.map((choice) => choice.width)).size).toBe(1);
    expect(choiceLayout.map((choice) => choice.top)).toEqual(
      [...choiceLayout.map((choice) => choice.top)].sort((left, right) => left - right),
    );
    expect(new Set(choiceLayout.map((choice) => choice.top)).size).toBe(choiceLayout.length);
    const next = card.getByRole('button', { name: '下一题' });
    await expect(next).toBeDisabled();

    const question = card.locator('.interaction-question');
    await question.getByText('5xFAD', { exact: true }).click();
    await next.click();
    await expect(card.getByLabel('问题进度')).toContainText('2 / 3');
    await question.getByText('其他', { exact: true }).click();
    await question.getByPlaceholder('请输入其他想法').fill('脑组织，约 8 例');
    await next.click();
    await expect(card.getByLabel('问题进度')).toContainText('3 / 3');
    await question.getByText('单细胞转录组', { exact: true }).click();
    const submit = card.getByRole('button', { name: '提交' });
    await expect(submit).toBeEnabled();
    await submit.click();

    const streamingResponse = page.locator('.message.assistant.streaming');
    await expect(streamingResponse).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '回到最新消息' })).toHaveCount(0);
    const messageScroller = page.locator('.message-scroller');
    await expect
      .poll(() =>
        messageScroller.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(4);
    await expect(page.getByText('已收到全部补充信息。', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(streamingResponse).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(() =>
        messageScroller.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(4);
    await expect(page.getByText(/用户交互结果/)).toHaveCount(0);
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.execution-card')).toHaveCount(1);
    await expect(page.locator('.interaction-answer-step')).toContainText('用户回答');
    await expect(page.locator('.interaction-answer-step')).toContainText('脑组织，约 8 例');
    await expect(
      page.locator('.tool-card').filter({ hasText: 'request_user_input' }),
    ).toContainText('已回答');

    await composer.fill('再问一句');
    await composer.press('Enter');
    await expect(page.getByText('第二轮没有模型思考内容。', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.reasoning-scroll')).toHaveCount(0);
    await expect(page.locator('.execution-card')).toHaveCount(1);

    const stepContextIndicator = page.getByRole('button', {
      name: /当前 Turn 步骤上下文/,
    });
    await expect(stepContextIndicator).toBeVisible();
    await stepContextIndicator.click();
    const stepTokenStats = page.getByRole('dialog', { name: '步骤 Token 统计' });
    await expect(stepTokenStats).toContainText('执行步骤上下文');
    await expect(stepTokenStats).toContainText('运行表面压缩');
    expect(requests.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('"sample":"脑组织，约 8 例"'),
        }),
      ]),
    );
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
          remoteModelId: 'e2e-question-model',
          displayName: 'E2E Question Model',
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

async function login(page: Page): Promise<void> {
  await page.getByLabel('账号').fill('user-a');
  await page.getByLabel('密码').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.auth-screen')).toHaveCount(0);
}

async function startQuestionServer(
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
      const firstRequest = requests.length === 1;
      const followUpRequest = requests.length > 2;
      const answer = firstRequest
        ? ''
        : followUpRequest
          ? '第二轮没有模型思考内容。'
          : `已收到全部补充信息。\n\n${Array.from(
              { length: 36 },
              (_, index) => `分析段落 ${index + 1}：用于验证长内容生成期间页面保持稳定。`,
            ).join('\n\n')}`;
      const reasoningContent =
        firstRequest || followUpRequest
          ? ''
          : Array.from(
              { length: 24 },
              (_, index) => `思考片段 ${index + 1}：持续更新执行过程，但不推动外层页面。`,
            ).join('\n\n');
      const toolCalls = firstRequest
        ? [
            {
              index: 0,
              id: 'e2e-question-call',
              function: {
                name: 'request_user_input',
                arguments: JSON.stringify({
                  prompt: '请补充几项关键资源信息。',
                  questions: [
                    {
                      id: 'model',
                      header: '动物模型',
                      question: '可用的 AD 小鼠模型是？',
                      options: ['5xFAD', 'APP/PS1', 'Trem2-KO'],
                    },
                    {
                      id: 'sample',
                      header: '患者样本',
                      question: '主要样本类型是？',
                      options: ['血浆', 'CSF', 'PBMC'],
                    },
                    {
                      id: 'platform',
                      header: '检测平台',
                      question: '团队最擅长的检测是？',
                      options: ['单细胞转录组', '流式', '蛋白组'],
                    },
                  ],
                }),
              },
            },
          ]
        : undefined;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: reasoningContent,
                content: answer,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls ? 'tool_calls' : 'stop',
            },
          ],
        })}\n\n`,
      );
      setTimeout(
        () =>
          response.end(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
          ),
        firstRequest ? 0 : 500,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}
