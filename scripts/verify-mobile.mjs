/* global setInterval, clearInterval, document, innerWidth, innerHeight, window, Event, localStorage */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-mobile-smoke-'));
const dataDir = path.join(temporary, 'server');
const server = spawn(
  process.execPath,
  ['dist/server/index.cjs', '--data-dir', dataDir, '--port', '0', '--allow-registration'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
server.stdout.on('data', (data) => (output += data));
server.stderr.on('data', (data) => (output += data));
let browser;
let vite;
const provider = createHttpServer((request, response) => {
  request.resume();
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  let index = 0;
  const parts = [
    '手机端已连接。',
    '这条回复通过远程 Runtime 流式传输。',
    '关闭手机不会关闭服务器。',
  ];
  const timer = setInterval(() => {
    if (index < parts.length) {
      response.write(
        `data: ${JSON.stringify({ id: 'mobile-smoke', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: parts[index++] }, finish_reason: null }] })}\n\n`,
      );
    } else {
      response.write(
        `data: ${JSON.stringify({ id: 'mobile-smoke', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\ndata: [DONE]\n\n`,
      );
      clearInterval(timer);
      response.end();
    }
  }, 400);
  response.on('close', () => clearInterval(timer));
});
try {
  let discovery;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      discovery = JSON.parse(await readFile(path.join(dataDir, 'server/discovery.json'), 'utf8'));
      break;
    } catch {
      /* Wait for this test's server only. */
    }
    if (server.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(discovery, output);
  const require = createRequire(import.meta.url);
  const { AgentClient } = require('../dist/client/index.cjs');
  const client = new AgentClient({ baseUrl: discovery.baseUrl, clientKind: 'cli' });
  // Use the installation's existing account for cross-client fixtures. New registrations
  // below create an independent data space and expose no ID binding control.
  await client.login('user-a', 'user-a123');
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  let models = await client.query('model-management.snapshot');
  const service = await client.command('model-service.save', {
    name: 'Mobile fixture',
    providerType: 'openai-compatible',
    endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
    enabled: true,
    credential: { action: 'unchanged' },
    expectedRevision: models.revision,
  });
  models = await client.query('model-management.snapshot');
  const model = await client.command('model.save', {
    serviceId: service.id,
    remoteModelId: 'mobile-fixture',
    displayName: 'Mobile fixture',
    contextWindow: 32768,
    maxOutputTokens: 4096,
    capabilities: { tools: true, streaming: true, vision: false },
    enabled: true,
    expectedRevision: models.revision,
  });
  models = await client.query('model-management.snapshot');
  await client.command('model.default.set', {
    modelId: model.id,
    expectedRevision: models.revision,
  });
  const boot = await client.query('app.bootstrap');
  const session = await client.command('session.create', {
    title: '多端共享会话',
    agentId: boot.defaultAgentId,
  });
  process.env.AGENT_HARNESS_SERVER_URL = discovery.baseUrl;
  vite = await createViteServer({
    configFile: path.join(root, 'vite.mobile.config.ts'),
    server: { port: 5185, strictPort: false },
  });
  await vite.listen();
  const address = vite.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  });
  const page = await browser.newPage({
    viewport: { width: 393, height: 873 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:'))
      errors.push(message.text());
  });
  page.on('response', (response) => {
    if (
      response.status() >= 400 &&
      !(response.status() === 401 && response.url().endsWith('/v1/auth/me'))
    )
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(address);
  await page.getByRole('button', { name: '连接服务器', exact: true }).click();
  await page.getByRole('button', { name: '还没有账号？创建账号', exact: true }).click();
  assert.equal(await page.getByLabel(/用户\s*ID|user\s*id/i).count(), 0);
  assert.doesNotMatch(await page.locator('.auth-card').innerText(), /用户\s*ID|绑定|关联/);
  await page.getByLabel('账号', { exact: true }).fill('mobile_smoke');
  await page.getByLabel('密码', { exact: true }).fill('mobile-password');
  await page.getByLabel('确认密码', { exact: true }).fill('mobile-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('heading', { name: '新对话', exact: true }).waitFor();
  await page.getByRole('button', { name: '打开会话列表' }).click();
  assert.equal(await page.getByText('多端共享会话', { exact: true }).count(), 0);
  assert.doesNotMatch(
    await page.getByRole('dialog', { name: '会话列表' }).innerText(),
    /用户\s*ID|local-[a-f0-9]+/,
  );
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '退出登录', exact: true })
    .click();
  await page.getByLabel('账号', { exact: true }).fill('user-a');
  await page.getByLabel('密码', { exact: true }).fill('user-a123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '多端共享会话', exact: true }).waitFor();
  assert.equal(await page.locator('.permission-picker, .model-picker, .sidebar').count(), 0);
  const composer = page.getByRole('textbox', { name: '消息输入' });
  await composer.fill('手机冒烟测试');
  await composer.press('Enter');
  assert.equal(await composer.inputValue(), '手机冒烟测试\n');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('手机端已连接。', { exact: true }).waitFor();
  await page
    .getByText('手机端已连接。这条回复通过远程 Runtime 流式传输。关闭手机不会关闭服务器。', {
      exact: true,
    })
    .waitFor();
  const snapshots = path.join(root, 'test-results/mobile');
  await mkdir(snapshots, { recursive: true });
  for (const [width, height] of [
    [360, 800],
    [384, 854],
    [393, 873],
    [412, 915],
    [873, 393],
    [393, 420],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const dimensions = await page.evaluate(() => {
      const input = document.querySelector('.composer').getBoundingClientRect();
      const header = document.querySelector('.mobile-header').getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        input: { top: input.top, bottom: input.bottom, right: input.right },
        header: { bottom: header.bottom },
      };
    });
    assert.ok(dimensions.scrollWidth <= width, JSON.stringify(dimensions));
    assert.ok(
      dimensions.input.bottom <= height && dimensions.input.top >= dimensions.header.bottom,
      JSON.stringify(dimensions),
    );
    await page.screenshot({ path: path.join(snapshots, `chat-${width}x${height}.png`) });
  }
  await page.setViewportSize({ width: 393, height: 873 });
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.screenshot({ path: path.join(snapshots, 'sessions.png') });
  await page.getByRole('button', { name: '重命名 多端共享会话', exact: true }).click();
  await page.getByRole('textbox', { name: '会话名称' }).fill('手机重命名会话');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: '手机重命名会话' }).waitFor();
  assert.equal(
    (await client.query('session.list')).find((item) => item.id === session.id).title,
    '手机重命名会话',
  );
  // Resume fetches a fresh snapshot; renames made from another client become visible.
  const current = (await client.query('session.list')).find((item) => item.id === session.id);
  await client.command('session.rename', {
    sessionId: session.id,
    title: '后台恢复会话',
    expectedVersion: current.version,
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: '后台恢复会话' }).waitFor();
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('heading', { name: '新对话', exact: true }).waitFor();
  await composer.fill('手机新会话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止处理' }).click();
  await page.getByRole('button', { name: '停止处理' }).waitFor({ state: 'hidden' });
  assert.ok((await client.query('session.list')).some((item) => item.title === '手机新会话'));
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.getByRole('button', { name: '归档 手机新会话', exact: true }).click();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.getByRole('button', { name: '切换服务器', exact: true }).click();
  await page.getByRole('heading', { name: '连接你的 Runtime' }).waitFor();
  assert.equal((await client.health()).instanceId, discovery.instanceId);
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => /token|password/.test(key)),
    ),
    [],
  );
  assert.deepEqual(errors, []);
  console.log(
    '[mobile] Real Runtime: registration without ID binding, login, shared sessions, streaming, stop, create/rename/archive, resume, disconnect, six viewports passed. Android native layer is NOT covered by this browser test.',
  );
} finally {
  await browser?.close();
  await vite?.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
