import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ensureSessionWorkspace } from '../workspace/session-workspace';
import type { ProcessResult, ProcessRunner } from './process-runner';

export class ShellExecutionError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ShellExecutionError';
  }
}

export interface ShellExecutionResult extends ProcessResult {
  cwd: string;
  command: string;
  locations: Array<{ path: string }>;
}

export class ShellExecutor {
  constructor(
    private readonly appDataDir: string,
    private readonly processRunner: ProcessRunner,
    private readonly runtimeBinDir?: string,
  ) {}

  async execute(input: {
    userId: string;
    sessionId: string;
    command: string;
    workdir?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<ShellExecutionResult> {
    const { workspace, artifacts } = await ensureSessionWorkspace(this.appDataDir, input);
    const cwd = await this.resolveWorkdir(workspace, input.workdir);
    const before = await artifactSnapshot(artifacts);
    const result = await this.processRunner.run({
      cmd: '/bin/bash',
      args: ['-c', input.command],
      cwd,
      env: this.executionEnvironment(workspace, artifacts),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const after = await artifactSnapshot(artifacts);
    const locations = [...after]
      .filter(([relative, signature]) => before.get(relative) !== signature)
      .map(([relative]) => ({ path: `artifacts/${relative}` }));
    return { ...result, cwd, command: input.command, locations };
  }

  private executionEnvironment(workspace: string, artifacts: string): Record<string, string> {
    const pathEntries = [
      this.runtimeBinDir,
      ...(process.env.PATH ?? '').split(path.delimiter),
    ].filter((entry): entry is string => Boolean(entry));
    return {
      PATH: [...new Set(pathEntries)].join(path.delimiter),
      PYTHONNOUSERSITE: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      AGENT_WORKSPACE: workspace,
      AGENT_ARTIFACTS_DIR: artifacts,
    };
  }

  private async resolveWorkdir(workspace: string, requested?: string): Promise<string> {
    if (!requested) return realpath(workspace);
    const target = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(workspace, requested);
    if (!isInside(workspace, target))
      throw new ShellExecutionError('WORKING_DIRECTORY_NOT_ALLOWED');
    await mkdir(target, { recursive: true });
    const [realWorkspace, realTarget] = await Promise.all([realpath(workspace), realpath(target)]);
    if (!isInside(realWorkspace, realTarget)) {
      throw new ShellExecutionError('WORKING_DIRECTORY_NOT_ALLOWED');
    }
    return realTarget;
  }
}

async function artifactSnapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await lstat(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      files.set(relative, `${metadata.size}:${metadata.mtimeMs}`);
    }
  };
  await visit(root);
  return files;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
