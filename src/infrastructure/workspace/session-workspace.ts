import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export interface SessionWorkspaceScope {
  userId: string;
  sessionId: string;
}

export const USER_MEMORY_PROFILE_FILENAME = 'memory-profile.md';

export function userMemoryProfilePath(appDataDir: string, userId: string): string {
  return path.join(appDataDir, 'workspaces', userId, USER_MEMORY_PROFILE_FILENAME);
}

export function ensureUserMemoryProfile(appDataDir: string, userId: string): string {
  const filePath = userMemoryProfilePath(appDataDir, userId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    writeFileSync(filePath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  return filePath;
}

export function readUserMemoryProfile(appDataDir: string, userId: string): string {
  try {
    return readFileSync(userMemoryProfilePath(appDataDir, userId), 'utf8').trim();
  } catch (error) {
    if (isMissing(error)) return '';
    throw error;
  }
}

export function sessionWorkspacePath(appDataDir: string, scope: SessionWorkspaceScope): string {
  return path.join(appDataDir, 'workspaces', scope.userId, scope.sessionId);
}

export function sessionArtifactsPath(appDataDir: string, scope: SessionWorkspaceScope): string {
  return path.join(sessionWorkspacePath(appDataDir, scope), 'artifacts');
}

export async function ensureSessionWorkspace(
  appDataDir: string,
  scope: SessionWorkspaceScope,
): Promise<{ workspace: string; artifacts: string }> {
  const workspace = sessionWorkspacePath(appDataDir, scope);
  const artifacts = sessionArtifactsPath(appDataDir, scope);
  await mkdir(artifacts, { recursive: true });
  return {
    workspace: await realpath(workspace),
    artifacts: await realpath(artifacts),
  };
}

export async function materializeSkillResourceBase(input: {
  appDataDir: string;
  scope: SessionWorkspaceScope;
  skillName: string;
  sourceRoot: string;
}): Promise<string> {
  const { workspace } = await ensureSessionWorkspace(input.appDataDir, input.scope);
  const resourcesRoot = path.join(workspace, '.skill-resources');
  const target = path.join(resourcesRoot, encodeURIComponent(input.skillName));
  const source = await realpath(input.sourceRoot);
  await rm(target, { recursive: true, force: true });
  await mkdir(resourcesRoot, { recursive: true });
  await cp(source, target, { recursive: true, dereference: false });
  return realpath(target);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EEXIST'
  );
}
