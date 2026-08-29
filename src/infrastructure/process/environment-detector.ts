import type { InterpreterStatus } from '../../shared/contracts/health';
import { ProcessRunner, ProcessRunError } from './process-runner';
import type { ProcessResult } from './process-runner';

export interface InterpreterProbe {
  status: InterpreterStatus;
  version: string | null;
  source: 'bundled' | 'system' | null;
  arch: string | null;
}

export interface EnvironmentDetectionConfig {
  nodePath?: string;
  nodeSource?: 'bundled' | 'system';
  pythonPaths?: string[];
  pythonSource?: 'bundled' | 'system';
  shellPath?: string;
  allowSystemFallback?: boolean;
}

interface NamedRunner {
  run(opts: {
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs?: number;
  }): Promise<ProcessResult>;
}

function parseNodeVersion(stdout: string): string | null {
  const m = stdout.match(/v?(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

function parsePythonVersion(stdout: string, stderr: string): string | null {
  const m = `${stdout}\n${stderr}`.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/);
  return m?.[1] ?? null;
}

function parseShellVersion(stdout: string): string | null {
  const first = stdout.split('\n')[0]?.trim();
  return first && first.length > 0 && first.length < 200 ? first : null;
}

/**
 * 宿主机解释器探测：Node / Python / Shell。跟随配置路径回退，缺失不阻塞。
 */
export class EnvironmentDetector {
  private readonly runner: NamedRunner;
  private readonly config: EnvironmentDetectionConfig;
  private readonly cwd: string;

  constructor(
    runner: NamedRunner,
    config: EnvironmentDetectionConfig = {},
    cwd: string = process.cwd(),
  ) {
    this.runner = runner;
    this.config = config;
    this.cwd = cwd;
  }

  async detect(): Promise<{
    node: InterpreterProbe;
    python: InterpreterProbe;
    shell: InterpreterProbe;
  }> {
    const [node, python, shell] = await Promise.all([
      this.detectNode(),
      this.detectPython(),
      this.detectShell(),
    ]);
    return { node, python, shell };
  }

  private async detectNode(): Promise<InterpreterProbe> {
    const candidates = [
      this.config.nodePath,
      ...(this.config.allowSystemFallback === false ? [] : ['node']),
    ].filter((c): c is string => !!c);
    for (const cmd of candidates) {
      try {
        const result = await this.runner.run({
          cmd,
          args: ['--version'],
          cwd: this.cwd,
          timeoutMs: 5000,
        });
        if (result.exitCode === 0) {
          const version = parseNodeVersion(result.stdout);
          if (version) {
            return {
              status: 'available',
              version,
              source:
                cmd === this.config.nodePath ? (this.config.nodeSource ?? 'system') : 'system',
              arch: process.arch,
            };
          }
        }
      } catch (err) {
        if (!(err instanceof ProcessRunError)) throw err;
      }
    }
    return { status: 'missing', version: null, source: null, arch: null };
  }

  private async detectPython(): Promise<InterpreterProbe> {
    const candidates = [
      ...new Set([
        ...(this.config.pythonPaths ?? []),
        ...(this.config.allowSystemFallback === false ? [] : ['python3', 'python']),
      ]),
    ];
    for (const cmd of candidates) {
      try {
        const result = await this.runner.run({
          cmd,
          args: ['--version'],
          cwd: this.cwd,
          timeoutMs: 5000,
        });
        const version = parsePythonVersion(result.stdout, result.stderr);
        if (version) {
          return {
            status: 'available',
            version,
            source: this.config.pythonPaths?.includes(cmd)
              ? (this.config.pythonSource ?? 'system')
              : 'system',
            arch: process.arch,
          };
        }
      } catch (err) {
        if (!(err instanceof ProcessRunError)) throw err;
      }
    }
    return { status: 'missing', version: null, source: null, arch: null };
  }

  private async detectShell(): Promise<InterpreterProbe> {
    const candidate = this.config.shellPath ?? process.env.SHELL;
    if (!candidate) {
      return { status: 'unsupported', version: null, source: null, arch: null };
    }
    try {
      const result = await this.runner.run({
        cmd: candidate,
        args: ['--version'],
        cwd: this.cwd,
        timeoutMs: 5000,
      });
      if (result.exitCode === 0) {
        return {
          status: 'available',
          version: parseShellVersion(result.stdout),
          source: 'system',
          arch: process.arch,
        };
      }
      return { status: 'unsupported', version: null, source: null, arch: null };
    } catch (err) {
      if (err instanceof ProcessRunError) {
        return { status: 'missing', version: null, source: null, arch: null };
      }
      throw err;
    }
  }
}

export { ProcessRunner, ProcessRunError };
export type { ProcessResult };
