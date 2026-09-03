import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import { scanSkillRoot } from '../infrastructure/skills/parser';
import type { ParsedSkill, SkillCatalogSnapshot, SkillInstallation } from '../shared/domain/skill';
import type { LocalUserId } from '../shared/domain/user';
import type { Clock } from '../shared/domain/ports';

export interface SkillCatalogServiceDeps {
  repos: SqliteRepositories;
  skillRoot: (userId: LocalUserId) => string;
  clock: Clock;
}

/**
 * 连接 Skill 目录解析与安装 Repository，形成发现 → 校验 → 写入 → 差集同步 → revision → Catalog 的闭环。
 * 内容未变化时不写库，避免无意义地递增 skill_revision。
 */
export class SkillCatalogService {
  private readonly repos: SqliteRepositories;
  private readonly skillRoot: (userId: LocalUserId) => string;
  private readonly clock: Clock;

  constructor(deps: SkillCatalogServiceDeps) {
    this.repos = deps.repos;
    this.skillRoot = deps.skillRoot;
    this.clock = deps.clock;
  }

  refresh(userId: LocalUserId): SkillCatalogSnapshot {
    const root = this.skillRoot(userId);
    const { skills, invalid } = scanSkillRoot(root);

    const present = new Set<string>();

    for (const skill of skills) {
      this.upsertValid(userId, skill);
      present.add(skill.name);
    }

    for (const bad of invalid) {
      if (bad.error === 'read_error') continue;
      const dirName = path.basename(bad.resourceBase);
      this.upsertInvalid(userId, dirName, bad.resourceBase);
      present.add(dirName);
    }

    for (const existing of this.repos.skills.listInstallations(userId)) {
      if (present.has(existing.skillName)) continue;
      if (existing.sourceType === 'bundled') continue;
      if (existing.status === 'missing') continue;
      this.markMissing(userId, existing);
    }

    return this.catalog(userId);
  }

  catalog(userId: LocalUserId): SkillCatalogSnapshot {
    const installations = this.repos.skills.listInstallations(userId);
    return {
      userId,
      revision: this.repos.users.getRevisions(userId).skillRevision,
      entries: installations
        .filter((i) => i.status === 'valid')
        .map((i) => ({
          name: i.skillName,
          description: i.description,
          sourceType: i.sourceType,
          resourceBase: i.rootPath,
          metadata: i.metadata,
          contentDigest: i.contentDigest,
          enabled: i.enabled,
          status: i.status,
          compatibilityStatus: i.compatibilityStatus,
        })),
    };
  }

  skillRootHealth(userId: LocalUserId): {
    status: 'ok' | 'missing' | 'error';
    invalidCount: number;
  } {
    const root = this.skillRoot(userId);
    if (!existsSync(root)) {
      return { status: 'missing', invalidCount: 0 };
    }
    const { invalid } = scanSkillRoot(root);
    return { status: 'ok', invalidCount: invalid.length };
  }

  invalidCount(userId: LocalUserId): number {
    return this.skillRootHealth(userId).invalidCount;
  }

  private upsertValid(userId: LocalUserId, skill: ParsedSkill): void {
    const existing = this.repos.skills.getInstallation(userId, skill.name);
    if (existing?.sourceType === 'bundled') return;
    const changed =
      !existing ||
      existing.contentDigest !== skill.contentDigest ||
      existing.rootPath !== skill.resourceBase ||
      existing.description !== skill.description ||
      existing.status !== 'valid';
    if (!changed) return;

    this.repos.skills.upsertInstallation({
      id: existing?.id ?? `${userId}:${skill.name}`,
      userId,
      skillName: skill.name,
      description: skill.description,
      sourceType: 'local',
      sourceRef: skill.resourceBase,
      rootPath: skill.resourceBase,
      metadata: skill.metadata,
      contentDigest: skill.contentDigest,
      enabled: existing?.enabled ?? false,
      status: 'valid',
      compatibilityStatus: existing?.compatibilityStatus ?? 'compatible',
      now: this.clock.nowIso(),
    });
  }

  private upsertInvalid(userId: LocalUserId, skillName: string, resourceBase: string): void {
    const existing = this.repos.skills.getInstallation(userId, skillName);
    if (existing?.sourceType === 'bundled') return;
    const changed =
      !existing || existing.status !== 'invalid' || existing.rootPath !== resourceBase;
    if (!changed) return;

    this.repos.skills.upsertInstallation({
      id: existing?.id ?? `${userId}:${skillName}`,
      userId,
      skillName,
      description: existing?.description ?? '',
      sourceType: existing?.sourceType ?? 'local',
      sourceRef: resourceBase,
      rootPath: resourceBase,
      metadata: existing?.metadata ?? {},
      contentDigest: existing?.contentDigest ?? '',
      enabled: existing?.enabled ?? false,
      status: 'invalid',
      compatibilityStatus: 'unknown',
      now: this.clock.nowIso(),
    });
  }

  private markMissing(userId: LocalUserId, existing: SkillInstallation): void {
    this.repos.skills.upsertInstallation({
      id: existing.id,
      userId,
      skillName: existing.skillName,
      description: existing.description,
      sourceType: existing.sourceType,
      sourceRef: existing.sourceRef,
      rootPath: existing.rootPath,
      metadata: existing.metadata,
      contentDigest: existing.contentDigest,
      enabled: existing.enabled,
      status: 'missing',
      compatibilityStatus: existing.compatibilityStatus,
      now: this.clock.nowIso(),
    });
  }
}
