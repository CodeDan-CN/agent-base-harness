// Production Web and Electron UI against real Runtime events. Default mode uses a local
// deterministic model; --live URL runs one bounded task using the existing authorized agents.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const live = process.argv.includes('--live');
const liveUrl = process.argv[process.argv.indexOf('--live') + 1];
const temporary = await mkdtemp(path.join(os.tmpdir(), 'office-verification-'));
const outputDir = path.join(root, 'test-results', 'office', live ? 'live' : 'fixture');
await mkdir(outputDir, { recursive: true });
const { AgentClient } = createRequire(import.meta.url)('../dist/client/index.cjs');
const errors = [];
const checks = [];
const ids = [];
let server;
let browser;
let desktop;
let serverOutput = '';
let scenario = 'parallel';
let counters = {};
let activeSession;
let client;

const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const system = body.messages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n');
  const child = system.includes('OFFICE_TEST_RESEARCH')
    ? 'research'
    : system.includes('OFFICE_TEST_DESIGN')
      ? 'design'
      : 'parent';
  const count = counters[child] ?? 0;
  counters[child] = count + 1;
  if (scenario === 'failure' && child !== 'parent') {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Intentional office failure fixture' } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish = null) =>
    response.write(
      `data: ${JSON.stringify({ id: `office-${randomUUID()}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  const call = (name, args) => ({
    index: 0,
    id: `call-${randomUUID()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  if (child === 'parent' && count === 0) {
    emit(
      {
        content: '我会请研究和设计伙伴分别完成各自的任务。',
        tool_calls: (scenario === 'parallel' ? ids.slice(0, 2) : ids.slice(0, 1)).map(
          (id, index) => ({
            ...call('agent_call', {
              targetAgentId: id,
              task: '办公室验收：请给出一份简短的周末出行预算建议，仅做只读分析。',
            }),
            index,
          }),
        ),
      },
      'tool_calls',
    );
    response.end('data: [DONE]\n\n');
  } else if (child === 'research' && count === 0 && scenario === 'parallel') {
    emit(
      {
        content: '我已整理预算范围，需要先确认本次任务边界。',
        tool_calls: [
          call('request_user_input', {
            prompt: '是否仅进行只读预算分析？',
            kind: 'confirm',
            requiresUserProvidedFact: true,
          }),
        ],
      },
      'tool_calls',
    );
    response.end('data: [DONE]\n\n');
  } else {
    // Delays exercise real stream delivery and walking animation, without fake UI state.
    const delay =
      scenario === 'cancel' ? 45000 : scenario === 'fast' ? 0 : child === 'parent' ? 300 : 7500;
    const timer = setTimeout(() => {
      emit(
        {
          content:
            child === 'parent'
              ? '团队已完成本次任务，预算与行程建议已汇总。'
              : child === 'research'
                ? '预算报告：交通 600 元、住宿 800 元、餐饮 400 元、活动 200 元、备用金 200 元，共 2200 元。'
                : '行程报告：周六上午出发，下午游览；周日上午休闲活动，下午返程。',
        },
        'stop',
      );
      response.end('data: [DONE]\n\n');
    }, delay);
    response.on('close', () => clearTimeout(timer));
  }
});

async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for office validation');
}

async function login(surface) {
  await surface.getByLabel('账号', { exact: true }).fill('user-a');
  await surface.getByLabel('密码', { exact: true }).fill('user-a123');
  await surface.getByRole('button', { name: '登录', exact: true }).click();
  await surface.getByRole('button', { name: '办公室', exact: true }).waitFor();
}

async function openSession(surface, title) {
  await surface.getByText(title, { exact: true }).first().click();
  await surface.getByRole('button', { name: '办公室', exact: true }).click();
  await surface.locator('.office-station').first().waitFor();
}

async function submit(content) {
  return client.command('input.submit', {
    sessionId: activeSession.id,
    content,
    mode: 'queue',
    idempotencyKey: randomUUID(),
  });
}

async function settled(timeout = 90000) {
  let snapshot;
  await until(async () => {
    snapshot = await client.query('session.snapshot', { sessionId: activeSession.id });
    return (
      snapshot.turns.length > 0 &&
      !snapshot.activeTurnId &&
      !snapshot.inbox.length &&
      !(snapshot.delegations ?? []).some((item) =>
        ['accepted', 'running', 'awaiting_user'].includes(item.status),
      )
    );
  }, timeout);
  return snapshot;
}

async function screenshot(surface, name) {
  await surface.screenshot({ path: path.join(outputDir, name), fullPage: false });
}

try {
  let baseUrl = liveUrl;
  if (!live) {
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const dataDir = path.join(temporary, 'server');
    server = spawn(
      process.execPath,
      ['dist/server/index.cjs', '--data-dir', dataDir, '--port', '0'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stdout.on('data', (chunk) => (serverOutput += chunk));
    server.stderr.on('data', (chunk) => (serverOutput += chunk));
    await until(async () => {
      if (server.exitCode !== null) throw new Error(serverOutput);
      try {
        baseUrl = JSON.parse(
          await readFile(path.join(dataDir, 'server/discovery.json'), 'utf8'),
        ).baseUrl;
        return true;
      } catch {
        return false;
      }
    });
  }
  client = new AgentClient({
    baseUrl,
    clientKind: 'cli',
    user: { id: 'user-a', loginName: 'user-a', displayName: 'user-a' },
  });
  if (!live) {
    let models = await client.query('model-management.snapshot');
    const service = await client.command('model-service.save', {
      name: 'Office local fixture',
      providerType: 'openai-compatible',
      endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
      enabled: true,
      credential: { action: 'replace', value: 'office-fixture-only' },
      expectedRevision: models.revision,
    });
    models = await client.query('model-management.snapshot');
    const model = await client.command('model.save', {
      serviceId: service.id,
      remoteModelId: 'office-fixture',
      displayName: '办公室验证模型',
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
    for (const [name, marker, description] of [
      ['研究伙伴', 'RESEARCH', '资料整理与预算分析'],
      ['设计伙伴', 'DESIGN', '路线安排与体验设计'],
      ['工程伙伴', 'ENGINEERING', '工具开发与执行验证'],
    ]) {
      let management = await client.query('agent-management.snapshot');
      const agent = await client.command('agent.create', {
        name,
        description,
        instructions: `OFFICE_TEST_${marker}`,
        avatarKey: null,
        defaultModelId: null,
        permissionPreset: 'guarded',
        expectedRevision: management.revision,
      });
      ids.push(agent.id);
      management = await client.query('agent-management.snapshot');
      await client.command('agent.delegate.toggle', {
        callerAgentId: 'dylan',
        calleeAgentId: agent.id,
        enabled: true,
        expectedRevision: management.revision,
      });
    }
  }
  const management = await client.query('agent-management.snapshot');
  const dylan = management.agents.find((item) => item.profile.id === management.defaultAgentId);
  const authorized = management.agents.filter((item) =>
    dylan.bindings.delegateAgentIds.includes(item.profile.id),
  );
  if (!live) authorized.sort((a, b) => ids.indexOf(a.profile.id) - ids.indexOf(b.profile.id));
  assert.ok(authorized.length >= 2, 'Validation requires two authorized colleagues');
  console.log('Authorized agents:', authorized.map((item) => item.profile.name).join(', '));
  activeSession = await client.command('session.create', {
    agentId: dylan.profile.id,
    title: '[办公室验收] 周末行程与预算协作',
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 982 } });
  page.on('pageerror', (error) => errors.push(`Web: ${error.message}`));
  await page.goto(baseUrl);
  await login(page);
  await openSession(page, activeSession.title);
  await until(async () => (await page.locator('.office-station').count()) >= 3);
  checks.push('authorized roster includes colleagues absent from home navigation');
  await page.getByLabel('消息输入', { exact: true }).fill('切换视图时保留这份草稿');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.locator('.message-scroller').waitFor();
  await screenshot(page, 'web-conversation.png');
  const conversationComposer = await page.locator('.composer').boundingBox();
  await page.getByRole('button', { name: '办公室', exact: true }).click();
  assert.equal(
    await page.getByLabel('消息输入', { exact: true }).inputValue(),
    '切换视图时保留这份草稿',
  );
  await page.getByLabel('消息输入', { exact: true }).fill('');
  checks.push('conversation and composer survive view switching unchanged');
  const officeComposer = await page.locator('.composer').boundingBox();
  assert.ok(Math.abs(conversationComposer.width - officeComposer.width) < 1);
  assert.ok(Math.abs(conversationComposer.height - officeComposer.height) < 1);
  assert.equal(await page.locator('.office-brand-heading, .office-heading').count(), 0);
  assert.equal(
    await page
      .locator('.brand-row')
      .evaluate((element) => globalThis.getComputedStyle(element, '::before').content),
    'none',
  );
  checks.push('office headers removed and composer matches conversation dimensions');

  desktop = await _electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...process.env,
      AGENT_CLIENT_APP_DATA: path.join(temporary, 'desktop'),
      AGENT_HARNESS_SERVER_URL: baseUrl,
    },
  });
  const window = await desktop.firstWindow();
  await window.setViewportSize({ width: 1600, height: 982 });
  window.on('pageerror', (error) => errors.push(`Desktop: ${error.message}`));
  await window.getByRole('button', { name: '连接服务器', exact: true }).click();
  await login(window);
  await openSession(window, activeSession.title);
  await until(async () => (await window.locator('.office-station').count()) >= 3);
  await screenshot(page, 'web-idle.png');
  const roomBounds = await page.locator('.office-room-frame').boundingBox();
  const railBounds = await page.locator('.office-inspector').boundingBox();
  assert.ok(Math.abs(roomBounds.width / roomBounds.height - 1000 / 660) < 0.02);
  assert.ok(roomBounds.width > 1600 * 0.55, 'Office room dominates the reference composition');
  assert.ok(railBounds.width >= 1600 * 0.2 && railBounds.width <= 1600 * 0.24);
  checks.push('reference room aspect ratio and task-rail proportions are preserved');

  if (!live) {
    // Re-enter both views together to restart their local idle schedules.
    for (const surface of [page, window]) {
      await surface.getByRole('button', { name: '对话', exact: true }).click();
    }
    for (const surface of [page, window]) {
      await surface.getByRole('button', { name: '办公室', exact: true }).click();
    }
    // Track the actor's actual SVG origin, not sprite bounds (which change with each pose).
    for (const surface of [page, window]) {
      await surface.evaluate(() => {
        const monitor = { active: true, samples: 0, jumps: [], stalled: [], remounts: [] };
        globalThis.officeMotionMonitor = monitor;
        const previous = new Map();
        const sample = () => {
          if (!monitor.active) return;
          const now = globalThis.performance.now();
          for (const actor of globalThis.document.querySelectorAll('.office-character')) {
            const id = actor.dataset.agentId;
            const matrix = actor.transform.baseVal.consolidate()?.matrix;
            if (!matrix) continue;
            const last = previous.get(id);
            const distance = last ? Math.hypot(matrix.e - last.x, matrix.f - last.y) : 0;
            const moving = actor.dataset.moving === 'true';
            let stillSince = null;
            if (last) {
              if (actor !== last.actor) monitor.remounts.push(id);
              if (distance > 16) monitor.jumps.push({ id, distance });
              if (moving && last.moving && distance < 0.001) {
                stillSince = last.stillSince ?? now;
                if (now - stillSince > 300) monitor.stalled.push(id);
              }
            }
            previous.set(id, { actor, x: matrix.e, y: matrix.f, moving, stillSince });
            monitor.samples += 1;
          }
          globalThis.requestAnimationFrame(sample);
        };
        globalThis.requestAnimationFrame(sample);
      });
    }
    await Promise.all(
      [page, window].map(async (surface) => {
        await surface.locator('.office-walk-sprite').first().waitFor();
        const samples = await surface.evaluate(async () => {
          const samples = [];
          const started = globalThis.performance.now();
          while (globalThis.performance.now() - started < 2400) {
            for (const sprite of globalThis.document.querySelectorAll('.office-walk-sprite')) {
              const actor = sprite.closest('.office-character');
              const bounds = actor.getBoundingClientRect();
              samples.push({
                id: actor.dataset.agentId,
                facing: sprite.dataset.facing,
                frame: sprite.dataset.frame,
                x: bounds.x,
                y: bounds.y,
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return samples;
        });
        const actors = [...new Set(samples.map((sample) => sample.id))];
        assert.ok(
          actors.some(
            (id) =>
              new Set(samples.filter((sample) => sample.id === id).map((sample) => sample.frame))
                .size >= 3,
          ),
          'Walking cycles through distinct poses',
        );
        assert.ok(
          actors.some(
            (id) =>
              new Set(samples.filter((sample) => sample.id === id).map((sample) => sample.facing))
                .size >= 2,
          ),
          'Facing changes at aisle corners',
        );
        assert.ok(
          actors.some(
            (id) =>
              new Set(
                samples
                  .filter((sample) => sample.id === id)
                  .map((sample) => `${Math.round(sample.x)},${Math.round(sample.y)}`),
              ).size >= 3,
          ),
          'Walk poses accompany actual movement',
        );
        await screenshot(surface, surface === page ? 'web-walking.png' : 'desktop-walking.png');
        // Simulate a busy renderer. Resuming must not catch up with a large position jump.
        await surface.evaluate(() => {
          const until = globalThis.performance.now() + 220;
          while (globalThis.performance.now() < until) {
            /* deliberate test-only frame stall */
          }
        });
      }),
    );
    checks.push('Web and Desktop animate distinct walk poses and turn with the path');
    await until(
      async () =>
        (await page
          .locator(
            '.office-character[data-idle="coffee"], .office-character[data-idle="sofa"], .office-character[data-idle="window"]',
          )
          .count()) === 3 &&
        (await window
          .locator(
            '.office-character[data-idle="coffee"], .office-character[data-idle="sofa"], .office-character[data-idle="window"]',
          )
          .count()) === 3,
    );
    assert.equal(Object.keys(counters).length, 0, 'Idle activities must not call the model');
    const untouched = await client.query('session.snapshot', { sessionId: activeSession.id });
    assert.equal(untouched.turns.length, 0);
    await screenshot(page, 'web-idle-activities.png');
    await screenshot(window, 'desktop-idle-activities.png');
    checks.push('both clients show coffee, sofa and window activities without model calls');
  }

  const prompt = live
    ? `这是办公室交接验收任务。请实际委派给 ${authorized.map((item) => item.profile.name).join(' 和 ')} 两位伙伴，各做一个独立小任务，尽可能并行。虚构案例：两名成年人周末两天一夜游玩，总预算 3000 元；给定交通总额 600 元、住宿总额 800 元、餐饮总额 400 元、活动总额 200 元。投资顾问负责算出已知费用合计、结余，以及预留 300 元应急后的可用金额；出行规划负责在不引用具体城市、实时天气、车次或票价的前提下，给出通用两日安排。请把背景与数字完整交代给各位。整个测试只基于这些给定信息分析，不调用任何外部业务系统，不读写文件或记忆，不购买、预约或发送消息；不要调用 Skill 或 MCP。各位在执行中用简短公开文字说明进展，最后各返回不超过 200 字报告；你再汇总。`
    : '请两位伙伴并行完成本次办公室验收任务。';
  await writeFile(path.join(outputDir, 'task.txt'), prompt);
  await submit(prompt);
  await page.locator('.agent-office[data-visit="assign"]').waitFor({ timeout: 90000 });
  await window.locator('.agent-office[data-visit="assign"]').waitFor({ timeout: 15000 });
  for (const surface of [page, window]) {
    for (const id of [dylan.profile.id, ...authorized.slice(0, 2).map((item) => item.profile.id)]) {
      assert.equal(
        await surface.locator(`.office-character[data-agent-id="${id}"][data-idle]`).count(),
        0,
      );
    }
  }
  checks.push('real assignments preempt idle activities on both clients');
  await page.locator('.agent-office[data-stage="speaking"]').waitFor({ timeout: 15000 });
  await screenshot(page, 'web-assignment.png');
  await screenshot(window, 'desktop-assignment.png');
  checks.push('both clients animate real agent_call assignments');

  if (!live) {
    await page.getByText('是否仅进行只读预算分析？', { exact: false }).first().waitFor();
    const pending = await client.query('session.snapshot', { sessionId: activeSession.id });
    const question = pending.interactions.find((item) => item.status === 'pending');
    assert.ok(question);
    await screenshot(page, 'web-awaiting-user.png');
    const logBounds = await page.locator('.office-activity-log').boundingBox();
    const composerBounds = await page.locator('.input-gradient').boundingBox();
    assert.ok(
      logBounds.y + logBounds.height <= composerBounds.y + 1,
      `Activity rows remain above the composer: log bottom ${logBounds.y + logBounds.height}, composer top ${composerBounds.y}`,
    );
    assert.equal(await page.locator('.office-inspector .pending-action-dock').count(), 1);
    checks.push(
      'real delegated confirmation appears in the task rail and activity rows remain visible',
    );
    // Use the actual UI action rather than an API-only resolution.
    await page
      .locator('.pending-action-dock')
      .getByRole('button', { name: '提交', exact: true })
      .click();
    checks.push('delegated question is resolved through the existing UI');
  }
  await page.locator('.agent-office[data-visit="report"]').waitFor({ timeout: 180000 });
  await page
    .locator('.agent-office[data-visit="report"][data-stage="speaking"]')
    .waitFor({ timeout: 15000 });
  await screenshot(page, 'web-report-walk.png');
  const completed = await settled(live ? 240000 : 90000);
  assert.ok(completed.delegations.length >= 2, 'Both colleagues must actually be delegated');
  assert.ok(
    completed.delegations.every((item) => item.status === 'completed'),
    JSON.stringify(
      completed.delegations.map((item) => ({ name: item.targetAgentName, status: item.status })),
    ),
  );
  await page
    .locator('.office-team-list button')
    .filter({ hasText: authorized[0].profile.name })
    .click();
  await page.getByText('交付报告', { exact: true }).waitFor();
  await screenshot(page, 'web-completed.png');
  await window
    .locator('.office-team-list button')
    .filter({ hasText: authorized[1].profile.name })
    .click();
  await screenshot(window, 'desktop-completed.png');
  checks.push('two real reports returned and are inspectable');

  if (!live) {
    // Let all hand-offs finish, including their return walks, before ending the trace.
    for (const surface of [page, window]) {
      await surface.locator('.agent-office[data-visit="idle"]').waitFor({ timeout: 90000 });
      const trace = await surface.evaluate(() => {
        globalThis.officeMotionMonitor.active = false;
        return globalThis.officeMotionMonitor;
      });
      assert.ok(trace.samples > 500);
      assert.deepEqual(
        trace.jumps,
        [],
        'Actor origins stay continuous across phases and interruptions',
      );
      assert.deepEqual(trace.stalled, [], 'No walking in place');
      assert.deepEqual(
        trace.remounts,
        [],
        'Actors retain identity across rest, delegation and return',
      );
    }
    checks.push(
      'continuous per-frame actor trace: no teleporting, stalled walking or phase remounts on either client',
    );
    const isolated = await client.command('session.create', {
      agentId: dylan.profile.id,
      title: '[办公室验收] 会话切换隔离',
    });
    await page.reload();
    await openSession(page, isolated.title);
    await until(async () => (await page.locator('.office-station').count()) >= 3);
    assert.equal(await page.locator('.office-activity-log').count(), 0);
    assert.equal(await page.locator('.agent-office').getAttribute('data-visit'), 'idle');
    await openSession(page, activeSession.title);
    await page.locator('.office-activity-log').waitFor();
    assert.equal(await page.locator('.agent-office').getAttribute('data-visit'), 'idle');
    checks.push('switching sessions clears the old scene and never replays old deliveries');
  }

  await page.reload();
  await page.getByText(activeSession.title, { exact: true }).first().click();
  await page.getByRole('button', { name: '办公室', exact: true }).click();
  await page.locator('.office-station').first().waitFor();
  assert.equal(await page.locator('.agent-office').getAttribute('data-visit'), 'idle');
  checks.push('reload restores results without replaying historical visits');
  await page.setViewportSize({ width: 900, height: 780 });
  await page.locator('.office-team-list button').first().click();
  await screenshot(page, 'web-narrow.png');
  await page.getByRole('button', { name: '收起任务详情' }).click();
  assert.equal(await page.locator('.office-inspector').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await until(
    async () =>
      (await page.locator('.office-character[data-idle]').count()) === 0 &&
      (await page.locator('.office-character[data-moving="true"]').count()) === 0,
  );
  assert.equal(await page.locator('.office-character[data-idle]').count(), 0);
  checks.push('reduced motion disables idle activities');
  await page.evaluate(() => {
    globalThis.document.documentElement.dataset.theme = 'dark';
  });
  await screenshot(page, 'web-dark.png');
  checks.push('narrow window inspector and dark theme render');

  if (!live) {
    for (const nextScenario of ['fast', 'failure', 'cancel']) {
      scenario = nextScenario;
      counters = {};
      await page.setViewportSize({ width: 1500, height: 1000 });
      await submit(`验证 ${scenario}`);
      await until(async () => {
        const snapshot = await client.query('session.snapshot', { sessionId: activeSession.id });
        return snapshot.delegations.length > completed.delegations.length;
      });
      if (scenario === 'cancel') {
        await until(async () => counters.research > 0);
        const snapshot = await client.query('session.snapshot', { sessionId: activeSession.id });
        await client.command('turn.cancel', {
          sessionId: activeSession.id,
          turnId: snapshot.activeTurnId,
          keepNextTurn: false,
          keepNextStep: false,
          reason: 'user_cancelled',
        });
      }
      const snapshot = await settled();
      const last = snapshot.delegations.at(-1);
      assert.equal(
        last.status,
        scenario === 'fast' ? 'completed' : scenario === 'failure' ? 'failed' : 'cancelled',
      );
      if (scenario !== 'fast')
        await until(
          async () =>
            (await page.locator('.agent-office').getAttribute('data-visit-delegation')) !== last.id,
        );
      checks.push(`${scenario} terminal state and animation behavior`);
      completed.delegations = snapshot.delegations;
    }
  }
  assert.deepEqual(errors, []);
  const report = {
    mode: live
      ? 'existing agents and configured providers'
      : 'deterministic local provider with real Runtime',
    sessionId: activeSession.id,
    title: activeSession.title,
    agents: authorized.map((item) => item.profile.name),
    checks,
    errors,
  };
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (client && activeSession) {
    const snapshot = await client
      .query('session.snapshot', { sessionId: activeSession.id })
      .catch(() => null);
    await writeFile(
      path.join(outputDir, 'report.json'),
      JSON.stringify(
        {
          status: 'incomplete',
          mode: live ? 'existing agents and configured providers' : 'local fixture',
          sessionId: activeSession.id,
          title: activeSession.title,
          checks,
          errors,
          failure: error.message,
          turns: snapshot?.turns.map((turn) => ({ status: turn.status, reason: turn.endReason })),
          delegations: snapshot?.delegations.map((item) => ({
            name: item.targetAgentName,
            status: item.status,
          })),
        },
        null,
        2,
      ),
    );
  }
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages()) await screenshot(page, 'failure.png').catch(() => {});
  console.error(error);
  console.error('UI errors:', errors);
  process.exitCode = 1;
} finally {
  await desktop?.close();
  await browser?.close();
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
