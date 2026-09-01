import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { sessionWorkspacePath } from '../workspace/session-workspace';

export class ScopedFileSystemError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ScopedFileSystemError';
  }
}

export interface FileScope {
  userId: string;
  sessionId: string;
}

export interface FileAccessOptions {
  allowOutsideWorkspace?: boolean;
}

export interface ReadFileResult {
  path: string;
  content: string;
  offset: number;
  limit: number;
  totalLines: number;
  truncated: boolean;
  version: string;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
  created: boolean;
  version: string;
}

export interface EditFileResult extends WriteFileResult {
  replacements: number;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 2_000;

export class ScopedFileSystem {
  private readonly observations = new Map<string, string>();

  constructor(private readonly appDataDir: string) {}

  workspace(scope: FileScope): string {
    return sessionWorkspacePath(this.appDataDir, scope);
  }

  async read(
    scope: FileScope,
    filePath: string,
    offset = 1,
    limit = 200,
    access: FileAccessOptions = {},
  ): Promise<ReadFileResult> {
    const resolved = await this.resolve(
      scope,
      filePath,
      false,
      access.allowOutsideWorkspace ?? false,
    );
    const metadata = await lstat(resolved.absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ScopedFileSystemError('FILE_NOT_REGULAR');
    }
    if (metadata.size > MAX_FILE_BYTES) throw new ScopedFileSystemError('FILE_TOO_LARGE');
    const content = await readFile(resolved.absolute, 'utf8');
    const version = digest(content);
    this.observations.set(this.observationKey(scope, resolved.absolute), version);
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, offset - 1);
    const selected = lines.slice(start, start + Math.min(limit, MAX_READ_LINES));
    return {
      path: resolved.display,
      content: selected.map((line, index) => `${start + index + 1}: ${line}`).join('\n'),
      offset: start + 1,
      limit: Math.min(limit, MAX_READ_LINES),
      totalLines: lines.length,
      truncated: start + selected.length < lines.length,
      version,
    };
  }

  async write(
    scope: FileScope,
    filePath: string,
    content: string,
    access: FileAccessOptions = {},
  ): Promise<WriteFileResult> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new ScopedFileSystemError('FILE_TOO_LARGE');
    }
    const resolved = await this.resolve(
      scope,
      filePath,
      true,
      access.allowOutsideWorkspace ?? false,
    );
    const existing = await this.readExisting(resolved.absolute);
    if (existing !== null) this.assertObserved(scope, resolved.absolute, digest(existing));
    await this.atomicWrite(resolved.absolute, content);
    const version = digest(content);
    this.observations.set(this.observationKey(scope, resolved.absolute), version);
    return {
      path: resolved.display,
      bytes: Buffer.byteLength(content),
      created: existing === null,
      version,
    };
  }

  async edit(
    scope: FileScope,
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    access: FileAccessOptions = {},
  ): Promise<EditFileResult> {
    const resolved = await this.resolve(
      scope,
      filePath,
      false,
      access.allowOutsideWorkspace ?? false,
    );
    const content = await this.readExisting(resolved.absolute);
    if (content === null) throw new ScopedFileSystemError('FILE_NOT_FOUND');
    this.assertObserved(scope, resolved.absolute, digest(content));
    const matches = countOccurrences(content, oldString);
    if (matches === 0) throw new ScopedFileSystemError('EDIT_TEXT_NOT_FOUND');
    if (!replaceAll && matches !== 1) throw new ScopedFileSystemError('EDIT_TEXT_NOT_UNIQUE');
    const next = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new ScopedFileSystemError('FILE_TOO_LARGE');
    await this.atomicWrite(resolved.absolute, next);
    const version = digest(next);
    this.observations.set(this.observationKey(scope, resolved.absolute), version);
    return {
      path: resolved.display,
      bytes: Buffer.byteLength(next),
      created: false,
      replacements: replaceAll ? matches : 1,
      version,
    };
  }

  private async resolve(
    scope: FileScope,
    requested: string,
    allowMissing: boolean,
    allowOutsideWorkspace: boolean,
  ): Promise<{ absolute: string; display: string }> {
    const configuredRoot = this.workspace(scope);
    await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const absolute = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(root, requested);
    const outsideWorkspace = !isInside(root, absolute);
    if (outsideWorkspace && !allowOutsideWorkspace) {
      throw new ScopedFileSystemError('PATH_NOT_ALLOWED');
    }
    if (!allowMissing) {
      const canonical = await canonicalExisting(absolute);
      if (!isInside(root, canonical) && !allowOutsideWorkspace) {
        throw new ScopedFileSystemError('PATH_NOT_ALLOWED');
      }
      return {
        absolute: canonical,
        display: isInside(root, canonical) ? path.relative(root, canonical) || '.' : canonical,
      };
    }
    const parent = path.dirname(absolute);
    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    if (!isInside(root, canonicalParent) && !allowOutsideWorkspace) {
      throw new ScopedFileSystemError('PATH_NOT_ALLOWED');
    }
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new ScopedFileSystemError('PATH_NOT_ALLOWED');
      const canonicalTarget = await realpath(absolute);
      if (!isInside(root, canonicalTarget) && !allowOutsideWorkspace) {
        throw new ScopedFileSystemError('PATH_NOT_ALLOWED');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return {
      absolute: path.join(canonicalParent, path.basename(absolute)),
      display: isInside(root, absolute) ? path.relative(root, absolute) || '.' : absolute,
    };
  }

  isOutsideWorkspace(scope: FileScope, requested: string): boolean {
    if (!path.isAbsolute(requested)) return false;
    return !isInside(this.workspace(scope), path.resolve(requested));
  }

  private async readExisting(target: string): Promise<string | null> {
    try {
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new ScopedFileSystemError('FILE_NOT_REGULAR');
      if (metadata.size > MAX_FILE_BYTES) throw new ScopedFileSystemError('FILE_TOO_LARGE');
      return await readFile(target, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private assertObserved(scope: FileScope, target: string, currentVersion: string): void {
    const observed = this.observations.get(this.observationKey(scope, target));
    if (!observed) throw new ScopedFileSystemError('FILE_NOT_READ');
    if (observed !== currentVersion) throw new ScopedFileSystemError('FILE_CHANGED_SINCE_READ');
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  private observationKey(scope: FileScope, target: string): string {
    return `${scope.userId}\0${scope.sessionId}\0${path.resolve(target)}`;
  }
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(search, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + search.length;
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonicalExisting(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (isMissing(error)) throw new ScopedFileSystemError('FILE_NOT_FOUND');
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
