import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SqliteRepositories } from '../sqlite/repositories';
import type { Clock, IdProvider } from '../../shared/domain/ports';
import type { LocalUserId } from '../../shared/domain/user';
import { parseSkillDirectory } from './parser';

export const BUILTIN_SKILL_CREATOR_NAME = 'skill-creator';

export const BUILTIN_SKILL_CREATOR_CONTENT = `---
name: skill-creator
description: 将用户明确要求长期复用的 SOP、流程或方法沉淀为用户级 Skill；不用于保存普通偏好或事实。
---

# Skill Creator

把可重复执行的方法整理成简洁、可触发、可维护的 Skill。

## 何时使用

- 用户明确要求创建、沉淀或长期复用一个 SOP、流程、方法或工作规范时使用。
- 普通偏好、事实和约束应写入长期记忆，不要创建 Skill。
- 只对当前任务有用的一次性内容不要创建 Skill。

## 发布规则

1. 使用小写英文、数字和连字符命名，名称不超过 64 个字符。
2. description 同时说明能力与触发条件，避免只复述当前示例。
3. instructions 只保留可复用步骤、判断标准、输入输出和必要约束；移除当前任务专属事实。
4. 默认创建纯文本 Skill。没有明确必要性时，不生成脚本、参考资料或素材目录。
5. 调用 skill_publish 发布。只有工具返回成功后，才可以告诉用户 Skill 已创建并启用。
6. 名称冲突时不要覆盖已有 Skill；说明冲突并请用户决定是否换名。
`;

export interface PublishGeneratedSkillInput {
  name: string;
  description: string;
  instructions: string;
}

export interface PublishGeneratedSkillResult {
  skillName: string;
  description: string;
  scope: 'user';
  enabled: true;
  contentDigest: string;
}

export class GeneratedSkillPublishError extends Error {
  constructor(readonly code: 'SKILL_ALREADY_EXISTS' | 'SKILL_PUBLISH_FAILED') {
    super(code);
    this.name = 'GeneratedSkillPublishError';
  }
}

export interface GeneratedSkillPublisherDeps {
  appDataDir: string;
  repos: SqliteRepositories;
  clock: Clock;
  ids: IdProvider;
  skillRoot: (userId: LocalUserId) => string;
}

/** 管理内置创建器，并把模型生成的纯文本 Skill 原子发布到当前用户目录。 */
export class GeneratedSkillPublisher {
  constructor(private readonly deps: GeneratedSkillPublisherDeps) {}

  seedBuiltinCreator(userIds: readonly LocalUserId[]): void {
    const root = path.join(this.deps.appDataDir, 'bundled-skills', BUILTIN_SKILL_CREATOR_NAME);
    this.writeBundledCreator(root);
    const parsed = parseSkillDirectory(root);
    if (!parsed.ok) throw new Error(`Invalid bundled Skill creator: ${parsed.error}`);

    for (const userId of userIds) {
      const existing = this.deps.repos.skills.getInstallation(userId, BUILTIN_SKILL_CREATOR_NAME);
      if (existing && existing.sourceType !== 'bundled') continue;
      const unchanged =
        existing?.sourceType === 'bundled' &&
        existing.rootPath === parsed.skill.resourceBase &&
        existing.description === parsed.skill.description &&
        existing.contentDigest === parsed.skill.contentDigest &&
        existing.enabled &&
        existing.status === 'valid';
      if (unchanged) continue;

      this.deps.repos.skills.upsertInstallation({
        id: existing?.id ?? `${userId}:${BUILTIN_SKILL_CREATOR_NAME}`,
        userId,
        skillName: BUILTIN_SKILL_CREATOR_NAME,
        description: parsed.skill.description,
        sourceType: 'bundled',
        sourceRef: 'builtin:skill-creator',
        rootPath: parsed.skill.resourceBase,
        metadata: { builtin: true, role: 'skill-creator' },
        contentDigest: parsed.skill.contentDigest,
        enabled: true,
        status: 'valid',
        compatibilityStatus: 'compatible',
        now: this.deps.clock.nowIso(),
      });
    }
  }

  publish(userId: LocalUserId, input: PublishGeneratedSkillInput): PublishGeneratedSkillResult {
    const userRoot = this.deps.skillRoot(userId);
    const destination = path.join(userRoot, input.name);
    const existing = this.deps.repos.skills.getInstallation(userId, input.name);
    if (
      input.name === BUILTIN_SKILL_CREATOR_NAME ||
      existsSync(destination) ||
      (existing && existing.status !== 'missing')
    ) {
      throw new GeneratedSkillPublishError('SKILL_ALREADY_EXISTS');
    }

    mkdirSync(userRoot, { recursive: true });
    const temporaryRoot = path.join(userRoot, `.publish-${this.deps.ids.newId()}`);
    const temporarySkill = path.join(temporaryRoot, input.name);

    try {
      mkdirSync(temporarySkill, { recursive: true });
      writeFileSync(path.join(temporarySkill, 'SKILL.md'), renderGeneratedSkill(input), {
        encoding: 'utf8',
        flag: 'wx',
      });
      const parsed = parseSkillDirectory(temporarySkill);
      if (!parsed.ok) throw new GeneratedSkillPublishError('SKILL_PUBLISH_FAILED');
      renameSync(temporarySkill, destination);
      rmSync(temporaryRoot, { recursive: true, force: true });
      try {
        this.deps.repos.skills.upsertInstallation({
          id: existing?.id ?? `${userId}:${input.name}`,
          userId,
          skillName: input.name,
          description: input.description,
          sourceType: 'local',
          sourceRef: destination,
          rootPath: destination,
          metadata: { generated: true, generatedBy: BUILTIN_SKILL_CREATOR_NAME },
          contentDigest: parsed.skill.contentDigest,
          enabled: true,
          status: 'valid',
          compatibilityStatus: 'compatible',
          now: this.deps.clock.nowIso(),
        });
      } catch (error) {
        rmSync(destination, { recursive: true, force: true });
        throw error;
      }
      return {
        skillName: input.name,
        description: input.description,
        scope: 'user',
        enabled: true,
        contentDigest: parsed.skill.contentDigest,
      };
    } catch (error) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      if (error instanceof GeneratedSkillPublishError) throw error;
      throw new GeneratedSkillPublishError('SKILL_PUBLISH_FAILED');
    }
  }

  private writeBundledCreator(root: string): void {
    mkdirSync(root, { recursive: true });
    const destination = path.join(root, 'SKILL.md');
    try {
      if (readFileSync(destination, 'utf8') === BUILTIN_SKILL_CREATOR_CONTENT) return;
    } catch {
      // 首次写入或旧文件不可读时，以当前内置版本替换。
    }
    const temporary = path.join(root, `.SKILL.md-${this.deps.ids.newId()}`);
    writeFileSync(temporary, BUILTIN_SKILL_CREATOR_CONTENT, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, destination);
  }
}

function renderGeneratedSkill(input: PublishGeneratedSkillInput): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    '---',
    '',
    input.instructions.trim(),
    '',
  ].join('\n');
}
