import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { BridgeError } from '../shared/contracts/errors';

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const FILE_TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;
const REGULAR_FILE_TYPE = 0o100000;
const SYMLINK_TYPE = 0o120000;

export interface ArchiveEntryDescriptor {
  fileName: string;
  uncompressedSize: number;
  externalFileAttributes: number;
}

export interface ExtractedSkillArchive {
  skillRoot: string;
  cleanup(): void;
}

function invalidArchive(message: string): BridgeError {
  return new BridgeError('INVALID_REQUEST', message);
}

/** 在创建任何解压目录前校验 ZIP 条目，避免路径穿越和特殊文件落盘。 */
export function validateSkillArchiveEntry(entry: ArchiveEntryDescriptor): string {
  if (!entry.fileName || entry.fileName.includes('\0')) {
    throw invalidArchive('Invalid Skill ZIP entry');
  }

  const normalized = entry.fileName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw invalidArchive('Skill ZIP contains an unsafe path');
  }
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw invalidArchive('Skill ZIP contains an unsafe path');
  }

  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = mode & FILE_TYPE_MASK;
  if (fileType === SYMLINK_TYPE) {
    throw invalidArchive('Skill ZIP contains symlink');
  }
  if (fileType !== 0 && fileType !== DIRECTORY_TYPE && fileType !== REGULAR_FILE_TYPE) {
    throw invalidArchive('Skill ZIP contains unsupported entry');
  }
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw invalidArchive('Invalid Skill ZIP entry size');
  }
  return normalized;
}

async function preflightArchive(archivePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(invalidArchive('Invalid Skill ZIP'));
          return;
        }

        let settled = false;
        let entryCount = 0;
        let extractedBytes = 0;
        const seenPaths = new Set<string>();
        const finish = (error?: BridgeError): void => {
          if (settled) return;
          settled = true;
          zipFile.close();
          if (error) reject(error);
          else resolve();
        };

        zipFile.on('error', () => finish(invalidArchive('Invalid Skill ZIP')));
        zipFile.on('entry', (entry) => {
          try {
            if (entry.isEncrypted()) throw invalidArchive('Encrypted Skill ZIP is not supported');
            entryCount += 1;
            if (entryCount > MAX_ARCHIVE_ENTRIES) {
              throw invalidArchive('Skill ZIP contains too many entries');
            }
            const normalized = validateSkillArchiveEntry(entry);
            const duplicateKey = normalized.toLocaleLowerCase();
            if (seenPaths.has(duplicateKey)) {
              throw invalidArchive('Skill ZIP contains duplicate entries');
            }
            seenPaths.add(duplicateKey);
            extractedBytes += entry.uncompressedSize;
            if (extractedBytes > MAX_EXTRACTED_BYTES) {
              throw invalidArchive('Skill ZIP exceeds size limit');
            }
            zipFile.readEntry();
          } catch (error) {
            finish(
              error instanceof BridgeError ? error : invalidArchive('Invalid Skill ZIP entry'),
            );
          }
        });
        zipFile.on('end', () => finish());
        zipFile.readEntry();
      },
    );
  });
}

function isDirectoryEntry(entry: Entry, normalizedName: string): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const madeBy = entry.versionMadeBy >>> 8;
  return (
    normalizedName.endsWith('/') ||
    (mode & FILE_TYPE_MASK) === DIRECTORY_TYPE ||
    (madeBy === 0 && entry.externalFileAttributes === 16)
  );
}

function entryReadStream(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(invalidArchive('Invalid Skill ZIP'));
      else resolve(stream);
    });
  });
}

