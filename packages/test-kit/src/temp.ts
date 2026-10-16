import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppDataLayout {
  root: string;
  dbPath: string;
  skillRoot: (userId: string) => string;
  logsDir: string;
}

export function makeTempDir(prefix = 'agent-harness-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function createAppData(root = makeTempDir()): AppDataLayout {
  const databaseDir = path.join(root, 'database');
  const skillsDir = path.join(root, 'skills');
  const logsDir = path.join(root, 'logs');
  mkdirSync(databaseDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return {
    root,
    dbPath: path.join(databaseDir, 'app.db'),
    skillRoot: (userId: string) => path.join(skillsDir, userId),
    logsDir,
  };
}

export function writeFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}
