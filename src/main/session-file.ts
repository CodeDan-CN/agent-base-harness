import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { sessionWorkspacePath } from '../infrastructure/workspace/session-workspace';
import { BridgeError } from '../shared/contracts/errors';

const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.exe',
  '.jar',
  '.msi',
  '.ps1',
  '.scr',
]);

export async function resolveSessionFile(input: {
  appDataDir: string;
  userId: string;
  sessionId: string;
  target: string;
}): Promise<string> {
  const target = decodeSessionTarget(input.target);
  const workspace = sessionWorkspacePath(input.appDataDir, input);
  const candidate = path.resolve(workspace, target);
  if (!isInside(workspace, candidate)) {
    throw new BridgeError('INVALID_REQUEST', 'File path is outside the Session workspace');
  }
  try {
    const [realWorkspace, realCandidate] = await Promise.all([
      realpath(workspace),
      realpath(candidate),
    ]);
    if (!isInside(realWorkspace, realCandidate)) {
      throw new BridgeError('INVALID_REQUEST', 'File path is outside the Session workspace');
    }
    const metadata = await stat(realCandidate);
    if (!metadata.isFile()) throw new BridgeError('INVALID_REQUEST', 'Target is not a file');
    if ((metadata.mode & 0o111) !== 0) {
      throw new BridgeError('INVALID_REQUEST', 'Executable files cannot be opened');
    }
    if (BLOCKED_EXECUTABLE_EXTENSIONS.has(path.extname(realCandidate).toLowerCase())) {
      throw new BridgeError('INVALID_REQUEST', 'Executable files cannot be opened');
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('INVALID_REQUEST', 'File does not exist');
  }
}

function decodeSessionTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    throw new BridgeError('INVALID_REQUEST', 'Invalid file path');
  }
  const pathname = trimmed.split(/[?#]/, 1)[0] ?? '';
  try {
    const decoded = decodeURIComponent(pathname).replaceAll('\\', '/');
    if (!decoded || path.posix.isAbsolute(decoded)) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid file path');
    }
    return path.posix.normalize(decoded).replace(/^\.\//, '');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('INVALID_REQUEST', 'Invalid file path');
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
