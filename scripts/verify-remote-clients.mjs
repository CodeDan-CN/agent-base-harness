// Real packaged Web/Desktop/CLI against one independently started Runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, _electron } from 'playwright';
import { ZipArchive } from 'archiver';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-remote-smoke-'));
const dataDir = path.join(temporary, 'server');
const packagedRuntime = process.env.AGENT_RUNTIME_EXECUTABLE;
const server = spawn(
  packagedRuntime || process.execPath,
  [
    packagedRuntime ? 'serve' : 'dist/server/index.cjs',
    '--data-dir',
    dataDir,
    '--port',
    '0',
    '--allow-registration',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
server.stdout.on('data', (data) => (output += data));
server.stderr.on('data', (data) => (output += data));
let browser;
let desktop;
try {
  let discovery;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      discovery = JSON.parse(
        await readFile(path.join(dataDir, 'server', 'discovery.json'), 'utf8'),
      );
      break;
    } catch {
      /* Await owned server. */
    }
    if (server.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(discovery, output);
  const require = createRequire(import.meta.url);
  const { AgentClient } = require('../dist/client/index.cjs');
  const client = new AgentClient({ baseUrl: discovery.baseUrl, clientKind: 'cli' });
  // The installation's existing account supplies shared fixture ownership. Fresh registrations
  // below must create their own data spaces without accepting an ID from the user.
  const auth = await client.login('user-a', 'user-a123');
  const zip = new ZipArchive();
  const chunks = [];
  const zipped = new Promise((resolve, reject) => {
    zip.on('data', (data) => chunks.push(data));
    zip.once('end', () => resolve(Buffer.concat(chunks)));
    zip.once('error', reject);
  });
  zip.append(
    '---\nname: remote-smoke\ndescription: Remote upload verification\n---\n\nDo nothing.\n',
    { name: 'remote-smoke/SKILL.md' },
  );
  await zip.finalize();
  await client.installSkill(new globalThis.Blob([await zipped]), 'remote-smoke.zip');
  await runCli(
    ['register', '--login', 'remote_smoke', '--password-stdin'],
    'smoke-password\n',
    discovery.baseUrl,
  );
  const cliAccount = await runCli(['whoami'], '', discovery.baseUrl);
  assert.match(cliAccount, /remote_smoke/);
  assert.doesNotMatch(cliAccount, /local-[a-f0-9]+/);
  await runCli(['logout'], '', discovery.baseUrl);
  await runCli(
    ['login', '--login', 'user-a', '--password-stdin'],
    'user-a123\n',
    discovery.baseUrl,
  );
  assert.match(await runCli(['whoami'], '', discovery.baseUrl), /user-a/);
  const navigation = await client.query('agent.navigation', { sessionsPerAgent: 1 });
  const session = await client.command('session.create', {
    agentId: navigation.defaultAgentId,
    title: 'Remote smoke shared session',
  });
  // The only file written directly is a server-side fixture; both clients read through HTTP.
  const workspace = path.join(dataDir, 'workspaces', auth.user.id, session.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'remote-smoke.txt'), 'remote result');
  assert.equal(
    await (await client.downloadSessionFile(session.id, 'remote-smoke.txt')).text(),
    'remote result',
  );

  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(discovery.baseUrl);
  await verifyRegistrationAndLogin(page);
  await page
    .getByText('Remote smoke shared session', { exact: true })
    .first()
    .waitFor({ timeout: 10000 })
    .catch(async (error) => {
      console.error(await page.locator('body').innerText(), errors);
      throw error;
    });
  await page.reload();
  await page.getByText('Remote smoke shared session', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await verifySessionUpload(page, 'Web 新会话');

  desktop = await _electron.launch({
    chromiumSandbox: true,
    args: process.env.AGENT_DESKTOP_EXECUTABLE ? [] : ['.'],
    ...(process.env.AGENT_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.AGENT_DESKTOP_EXECUTABLE }
      : {}),
    cwd: root,
    env: {
      ...process.env,
      AGENT_CLIENT_APP_DATA: path.join(temporary, 'desktop'),
      AGENT_HARNESS_SERVER_URL: discovery.baseUrl,
    },
  });
  const window = await desktop.firstWindow();
  window.on('pageerror', (error) => errors.push(error.message));
  await window.getByRole('button', { name: '连接服务器', exact: true }).click();
  await verifyRegistrationAndLogin(window);
  await window.getByText('Remote smoke shared session', { exact: true }).first().waitFor();
  const current = await window.evaluate(() => window.agentClient.currentAuth());
  assert.equal(current.ok, true);
  assert.equal('accessToken' in current.result, false);
  await window.getByText('Remote smoke shared session', { exact: true }).first().click();
  await verifySessionUpload(window, 'Desktop 已有会话');
  if (process.env.AGENT_VALIDATION_OUTPUT) {
    await mkdir(process.env.AGENT_VALIDATION_OUTPUT, { recursive: true });
    await window.screenshot({
      path: path.join(process.env.AGENT_VALIDATION_OUTPUT, 'linux-desktop.png'),
    });
    await page.screenshot({
      path: path.join(process.env.AGENT_VALIDATION_OUTPUT, 'linux-web.png'),
    });
  }
  await desktop.close();
  desktop = undefined;
  assert.equal((await client.health()).instanceId, discovery.instanceId);
  assert.deepEqual(errors, []);
  console.log(
    '[remote-smoke] Web/Desktop registration without ID binding, file upload and draft paths, login/shared session, CLI registration/login, ZIP upload/download, hidden token and independent Runtime passed',
  );
  console.log(
    `[remote-smoke] Server source: ${packagedRuntime ? 'installed Runtime package' : 'development bundle'}`,
  );
} finally {
  await desktop?.close();
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.kill('SIGKILL');
        resolve();
      }, 5000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(temporary, { recursive: true, force: true });
}

