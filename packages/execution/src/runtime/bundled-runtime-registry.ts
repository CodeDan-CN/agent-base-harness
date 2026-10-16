import { accessSync, readFileSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

export interface BundledRuntimeSnapshot {
  platform: string;
  arch: string;
  rootDir: string;
  binDir: string;
  node: {
    version: string;
    executable: string;
  };
  python: {
    version: string;
    executable: string;
  };
  mcp: {
    memory: {
      package: string;
      version: string;
      entrypoint: string;
    };
  };
}

interface RuntimeManifest {
  schemaVersion: 1;
  target: { platform: string; arch: string };
  node: { version: string; executable: string };
  python: { version: string; executable: string };
  mcp: {
    memory: { package: string; version: string; entrypoint: string };
  };
  binDir: string;
}

export class BundledRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundledRuntimeError';
  }
}

export function loadBundledRuntime(
  rootDir: string,
  options: { platform?: string; arch?: string; required?: boolean } = {},
): BundledRuntimeSnapshot | null {
  const required = options.required ?? false;
  try {
    const manifestPath = path.join(rootDir, 'runtime-manifest.json');
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const expectedPlatform = options.platform ?? process.platform;
    const expectedArch = options.arch ?? process.arch;
    if (manifest.target.platform !== expectedPlatform || manifest.target.arch !== expectedArch) {
      throw new BundledRuntimeError(
        `Runtime Pack target ${manifest.target.platform}-${manifest.target.arch} does not match ${expectedPlatform}-${expectedArch}`,
      );
    }
    const binDir = resolveInside(rootDir, manifest.binDir);
    const nodeExecutable = resolveInside(rootDir, manifest.node.executable);
    const pythonExecutable = resolveInside(rootDir, manifest.python.executable);
    const memoryMcpEntrypoint = resolveInside(rootDir, manifest.mcp.memory.entrypoint);
    accessSync(binDir, fsConstants.R_OK | fsConstants.X_OK);
    accessSync(nodeExecutable, fsConstants.R_OK | fsConstants.X_OK);
    accessSync(pythonExecutable, fsConstants.R_OK | fsConstants.X_OK);
    accessSync(memoryMcpEntrypoint, fsConstants.R_OK);
    return {
      platform: manifest.target.platform,
      arch: manifest.target.arch,
      rootDir: path.resolve(rootDir),
      binDir,
      node: { version: manifest.node.version, executable: nodeExecutable },
      python: { version: manifest.python.version, executable: pythonExecutable },
      mcp: {
        memory: {
          package: manifest.mcp.memory.package,
          version: manifest.mcp.memory.version,
          entrypoint: memoryMcpEntrypoint,
        },
      },
    };
  } catch (error) {
    if (required) {
      if (error instanceof BundledRuntimeError) throw error;
      throw new BundledRuntimeError(
        `Bundled Runtime Pack is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    return null;
  }
}

function parseManifest(value: unknown): RuntimeManifest {
  if (typeof value !== 'object' || value === null) {
    throw new BundledRuntimeError('Runtime Pack manifest must be an object');
  }
  const candidate = value as Partial<RuntimeManifest>;
  if (
    candidate.schemaVersion !== 1 ||
    !isTarget(candidate.target) ||
    !isRuntime(candidate.node) ||
    !isRuntime(candidate.python) ||
    !isMcp(candidate.mcp) ||
    typeof candidate.binDir !== 'string'
  ) {
    throw new BundledRuntimeError('Runtime Pack manifest is invalid');
  }
  return candidate as RuntimeManifest;
}

function isMcp(value: unknown): value is RuntimeManifest['mcp'] {
  if (typeof value !== 'object' || value === null) return false;
  const memory = (value as Partial<RuntimeManifest['mcp']>).memory;
  return (
    typeof memory === 'object' &&
    memory !== null &&
    typeof memory.package === 'string' &&
    typeof memory.version === 'string' &&
    typeof memory.entrypoint === 'string'
  );
}

function isTarget(value: unknown): value is RuntimeManifest['target'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RuntimeManifest['target']).platform === 'string' &&
    typeof (value as RuntimeManifest['target']).arch === 'string'
  );
}

function isRuntime(value: unknown): value is RuntimeManifest['node'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RuntimeManifest['node']).version === 'string' &&
    typeof (value as RuntimeManifest['node']).executable === 'string'
  );
}

function resolveInside(rootDir: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new BundledRuntimeError('Runtime Pack paths must be relative');
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BundledRuntimeError('Runtime Pack path escapes its root');
  }
  return target;
}