/** 只展开预检允许的普通目录和普通文件，权限固定且禁止覆盖。 */
async function extractPreflightedArchive(archivePath: string, targetRoot: string): Promise<void> {
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(invalidArchive('Invalid Skill ZIP'));
          return;
        }

        let settled = false;
        const finish = (error?: BridgeError): void => {
          if (settled) return;
          settled = true;
          zipFile.close();
          if (error) reject(error);
          else resolve();
        };

        zipFile.on('error', () => finish(invalidArchive('Invalid Skill ZIP')));
        zipFile.on('entry', (entry) => {
          void (async () => {
            const normalizedName = validateSkillArchiveEntry(entry);
            if (normalizedName.startsWith('__MACOSX/')) {
              zipFile.readEntry();
              return;
            }

            const destination = path.join(targetRoot, ...normalizedName.split('/').filter(Boolean));
            const relative = path.relative(targetRoot, destination);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
              throw invalidArchive('Skill ZIP contains an unsafe path');
            }

            if (isDirectoryEntry(entry, normalizedName)) {
              mkdirSync(destination, { recursive: true, mode: 0o700 });
            } else {
              mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
              const input = await entryReadStream(zipFile, entry);
              await pipeline(input, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
            }
            zipFile.readEntry();
          })().catch((error: unknown) =>
            finish(error instanceof BridgeError ? error : invalidArchive('Invalid Skill ZIP')),
          );
        });
        zipFile.on('end', () => finish());
        zipFile.readEntry();
      },
    );
  });
}

function assertExtractedTree(root: string): void {
  let entries = 0;
  let bytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = lstatSync(target);
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw invalidArchive('Skill ZIP contains too many entries');
      }
      if (stat.isSymbolicLink()) throw invalidArchive('Skill ZIP contains symlink');
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) bytes += stat.size;
      else throw invalidArchive('Skill ZIP contains unsupported entry');
      if (bytes > MAX_EXTRACTED_BYTES) {
        throw invalidArchive('Skill ZIP exceeds size limit');
      }
    }
  };
  visit(root);
}

function findSkillRoots(root: string): string[] {
  const roots: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'SKILL.md' && entry.isFile()) roots.push(directory);
      else if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  return [...new Set(roots)];
}

function skillNameFromFrontmatter(skillRoot: string): string {
  const content = readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const nameLine = frontmatter?.[1]?.match(/^\s*name\s*:\s*(.*?)\s*$/m);
  const name = (nameLine?.[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    name.includes('/') ||
    name.includes('\\') ||
    path.basename(name) !== name
  ) {
    throw invalidArchive('Skill ZIP has an invalid Skill name');
  }
  return name;
}

function normalizeSkillRoot(extractedRoot: string, temporaryRoot: string): string {
  const roots = findSkillRoots(extractedRoot);
  if (roots.length === 0) throw invalidArchive('Skill ZIP is missing SKILL.md');
  if (roots.length > 1) throw invalidArchive('Skill ZIP contains multiple Skill roots');

  const foundRoot = roots[0]!;
  const skillName = skillNameFromFrontmatter(foundRoot);
  if (path.basename(foundRoot) === skillName) return foundRoot;

  const normalizedRoot = path.join(temporaryRoot, skillName);
  try {
    lstatSync(normalizedRoot);
    throw invalidArchive('Skill ZIP contains conflicting Skill roots');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
  }
  renameSync(foundRoot, normalizedRoot);
  return normalizedRoot;
}

export async function extractSkillArchive(archivePath: string): Promise<ExtractedSkillArchive> {
  let archiveStat;
  try {
    archiveStat = lstatSync(archivePath);
  } catch {
    throw invalidArchive('Skill ZIP cannot be read');
  }
  if (
    !archiveStat.isFile() ||
    path.extname(archivePath).toLocaleLowerCase() !== '.zip' ||
    archiveStat.size > MAX_ARCHIVE_BYTES
  ) {
    throw invalidArchive('Invalid Skill ZIP');
  }

  await preflightArchive(archivePath);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-skill-'));
  const extractedRoot = path.join(temporaryRoot, 'extracted');
  try {
    await extractPreflightedArchive(archivePath, extractedRoot);
    assertExtractedTree(extractedRoot);
    const skillRoot = normalizeSkillRoot(extractedRoot, temporaryRoot);
    return {
      skillRoot,
      cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (error instanceof BridgeError) throw error;
    throw invalidArchive('Invalid Skill ZIP');
  }
}
