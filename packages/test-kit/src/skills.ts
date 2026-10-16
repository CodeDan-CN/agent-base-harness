import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFile } from './temp';

export function skillFrontmatter(name: string, description = 'A test skill'): string {
  return `name: ${name}\ndescription: ${description}\n`;
}

export function makeSkillDir(
  parentRoot: string,
  name: string,
  frontmatter: string,
  opts: { scripts?: boolean; references?: boolean; assets?: boolean } = {},
): string {
  const dir = path.join(parentRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}---\n\n# ${name}\n`);
  if (opts.scripts) mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  if (opts.references) mkdirSync(path.join(dir, 'references'), { recursive: true });
  if (opts.assets) mkdirSync(path.join(dir, 'assets'), { recursive: true });
  return dir;
}

export function makePlainDir(parentRoot: string, name: string): string {
  const dir = path.join(parentRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
