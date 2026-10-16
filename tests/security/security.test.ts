import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedNavigation } from '../../apps/desktop/src/main/navigation';
import { resolveSessionFile } from '../../packages/execution/src/files/session-file';
import { ProcessRunner, ProcessRunError } from '../../packages/execution/src/process/process-runner';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

const INDEX_HTML = 'file:///app/dist/renderer/index.html';

describe('安全：导航白名单精确校验', () => {
  it('生产仅允许精确 index.html 入口', () => {
    expect(isAllowedNavigation(INDEX_HTML, [INDEX_HTML])).toBe(true);
    expect(isAllowedNavigation('file:///app/dist/renderer/index.html#/chat', [INDEX_HTML])).toBe(
      true,
    );
    expect(isAllowedNavigation('file:///etc/passwd', [INDEX_HTML])).toBe(false);
    expect(isAllowedNavigation('file:///app/dist/renderer/other.html', [INDEX_HTML])).toBe(false);
    expect(isAllowedNavigation('https://evil.example.com/index.html', [INDEX_HTML])).toBe(false);
  });

  it('dev origin 白名单：host/port 一致才放行', () => {
    const dev = ['http://localhost:5173'];
    expect(isAllowedNavigation('http://localhost:5173/', dev)).toBe(true);
    expect(isAllowedNavigation('http://localhost:5173/assets/x.js', dev)).toBe(true);
    expect(isAllowedNavigation('http://localhost:5174/', dev)).toBe(false);
    expect(isAllowedNavigation('https://localhost:5173/', dev)).toBe(false);
    expect(isAllowedNavigation('http://evil.localhost:5173/', dev)).toBe(false);
  });

  it('非法 URL 一律拒绝', () => {
    expect(isAllowedNavigation('not a url', [INDEX_HTML])).toBe(false);
    expect(isAllowedNavigation('', [INDEX_HTML])).toBe(false);
  });
});

describe('安全：ProcessRunner 路径与环境约束', () => {
  let root: string;

  afterEach(() => {
    cleanupDir(root);
  });

  it('symlink 指向受控根外时拒绝', () => {
    root = makeTempDir();
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    mkdirSync(allowed, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = path.join(allowed, 'escape');
    symlinkSync(outside, link);

    const runner = new ProcessRunner({ allowedRoots: [allowed] });
    return expect(
      runner.run({ cmd: process.execPath, args: ['-e', '1'], cwd: link }),
    ).rejects.toThrow(ProcessRunError);
  });

  it('opts.env 含 allowlist 外变量被拒绝', () => {
    root = makeTempDir();
    const runner = new ProcessRunner({ allowedRoots: [root] });
    return expect(
      runner.run({
        cmd: process.execPath,
        args: ['-e', '1'],
        cwd: root,
        env: { SECRET_INJECTED: 'bypass' },
      }),
    ).rejects.toThrow(new ProcessRunError('Environment key is not in the allowlist'));
  });

  it('allowlist 内变量可覆盖传递', async () => {
    root = makeTempDir();
    const runner = new ProcessRunner({ allowedRoots: [root] });
    const result = await runner.run({
      cmd: process.execPath,
      args: ['-e', "console.log(process.env.LANG ?? 'ABSENT')"],
      cwd: root,
      env: { LANG: 'C.UTF-8' },
    });
    expect(result.stdout).toContain('C.UTF-8');
  });
});

describe('安全：只能打开当前 Session 工作区内的非可执行文件', () => {
  let root: string;

  afterEach(() => {
    cleanupDir(root);
  });

  it('解析当前用户与 Session 下的普通 HTML 文件', async () => {
    root = makeTempDir();
    const artifacts = path.join(root, 'workspaces', 'user-a', 'session-a', 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const report = path.join(artifacts, 'report.html');
    writeFileSync(report, '<!doctype html>');

    await expect(
      resolveSessionFile({
        appDataDir: root,
        userId: 'user-a',
        sessionId: 'session-a',
        target: 'artifacts/report.html',
      }),
    ).resolves.toBe(realpathSync(report));
  });

  it('拒绝目录穿越、绝对路径和工作区外文件', async () => {
    root = makeTempDir();
    const workspace = path.join(root, 'workspaces', 'user-a', 'session-a');
    mkdirSync(path.join(workspace, 'artifacts'), { recursive: true });
    writeFileSync(path.join(workspace, 'secret.html'), 'secret');

    for (const target of [
      'artifacts/../../secret.html',
      '/tmp/report.html',
      'file:///tmp/report.html',
    ]) {
      await expect(
        resolveSessionFile({
          appDataDir: root,
          userId: 'user-a',
          sessionId: 'session-a',
          target,
        }),
      ).rejects.toThrow();
    }
  });

  it('拒绝工作区内的可执行文件', async () => {
    root = makeTempDir();
    const workspace = path.join(root, 'workspaces', 'user-a', 'session-a');
    mkdirSync(workspace, { recursive: true });
    const executable = path.join(workspace, 'run.command');
    writeFileSync(executable, '#!/bin/sh\ntrue\n', { mode: 0o755 });

    await expect(
      resolveSessionFile({
        appDataDir: root,
        userId: 'user-a',
        sessionId: 'session-a',
        target: 'run.command',
      }),
    ).rejects.toThrow();
  });
});
