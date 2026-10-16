import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessRunner, ProcessRunError } from '../../packages/execution/src/process/process-runner';
import type { ProcessResult } from '../../packages/execution/src/process/process-runner';
import { EnvironmentDetector } from '../../packages/execution/src/process/environment-detector';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

const node = process.execPath;

describe('M11 ProcessRunner', () => {
  let root: string;
  let runner: ProcessRunner;

  beforeEach(() => {
    root = makeTempDir();
    runner = new ProcessRunner({ allowedRoots: [root] });
  });

  afterEach(() => {
    cleanupDir(root);
  });

  function runScript(script: string, opts: Partial<Parameters<ProcessRunner['run']>[0]> = {}) {
    return runner.run({ cmd: node, args: ['-e', script], cwd: root, ...opts });
  }

  it('S1-M11-004 非零退出返回 exitCode', async () => {
    const result = await runScript('process.exit(3)');
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('S1-M11-007 stdout/stderr 分别采集', async () => {
    const result = await runScript("console.log('OUT'); console.error('ERR')");
    expect(result.stdout).toContain('OUT');
    expect(result.stderr).toContain('ERR');
    expect(result.stdout).not.toContain('ERR');
  });

  it('S1-M11-005 timeout 到时终止进程', async () => {
    const result = await runScript('setTimeout(()=>{}, 10000)', { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });

  it('S1-M11-006 AbortSignal 取消终止进程', async () => {
    const controller = new AbortController();
    const promise = runScript('setTimeout(()=>{}, 10000)', { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(result.cancelled).toBe(true);
  });

  it('S1-M11-008 超大输出被截断并带 truncated 标记', async () => {
    const result = await runScript("console.log('x'.repeat(10000))", { maxOutputBytes: 100 });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100);
  });

  it('S1-M11-009 环境变量 allowlist：哨兵变量不传入子进程', async () => {
    process.env.AGENT_TEST_SENTINEL = 'topsecret';
    try {
      const result = await runScript("console.log(process.env.AGENT_TEST_SENTINEL ?? 'ABSENT')");
      expect(result.stdout).toContain('ABSENT');
      expect(result.stdout).not.toContain('topsecret');
    } finally {
      delete process.env.AGENT_TEST_SENTINEL;
    }
  });

  it('S1-M11-010 cwd 越界被拒绝且不启动进程', async () => {
    const outside = makeTempDir();
    try {
      await expect(runner.run({ cmd: node, args: ['-e', '1'], cwd: outside })).rejects.toThrow(
        ProcessRunError,
      );
    } finally {
      cleanupDir(outside);
    }
  });

  it('S1-M11-012 参数含空格作为单独 argv，不做 shell 拼接', async () => {
    const result = await runner.run({
      cmd: node,
      args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'hello world'],
      cwd: root,
    });
    expect(JSON.parse(result.stdout.trim())).toEqual(['hello world']);
  });

  it('S1-M11-013 executable 不存在返回稳定 process error', async () => {
    await expect(
      runner.run({ cmd: 'definitely-not-a-real-command-xyz', args: [], cwd: root }),
    ).rejects.toThrow(new ProcessRunError('Command not found'));
  });
});

describe('M11 EnvironmentDetector', () => {
  it('S1-M11-001 Node 可用探测', async () => {
    const root = makeTempDir();
    try {
      const runner = new ProcessRunner({ allowedRoots: [root] });
      const detector = new EnvironmentDetector(runner, {}, root);
      const result = await detector.detect();
      expect(result.node.status).toBe('available');
      expect(result.node.version).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      cleanupDir(root);
    }
  });

  it('S1-M11-002 Python 按顺序回退', async () => {
    const order: string[] = [];
    const fakeRunner = {
      async run(opts: { cmd: string; args: string[] }): Promise<ProcessResult> {
        order.push(opts.cmd);
        if (opts.cmd === 'python3') throw new ProcessRunError('Command not found');
        return {
          exitCode: 0,
          signal: null,
          stdout: 'Python 3.12.1',
          stderr: '',
          timedOut: false,
          cancelled: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    };
    const detector = new EnvironmentDetector(
      fakeRunner,
      { pythonPaths: ['python3', 'python'] },
      '/tmp',
    );
    const result = await detector.detect();
    expect(result.python.status).toBe('available');
    expect(result.python.version).toBe('3.12.1');
    expect(order).toContain('python3');
    expect(order).toContain('python');
  });

  it('S1-M11-003 解释器全部缺失返回 missing，不抛错', async () => {
    const fakeRunner = {
      async run(): Promise<ProcessResult> {
        throw new ProcessRunError('Command not found');
      },
    };
    const detector = new EnvironmentDetector(fakeRunner, {}, '/tmp');
    const result = await detector.detect();
    expect(result.node.status).toBe('missing');
    expect(result.python.status).toBe('missing');
  });

  it('S1-M11-014 探测结果不泄漏绝对路径', async () => {
    const root = makeTempDir();
    try {
      const runner = new ProcessRunner({ allowedRoots: [root] });
      const detector = new EnvironmentDetector(runner, {}, root);
      const result = await detector.detect();
      expect(JSON.stringify(result)).not.toContain(node);
    } finally {
      cleanupDir(root);
    }
  });
});
