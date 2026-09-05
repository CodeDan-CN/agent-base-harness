import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { InvalidSkill, ParsedSkill, SkillParseError } from '../../shared/domain/skill';

export type ParseOutcome =
  { ok: true; skill: ParsedSkill } | { ok: false; error: SkillParseError; resourceBase: string };

function isInside(rootDir: string, target: string): boolean {
  const rel = path.relative(rootDir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface Frontmatter {
  fields: Map<string, string>;
}

function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const fields = new Map<string, string>();
  const block = match[1] ?? '';
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (kv) {
      const key = kv[1] ?? '';
      const raw = kv[2] ?? '';
      let value = raw.replace(/^["']|["']$/g, '');
      // 编辑器使用 JSON 双引号标量写回 YAML，正确还原引号、换行和反斜杠。
      if (raw.startsWith('"') && raw.endsWith('"')) {
        try {
          const decoded: unknown = JSON.parse(raw);
          if (typeof decoded === 'string') value = decoded;
        } catch {
          // 保留原有非 JSON YAML 标量的兼容解析。
        }
      }
      fields.set(key, value);
    }
  }
  return { fields };
}

export function contentDigestOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function dirExists(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析单个标准 Agent Skills 目录（<dir>/SKILL.md）。不执行目录内任何脚本。
 */
export function parseSkillDirectory(skillDir: string): ParseOutcome {
  let rootReal: string;
  try {
    rootReal = realpathSync(skillDir);
  } catch {
    return { ok: false, error: 'read_error', resourceBase: skillDir };
  }

  const dirName = path.basename(skillDir);
  const skillMdPath = path.join(skillDir, 'SKILL.md');

  if (!existsSync(skillMdPath) || !lstatSync(skillMdPath).isFile()) {
    return { ok: false, error: 'missing_skill_md', resourceBase: skillDir };
  }

  let content: Buffer;
  try {
    content = readFileSync(skillMdPath);
  } catch {
    return { ok: false, error: 'read_error', resourceBase: skillDir };
  }

  const frontmatter = parseFrontmatter(content.toString('utf8'));
  if (!frontmatter) {
    return { ok: false, error: 'missing_name', resourceBase: skillDir };
  }

  const name = (frontmatter.fields.get('name') ?? '').trim();
  if (!name) {
    return { ok: false, error: 'missing_name', resourceBase: skillDir };
  }
  const description = (frontmatter.fields.get('description') ?? '').trim();
  if (!description) {
    return { ok: false, error: 'missing_description', resourceBase: skillDir };
  }
  if (name !== dirName) {
    return { ok: false, error: 'name_mismatch', resourceBase: skillDir };
  }

  const metadata: Record<string, unknown> = {};
  for (const [k, v] of frontmatter.fields) {
    if (k === 'name' || k === 'description') continue;
    metadata[k] = v;
  }

  return {
    ok: true,
    skill: {
      name,
      description,
      resourceBase: rootReal,
      metadata,
      contentDigest: contentDigestOf(content),
      nameMatches: true,
      hasScripts: dirExists(path.join(skillDir, 'scripts')),
      hasReferences: dirExists(path.join(skillDir, 'references')),
      hasAssets: dirExists(path.join(skillDir, 'assets')),
    },
  };
}

export interface SkillScanResult {
  skills: ParsedSkill[];
  invalid: InvalidSkill[];
}

/** 扫描受管根下 <root>/<name>/SKILL.md，校验目录边界，返回 valid 与 invalid 两部分。 */
export function scanSkillRoot(root: string): SkillScanResult {
  const skills: ParsedSkill[] = [];
  const invalid: InvalidSkill[] = [];

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { skills, invalid: [{ resourceBase: root, error: 'read_error' }] };
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { skills, invalid: [{ resourceBase: root, error: 'read_error' }] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = path.join(root, entry.name);

    let dirReal: string;
    try {
      dirReal = realpathSync(skillDir);
    } catch {
      invalid.push({ resourceBase: skillDir, error: 'read_error' });
      continue;
    }
    if (!isInside(rootReal, dirReal)) {
      invalid.push({ resourceBase: skillDir, error: 'path_escape' });
      continue;
    }

    const outcome = parseSkillDirectory(skillDir);
    if (outcome.ok) {
      skills.push(outcome.skill);
    } else {
      invalid.push({ resourceBase: outcome.resourceBase, error: outcome.error });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, invalid };
}
