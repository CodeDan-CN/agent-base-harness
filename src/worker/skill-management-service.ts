import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import { contentDigestOf, parseSkillDirectory } from '../infrastructure/skills/parser';
import { BridgeError } from '../shared/contracts/errors';
import {
  skillDescriptionUpdateParamsSchema,
  type SkillDescriptionUpdateParams,
} from '../shared/contracts/management';
import type { Clock } from '../shared/domain/ports';
import type { LocalUserId } from '../shared/domain/user';

export class SkillManagementService {
  constructor(
    private readonly deps: {
      repos: SqliteRepositories;
      clock: Clock;
      appDataDir: string;
      skillRoot: (userId: LocalUserId) => string;
    },
  ) {}

  updateDescription(userId: LocalUserId, raw: SkillDescriptionUpdateParams): { skillName: string } {
    const parsedInput = skillDescriptionUpdateParamsSchema.safeParse(raw);
    if (!parsedInput.success) throw new BridgeError('INVALID_REQUEST', 'Invalid Skill description');
    const input = parsedInput.data;
    const installation = this.mutableInstallation(userId, input.skillName, input.expectedRevision);
    const root = this.managedDirectory(userId, installation.rootPath, input.skillName);
    const file = path.join(root, 'SKILL.md');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid Skill file');
    }
    const original = readFileSync(file);
    if (contentDigestOf(original) !== installation.contentDigest) {
      throw new BridgeError('REVISION_CONFLICT', 'Skill file changed; refresh before editing');
    }
    const content = replaceDescription(original.toString('utf8'), input.description);
    if (content === original.toString('utf8')) return { skillName: input.skillName };
    const temporary = path.join(root, `.description-${randomUUID()}.tmp`);
    let replaced = false;
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: stat.mode & 0o777 });
      renameSync(temporary, file);
      replaced = true;
      const parsed = parseSkillDirectory(root);
      if (!parsed.ok || parsed.skill.description !== input.description) {
        throw new BridgeError('INVALID_REQUEST', 'Skill description could not be updated');
      }
      this.deps.repos.skills.upsertInstallation({
        ...installation,
        description: parsed.skill.description,
        contentDigest: parsed.skill.contentDigest,
        now: this.deps.clock.nowIso(),
      });
    } catch (error) {
      if (replaced) {
        writeFileSync(temporary, original, { flag: 'wx', mode: stat.mode & 0o777 });
        renameSync(temporary, file);
      }
      throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
    return { skillName: input.skillName };
  }

  delete(userId: LocalUserId, skillName: string, expectedRevision: number): { skillName: string } {
    const installation = this.mutableInstallation(userId, skillName, expectedRevision);
    const root = this.managedDirectory(userId, installation.rootPath, skillName, true);
    if (statExists(root)) rmSync(root, { recursive: true });
    // 文件删除成功后再移除登记；数据库失败时保留记录，允许刷新后重试清理。
    this.deps.repos.skills.deleteInstallation(userId, skillName, this.deps.clock.nowIso());
    return { skillName };
  }

  private mutableInstallation(userId: LocalUserId, skillName: string, expectedRevision: number) {
    if (this.deps.repos.users.getRevisions(userId).skillRevision !== expectedRevision) {
      throw new BridgeError('REVISION_CONFLICT', 'Skill configuration changed');
    }
    const installation = this.deps.repos.skills.getInstallation(userId, skillName);
    if (!installation || installation.sourceType === 'bundled') {
      throw new BridgeError('INVALID_REQUEST', 'Skill is missing or built-in');
    }
    return installation;
  }

  private managedDirectory(
    userId: LocalUserId,
    registered: string,
    name: string,
    allowMissing = false,
  ) {
    const managedRoot = path.resolve(this.deps.skillRoot(userId));
    const expected = path.join(managedRoot, name);
    const relativeRoot = path.relative(path.resolve(this.deps.appDataDir), managedRoot);
    const canonicalRoot = path.join(realpathSync(this.deps.appDataDir), relativeRoot);
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[/\\]/.test(name) ||
      relativeRoot.startsWith('..') ||
      path.isAbsolute(relativeRoot) ||
      (path.resolve(registered) !== expected &&
        path.resolve(registered) !== path.join(canonicalRoot, name))
    ) {
      throw new BridgeError('INVALID_REQUEST', 'Skill path is outside the managed directory');
    }
    const rootStat = statExists(managedRoot);
    if (!rootStat) {
      if (allowMissing) return expected;
      throw new BridgeError('INVALID_REQUEST', 'Skill directory is missing');
    }
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      realpathSync(managedRoot) !== canonicalRoot
    ) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid managed Skill directory');
    }
    const stat = statExists(expected);
    if (!stat && allowMissing) return expected;
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(expected) !== path.join(realpathSync(managedRoot), name)
    ) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid managed Skill path');
    }
    return expected;
  }
}

function statExists(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function replaceDescription(content: string, description: string): string {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new BridgeError('INVALID_REQUEST', 'Skill frontmatter is missing');
  const newline = content.startsWith('---\r\n') ? '\r\n' : '\n';
  const lines = frontmatter[1]!.split(/\r?\n/);
  const positions = lines.flatMap((line, index) => (/^description\s*:/.test(line) ? [index] : []));
  if (positions.length !== 1)
    throw new BridgeError('INVALID_REQUEST', 'Skill description must be unique');
  const index = positions[0]!;
  let end = index + 1;
  // 移除旧块标量/折行标量的延续行，保留其他顶层字段及正文。
  while (end < lines.length && (/^\s+\S/.test(lines[end]!) || !lines[end]!.trim())) end += 1;
  lines.splice(index, end - index, `description: ${JSON.stringify(description)}`);
  const header = frontmatter[0].replace(frontmatter[1]!, lines.join(newline));
  return header + content.slice(frontmatter[0].length);
}
