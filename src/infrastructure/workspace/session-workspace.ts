import { cp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export interface SessionWorkspaceScope {
  userId: string;
  sessionId: string;
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