async function verifyRegistrationAndLogin(surface) {
  await surface.getByRole('button', { name: '还没有账号？创建账号', exact: true }).click();
  assert.equal(await surface.getByLabel(/用户\s*ID|user\s*id/i).count(), 0);
  assert.doesNotMatch(await surface.locator('.auth-card').innerText(), /用户\s*ID|绑定|关联/);
  await surface.getByLabel('账号', { exact: true }).fill('remote_smoke');
  await surface.getByLabel('密码', { exact: true }).fill('smoke-password');
  await surface.getByLabel('确认密码', { exact: true }).fill('smoke-password');
  await surface.getByRole('button', { name: '创建账号', exact: true }).click();
  await surface.locator('.profile-button').filter({ hasText: 'remote_smoke' }).waitFor();
  assert.equal(await surface.getByText('Remote smoke shared session', { exact: true }).count(), 0);
  await surface.locator('.profile-button').click();
  assert.doesNotMatch(
    await surface.getByRole('group', { name: '账户菜单' }).innerText(),
    /用户\s*ID|local-[a-f0-9]+/,
  );
  await surface.getByRole('button', { name: '退出登录', exact: true }).click();
  await surface
    .getByRole('alertdialog')
    .getByRole('button', { name: '退出登录', exact: true })
    .click();
  await surface.getByLabel('账号', { exact: true }).fill('user-a');
  await surface.getByLabel('密码', { exact: true }).fill('user-a123');
  await surface.getByRole('button', { name: '登录', exact: true }).click();
}

async function verifySessionUpload(surface, marker) {
  const draft = `${marker}：请读取附件`;
  await surface.getByLabel('消息输入', { exact: true }).fill(draft);
  const responsePromise = marker.startsWith('Desktop')
    ? null
    : surface.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /\/v1\/sessions\/[^/]+\/files$/.test(response.url()),
      );
  // Electron performs HTTP in Main, so its upload is observed through the resulting draft instead.
  await surface.getByLabel('选择会话文件').setInputFiles({
    name: '测试 附件.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('opaque body ' + marker),
  });
  if (responsePromise) assert.equal((await responsePromise).status(), 201);
  await surface.waitForFunction(() => {
    const input = globalThis.document.querySelector('textarea[aria-label="消息输入"]');
    return input && !input.disabled && input.value.includes('/attachments/');
  });
  const value = await surface.getByLabel('消息输入', { exact: true }).inputValue();
  assert.equal(value.split('\n')[0], draft);
  const uploadedPath = JSON.parse(value.split('\n')[1]);
  assert.equal(await readFile(uploadedPath, 'utf8'), 'opaque body ' + marker);
  assert.ok(!value.includes('opaque body'));
  // Missing-model rejection must leave the editable path and question intact for retry.
  await surface.getByRole('button', { name: '发送', exact: true }).click();
  await surface
    .getByText('请先在设置中添加可用模型，再在聊天输入框中选择模型。', { exact: true })
    .waitFor();
  assert.equal(await surface.getByLabel('消息输入', { exact: true }).inputValue(), value);
}

function runCli(args, input, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'dist/cli/index.cjs',
        '--server',
        baseUrl,
        '--data-dir',
        path.join(temporary, 'cli'),
        ...args,
      ],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    child.stdin.end(input);
  });
}
