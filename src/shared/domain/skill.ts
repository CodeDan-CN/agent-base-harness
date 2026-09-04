/** Skill 安装记录与目录解析结果的领域类型。 */

import type { LocalUserId } from './user';

export type SkillSourceType = 'local' | 'modelscope' | 'clawhub' | 'bundled';
export type SkillInstallationStatus = 'valid' | 'invalid' | 'missing' | 'incompatible';
export type SkillCompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';

export interface SkillInstallation {
  id: string;
  userId: LocalUserId;
  skillName: string;
  description: string;
  categoryId: string;
  sourceType: SkillSourceType;
  sourceRef: string | null;
  rootPath: string;
  metadata: Record<string, unknown>;
  contentDigest: string;
  enabled: boolean;
  status: SkillInstallationStatus;
  compatibilityStatus: SkillCompatibilityStatus;
  createdAt: string;
  updatedAt: string;
}

/** 单个 Skill 目录的解析结果（不含安装记录）。 */
export interface ParsedSkill {
  name: string;
  description: string;
  resourceBase: string;
  metadata: Record<string, unknown>;
  contentDigest: string;
  /** 目录名与 frontmatter name 是否一致。 */
  nameMatches: boolean;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}

/** 解析失败原因。 */
export type SkillParseError =
  | 'missing_skill_md'
  | 'missing_name'
  | 'missing_description'
  | 'name_mismatch'
  | 'read_error'
  | 'path_escape';

export interface InvalidSkill {
  resourceBase: string;
  error: SkillParseError;
}

/** 当前用户可见的 Skill Catalog 摘要。 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  categoryId: string;
  sourceType: SkillSourceType;
  resourceBase: string;
  metadata: Record<string, unknown>;
  contentDigest: string;
  enabled: boolean;
  status: SkillInstallationStatus;
  compatibilityStatus: SkillCompatibilityStatus;
}

export interface SkillCatalogSnapshot {
  userId: LocalUserId;
  revision: number;
  entries: SkillCatalogEntry[];
}
