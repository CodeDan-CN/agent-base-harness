import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { SandboxMode } from '../../shared/domain/permission';

export class ProcessRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessRunError';
  }
}

export interface ProcessRunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  sandbox?: {
    mode: SandboxMode;
    writableRoots: string[];
    allowNetwork?: boolean;
  };
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

const DEFAULT_ALLOWED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PYTHONNOUSERSITE',
  'PIP_DISABLE_PIP_VERSION_CHECK',
  'AGENT_WORKSPACE',
  'AGENT_ARTIFACTS_DIR',
];

function isInside(rootDir: string, target: string): boolean {
  const rel = path.relative(rootDir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realPathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Worker 内部受控子进程执行器。使用 executable + args（不 shell 拼接），
 * 环境变量 allowlist，cwd 必须落在受控根内，支持 timeout / cancel / 有界输出。
 */
export class ProcessRunner {
  private readonly allowedRoots: string[];
  private readonly allowedEnvKeys: string[];
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(opts: {
    allowedRoots: string[];
    allowedEnvKeys?: string[];
    defaultTimeoutMs?: number;
    defaultMaxOutputBytes?: number;
  }) {
    this.allowedRoots = opts.allowedRoots.map((root) => realPathOf(path.resolve(root)));
    this.allowedEnvKeys = opts.allowedEnvKeys ?? DEFAULT_ALLOWED_ENV;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000;
    this.defaultMaxOutputBytes = opts.defaultMaxOutputBytes ?? 1024 * 1024;
  }

  run(opts: ProcessRunOptions): Promise<ProcessResult> {
    const cwd = realPathOf(path.resolve(opts.cwd));
    const cwdAllowed = this.allowedRoots.some((root) => isInside(root, cwd));
    if (!cwdAllowed) {
      return Promise.reject(new ProcessRunError('Working directory is outside the allowed roots'));
    }

    for (const key of Object.keys(opts.env ?? {})) {
      if (!this.allowedEnvKeys.includes(key)) {
        return Promise.reject(new ProcessRunError('Environment key is not in the allowlist'));
      }
    }

    const env: Record<string, string> = {};
    for (const key of this.allowedEnvKeys) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      env[k] = v;
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = opts.maxOutputBytes ?? this.defaultMaxOutputBytes;

    return new Promise<ProcessResult>((resolve, reject) => {
      const sandboxed = sandboxCommand(opts);
      const child = spawn(sandboxed.cmd, sandboxed.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const killTree = () => {
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // Fall back to the direct child below.
          }
        }
        child.kill('SIGKILL');
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      const onAbort = () => {
        cancelled = true;
        killTree();
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutTruncated) return;
        const text = chunk.toString('utf8');
        if (stdout.length + text.length > maxOutputBytes) {
          stdout += text.slice(0, maxOutputBytes - stdout.length);
          stdoutTruncated = true;
        } else {
          stdout += text;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrTruncated) return;
        const text = chunk.toString('utf8');
        if (stderr.length + text.length > maxOutputBytes) {
          stderr += text.slice(0, maxOutputBytes - stderr.length);
          stderrTruncated = true;
        } else {
          stderr += text;
        }
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (err.code === 'ENOENT') {
          reject(new ProcessRunError('Command not found'));
        } else {
          reject(new ProcessRunError('Process failed to start'));
        }
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          timedOut,
          cancelled,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  }
}

function sandboxCommand(opts: ProcessRunOptions): { cmd: string; args: string[] } {
  if (!opts.sandbox || opts.sandbox.mode === 'danger-full-access') {
    return { cmd: opts.cmd, args: opts.args };
  }
  if (process.platform !== 'darwin') {
    throw new ProcessRunError('Restricted sandbox is unavailable on this platform');
  }
  const writable = opts.sandbox.writableRoots
    .map((root) => '(allow file-write* (subpath ' + seatbeltString(realPathOf(root)) + '))')
    .join('\n');
  const profile = [
    '(version 1)',
    '(allow default)',
    opts.sandbox.allowNetwork === false ? '(deny network*)' : '',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/dtracehelper"))',
    writable,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    cmd: '/usr/bin/sandbox-exec',
    args: ['-p', profile, opts.cmd, ...opts.args],
  };
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}
