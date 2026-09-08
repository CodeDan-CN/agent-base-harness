import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const AGENT_MEMORY_PROFILE_FILENAME = 'memory-profile.md';

export function agentMemoryProfilePath(
  appDataDir: string,
  userId: string,
  agentId: string,
): string {
  return path.join(
    appDataDir,
    'users',
    encodeURIComponent(userId),
    'agents',
    encodeURIComponent(agentId),
    AGENT_MEMORY_PROFILE_FILENAME,
  );
}

export function ensureAgentMemoryProfile(
  appDataDir: string,
  userId: string,
  agentId: string,
  initialContent = '',
): string {
  const filePath = agentMemoryProfilePath(appDataDir, userId, agentId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    writeFileSync(filePath, initialContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  return filePath;
}

export function readAgentMemoryProfile(
  appDataDir: string,
  userId: string,
  agentId: string,
): string {
  try {
    return readFileSync(agentMemoryProfilePath(appDataDir, userId, agentId), 'utf8').trim();
  } catch (error) {
    if (isMissing(error)) return '';
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, 'EEXIST');
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}
