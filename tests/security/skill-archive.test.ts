import { ZipArchive } from 'archiver';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSkillArchive, validateSkillArchiveEntry } from '../../packages/execution/src/files/skill-archive';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

interface ZipEntry {
  name: string;
  content: string;
}

async function createZip(target: string, entries: ZipEntry[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(target);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.content, { name: entry.name });
    void archive.finalize();
  });
}

describe('安全：Skill ZIP 导入', () => {
  let root = '';

  afterEach(() => {
    if (root) cleanupDir(root);
    root = '';
  });

  it('支持 ZIP 内的标准单层 Skill 目录', async () => {
    root = makeTempDir('skill-zip-test-');
    const archivePath = path.join(root, 'weather-helper.zip');
    await createZip(archivePath, [
      {
        name: 'weather-helper/SKILL.md',
        content: '---\nname: weather-helper\ndescription: Weather helper\n---\n# Weather\n',
      },
      { name: 'weather-helper/references/usage.md', content: 'Usage' },
    ]);

    const extracted = await extractSkillArchive(archivePath);
    try {
      expect(path.basename(extracted.skillRoot)).toBe('weather-helper');
      expect(readFileSync(path.join(extracted.skillRoot, 'SKILL.md'), 'utf8')).toContain(
        'name: weather-helper',
      );
    } finally {
      const temporaryRoot = path.dirname(extracted.skillRoot);
      extracted.cleanup();
      expect(existsSync(temporaryRoot)).toBe(false);
    }
  });

  it('支持 SKILL.md 位于 ZIP 根目录并按技能名规范化目录', async () => {
    root = makeTempDir('skill-zip-test-');
    const archivePath = path.join(root, 'download.zip');
    await createZip(archivePath, [
      {
        name: 'SKILL.md',
        content: '---\nname: train-query\ndescription: Train query\n---\n# Train\n',
      },
      { name: 'scripts/query.py', content: 'print("ok")\n' },
    ]);

    const extracted = await extractSkillArchive(archivePath);
    try {
      expect(path.basename(extracted.skillRoot)).toBe('train-query');
      expect(existsSync(path.join(extracted.skillRoot, 'scripts/query.py'))).toBe(true);
    } finally {
      extracted.cleanup();
    }
  });

  it('拒绝路径穿越、绝对路径和符号链接条目', () => {
    const regularAttributes = 0o100644 * 0x10000;
    const symlinkAttributes = 0o120777 * 0x10000;
    expect(() =>
      validateSkillArchiveEntry({
        fileName: '../escape',
        uncompressedSize: 1,
        externalFileAttributes: regularAttributes,
      }),
    ).toThrow('unsafe path');
    expect(() =>
      validateSkillArchiveEntry({
        fileName: '/tmp/escape',
        uncompressedSize: 1,
        externalFileAttributes: regularAttributes,
      }),
    ).toThrow('unsafe path');
    expect(() =>
      validateSkillArchiveEntry({
        fileName: 'skill/link',
        uncompressedSize: 1,
        externalFileAttributes: symlinkAttributes,
      }),
    ).toThrow('symlink');
  });

  it('拒绝包含多个 SKILL.md 根的歧义 ZIP', async () => {
    root = makeTempDir('skill-zip-test-');
    const archivePath = path.join(root, 'multiple.zip');
    await createZip(archivePath, [
      {
        name: 'first/SKILL.md',
        content: '---\nname: first\ndescription: First\n---\n',
      },
      {
        name: 'second/SKILL.md',
        content: '---\nname: second\ndescription: Second\n---\n',
      },
    ]);

    await expect(extractSkillArchive(archivePath)).rejects.toThrow('multiple Skill roots');
  });
});
