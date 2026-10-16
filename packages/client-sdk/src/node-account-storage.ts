// Optional Node entry point used only by Desktop Main and CLI.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LocalAccountStorage } from './local-auth';

export class FileAccountStorage implements LocalAccountStorage {
  constructor(private readonly directory: string) {}
  getItem(key: string): string | null {
    try {
      return readFileSync(this.file(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  setItem(key: string, value: string): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const target = this.file(key);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  removeItem(key: string): void {
    rmSync(this.file(key), { force: true });
  }
  private file(key: string): string {
    return path.join(this.directory, createHash('sha256').update(key).digest('hex') + '.json');
  }
}
