import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

test('S475-E2E Agent 档案、首页关系与会话归属形成闭环', async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), 'agent-harness-475-e2e-'));
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

    await page.getByRole('button', { name: '创建智能体', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置' });
    await expect(settings.getByRole('heading', { name: '创建智能体' })).toBeVisible();
    await settings.getByLabel('名称').fill('金融研究员');
    await settings.getByLabel('简介').fill('公司与行业研究');
    await settings.getByRole('button', { name: /更多设置/ }).click();
    const moreSettings = page.getByRole('dialog', { name: '金融研究员 · 更多设置' });
    await expect(moreSettings.getByLabel('默认模型')).toBeVisible();
    await moreSettings.getByLabel('默认模型').click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.getByRole('option', { name: '继承用户默认模型' }).click();
    await expect(moreSettings.getByRole('radio', { name: /^受控自动 / })).toBeChecked();
    await moreSettings.getByRole('radio', { name: /^请求批准 / }).check();
    await moreSettings.getByLabel('核心指令').fill('你是金融研究员。');
    await moreSettings.getByRole('button', { name: '应用设置' }).click();
    await expect(moreSettings).toHaveCount(0);
    await expect(settings.getByRole('button', { name: /已配置核心指令/ })).toBeVisible();
    await settings.getByRole('button', { name: '创建档案' }).click();
    await expect(page.getByText('智能体档案已创建；可在首页“智能体＋”中加入。')).toBeVisible();

    await expect(page.locator('.agent-settings-list')).toContainText('金融研究员');
    await settings.getByRole('button', { name: /更多设置/ }).click();
    const persistedSettings = page.getByRole('dialog', { name: '金融研究员 · 更多设置' });
    await expect(persistedSettings.getByLabel('核心指令')).toHaveValue('你是金融研究员。');
    await persistedSettings.getByRole('button', { name: '关闭更多设置' }).click();

    await settings.getByRole('button', { name: '添加Skills' }).click();
    const skillDialog = page.getByRole('dialog', { name: '添加 Skills' });
    await expect(skillDialog).toBeVisible();
    await expect(skillDialog.getByPlaceholder('搜索Skill名称或简介')).toBeFocused();
    await expect(skillDialog.getByRole('button', { name: '全部' })).toBeVisible();
    await expect(skillDialog.getByText('结果列表')).toBeVisible();
    await skillDialog.getByPlaceholder('搜索Skill名称或简介').fill('不存在的能力');
    await expect(skillDialog.getByText('没有可添加的项目')).toBeVisible();
    await skillDialog.getByRole('button', { name: '关闭选择窗口' }).click();

    await settings.getByRole('button', { name: '添加MCP 与记忆' }).click();
    await expect(page.getByRole('dialog', { name: '添加 MCP 与记忆' })).toBeVisible();
    await page.getByRole('button', { name: '关闭选择窗口' }).click();

    await settings.getByRole('button', { name: '添加Sub Agents' }).click();
    await expect(page.getByRole('dialog', { name: '添加 Sub Agent' })).toBeVisible();
    await page.getByRole('button', { name: '关闭选择窗口' }).click();

    await settings.getByRole('button', { name: '返回' }).click();
    await expect(page.locator('.agent-group').filter({ hasText: '金融研究员' })).toHaveCount(0);

    const addAgentButton = page.getByRole('button', { name: '把已有智能体加入首页' });
    await addAgentButton.click();
    const picker = page.locator('.agent-picker-popover');
    await expect(picker).toContainText('金融研究员');
    const addAgentBox = await addAgentButton.boundingBox();
    const pickerBox = await picker.boundingBox();
    expect(addAgentBox).not.toBeNull();
    expect(pickerBox).not.toBeNull();
    expect(pickerBox!.x).toBeGreaterThanOrEqual(addAgentBox!.x - 1);
    expect(Math.abs(pickerBox!.y - (addAgentBox!.y + addAgentBox!.height + 6))).toBeLessThan(3);
    expect(pickerBox!.width).toBeLessThanOrEqual(282);
    await picker.getByRole('button', { name: /金融研究员/ }).click();

    const group = page.locator('.agent-group').filter({ hasText: '金融研究员' });
    const dylanGroup = page.locator('.agent-group').filter({ hasText: 'Dylan' });
    await expect(group).toBeVisible();
    await expect(dylanGroup).toHaveClass(/active/);
    await group.getByRole('button', { name: '折叠 金融研究员 的会话' }).click();
    await expect(group.locator('.agent-sessions')).toHaveCount(0);
    await expect(dylanGroup).toHaveClass(/active/);
    await group.getByRole('button', { name: '展开 金融研究员 的会话' }).click();
    await expect(group.getByText('暂无对话')).toBeVisible();
    await group.getByRole('button', { name: '在 金融研究员 下新建对话' }).click();
    await expect(group.locator('.session-item')).toHaveCount(0);

    const firstQuestion =
      '请帮我详细分析这家公司最近三个季度的收入结构、利润率变化、现金流质量以及未来可能面对的主要经营风险';
    const composer = page.getByRole('textbox', { name: '消息输入' });
    await expect(composer).toBeEnabled();
    await composer.fill(firstQuestion);

    await dylanGroup.getByRole('button', { name: '在 Dylan 下新建对话' }).click();
    await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue('');
    await group.getByRole('button', { name: '在 金融研究员 下新建对话' }).click();
    await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(firstQuestion);

    await page.getByRole('button', { name: '请求批准' }).click();
    await page.getByRole('menuitemradio', { name: /^受控自动 / }).click();
    await expect(page.getByText('已切换为受控自动。')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(firstQuestion);

    await page.getByRole('textbox', { name: '消息输入' }).press('Enter');
    const sessionTitle = group.locator('.session-title-viewport');
    await expect(sessionTitle).toContainText(firstQuestion);
    const titlePresentation = await sessionTitle.evaluate((element) => ({
      overflows: element.scrollWidth > element.clientWidth,
      mask: getComputedStyle(element).maskImage,
    }));
    expect(titlePresentation.overflows).toBe(true);
    expect(titlePresentation.mask).toContain('linear-gradient');
    await sessionTitle.hover();
    await expect
      .poll(async () => sessionTitle.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);

    const navigation = await page.evaluate(async () => {
      const client = (
        globalThis as unknown as {
          agentClient: { query(method: string, params?: unknown): Promise<Envelope> };
        }
      ).agentClient;
      return client.query('agent.navigation', { sessionsPerAgent: 20 });
    });
    expect(navigation.ok).toBe(true);
    const finance = navigation.ok
      ? (
          navigation.result as {
            items: Array<{
              agent: { id: string; name: string; permissionPreset: string };
              sessions: Array<{
                agentId: string;
                origin: string;
                parentSessionId: null;
                permissionPreset: string;
              }>;
            }>;
          }
        ).items.find((item) => item.agent.name === '金融研究员')
      : undefined;
    expect(finance?.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: finance?.agent.id,
          origin: 'direct',
          parentSessionId: null,
          permissionPreset: 'guarded',
        }),
      ]),
    );
    expect(finance?.agent.permissionPreset).toBe('guarded');

    await page.locator('.profile-button').click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const reopenedSettings = page.getByRole('dialog', { name: '设置' });
    await reopenedSettings.getByRole('button', { name: '智能体' }).click();
    await reopenedSettings.getByRole('button', { name: /金融研究员/ }).click();
    await reopenedSettings.getByRole('button', { name: /更多设置/ }).click();
    const synchronizedSettings = page.getByRole('dialog', { name: '金融研究员 · 更多设置' });
    await expect(synchronizedSettings.getByRole('radio', { name: /^受控自动 / })).toBeChecked();
    await synchronizedSettings.getByRole('radio', { name: /^请求批准 / }).check();
    await synchronizedSettings.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByText('更多设置已保存。')).toBeVisible();

    const synchronizedNavigation = await page.evaluate(async () => {
      const client = (
        globalThis as unknown as {
          agentClient: { query(method: string, params?: unknown): Promise<Envelope> };
        }
      ).agentClient;
      return client.query('agent.navigation', { sessionsPerAgent: 20 });
    });
    expect(synchronizedNavigation.ok).toBe(true);
    const synchronizedFinance = synchronizedNavigation.ok
      ? (
          synchronizedNavigation.result as {
            items: Array<{
              agent: { name: string; permissionPreset: string };
              sessions: Array<{ permissionPreset: string }>;
            }>;
          }
        ).items.find((item) => item.agent.name === '金融研究员')
      : undefined;
    expect(synchronizedFinance?.agent.permissionPreset).toBe('approval-required');
    expect(synchronizedFinance?.sessions[0]?.permissionPreset).toBe('approval-required');
  } finally {
    await app.close();
    rmSync(appData, { recursive: true, force: true });
  }
});

async function login(page: Page): Promise<void> {
  await page.getByLabel('账号').fill('user-a');
  await page.getByLabel('密码').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.auth-screen')).toHaveCount(0);
}
