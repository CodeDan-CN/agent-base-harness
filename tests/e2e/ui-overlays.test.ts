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

test('UI-E2E-001 应用内设置、下拉与确认弹窗保持统一', async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), 'agent-harness-ui-e2e-'));
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

    await expect(page.locator('.context-token-indicator')).toHaveCount(1);
    const contextIndicator = page.locator('.context-token-indicator');
    await expect(contextIndicator).toBeVisible();
    await contextIndicator.click();
    const tokenStats = page.getByRole('dialog', { name: '会话 Token 统计' });
    await expect(tokenStats).toBeVisible();
    await expect(tokenStats).toContainText('会话 QA 上下文');
    await expect(tokenStats).toContainText('会话记忆压缩');
    await contextIndicator.click();
    await expect(tokenStats).toBeHidden();

    const composer = page.locator('.composer');
    const composerBorderBeforeFocus = await composer.evaluate(
      (element) => getComputedStyle(element).borderColor,
    );
    await page.locator('.composer textarea').evaluate((element) => element.focus());
    await expect(composer).toHaveCSS('border-color', composerBorderBeforeFocus);

    const composerInput = page.getByRole('textbox', { name: '消息输入' });
    await composerInput.evaluate(
      (element, value) => {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        if (!valueSetter) throw new Error('textarea value setter missing');
        valueSetter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      },
      Array.from({ length: 20 }, (_, index) => `长输入内容 ${index + 1}`).join('\n'),
    );
    const composerLayout = await composer.evaluate((element) => {
      const textarea = element.querySelector('textarea');
      const actions = element.querySelector('.composer-actions');
      if (!textarea || !actions) throw new Error('composer layout missing');
      const textareaRect = textarea.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      return {
        actionsTop: Math.round(actionsRect.top),
        actionsBorderTopWidth: getComputedStyle(actions).borderTopWidth,
        textareaBottom: Math.round(textareaRect.bottom),
        textareaClientHeight: textarea.clientHeight,
        textareaScrollHeight: textarea.scrollHeight,
      };
    });
    expect(composerLayout.textareaBottom).toBeLessThanOrEqual(composerLayout.actionsTop);
    expect(composerLayout.actionsBorderTopWidth).toBe('0px');
    expect(composerLayout.textareaScrollHeight).toBeGreaterThan(
      composerLayout.textareaClientHeight,
    );

    await page.locator('.permission-trigger').click();
    await expect(page.locator('.permission-popover')).toBeVisible();
    await page.locator('.chat-area').click({ position: { x: 20, y: 100 } });
    await expect(page.locator('.permission-popover')).toBeHidden();

    await page.locator('.permission-trigger').click();
    await page.getByRole('menuitemradio', { name: /完全访问/ }).click();
    const permissionConfirm = page.getByRole('alertdialog');
    await expect(permissionConfirm).toContainText('开启完全访问？');
    await expect(permissionConfirm.getByRole('button', { name: '开启完全访问' })).toBeDisabled();
    await permissionConfirm.getByLabel('我理解这可能修改工作区外的文件').check();
    await expect(permissionConfirm.getByRole('button', { name: '开启完全访问' })).toBeEnabled();
    await permissionConfirm.getByRole('button', { name: '取消' }).click();

    await page.locator('.profile-button').click();
    await expect(page.locator('.profile-menu')).toBeVisible();
    await page.locator('.chat-area').click({ position: { x: 20, y: 100 } });
    await expect(page.locator('.profile-menu')).toBeHidden();

    await page.locator('.profile-button').click();
    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
    await page.getByRole('button', { name: '外观' }).click();
    await expect(page.getByRole('heading', { name: '外观' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /自动/ })).toBeChecked();
    await page.getByRole('radio', { name: /浅色/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'light');

    await page.getByRole('button', { name: 'MCP 服务' }).click();
    const mcpPage = page.locator('.mcp-page');
    const mcpListLayout = await mcpPage.evaluate((element) => {
      const list = element.querySelector('.service-list');
      const search = element.querySelector('.mcp-search');
      if (!list || !search) throw new Error('MCP service list layout missing');
      const pageRect = element.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const searchRect = search.getBoundingClientRect();
      return {
        listTop: Math.round(listRect.top - pageRect.top),
        listBottom: Math.round(pageRect.bottom - listRect.bottom),
        searchTop: Math.round(searchRect.top - pageRect.top),
        background: getComputedStyle(list).backgroundColor,
      };
    });
    expect(mcpListLayout).toMatchObject({
      listTop: 0,
      listBottom: 0,
      background: 'rgb(248, 248, 246)',
    });
    expect(mcpListLayout.searchTop).toBeGreaterThanOrEqual(18);
    expect(mcpListLayout.searchTop).toBeLessThanOrEqual(24);

    await page.getByRole('button', { name: '技能与插件' }).click();
    await expect(page.getByRole('heading', { name: '技能与插件' })).toBeVisible();

    await page.getByRole('button', { name: '外观' }).click();
    await page.getByRole('radio', { name: /深色/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
    await page.getByRole('button', { name: '模型配置' }).click();
    await page.getByRole('button', { name: '添加模型服务' }).click();
    await page.getByLabel('服务类型').click();
    await expect(page.getByRole('option', { name: 'DeepSeek' })).toBeVisible();
    await expect(page.getByRole('option', { name: '阿里云百炼' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '返回' }).click();

    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('textbox', { name: '消息输入' }).fill('测试会话菜单');
    await page.getByRole('textbox', { name: '消息输入' }).press('Enter');
    await page.getByRole('button', { name: '测试会话菜单 操作' }).click();
    await expect(page.locator('.session-menu')).toBeVisible();
    await page.locator('.chat-area').click({ position: { x: 20, y: 100 } });
    await expect(page.locator('.session-menu')).toBeHidden();

    await page.getByRole('button', { name: '测试会话菜单 操作' }).click();
    await page.getByRole('button', { name: '归档' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('归档这段对话？');
    await expect(confirm.getByRole('button', { name: '归档' })).toBeVisible();
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
