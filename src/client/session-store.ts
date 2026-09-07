import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuthResult } from '../shared/contracts/auth';

interface StoredCliSession {
  accessToken: string;
  expiresAt: string;
  user: AuthResult['user'];
}

export class FileSessionStore {
  constructor(private readonly filePath: string) {}

  load(): StoredCliSession | undefined {
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredCliSession>;
      if (
        typeof value.accessToken !== 'string' ||
        typeof value.expiresAt !== 'string' ||
        !value.user ||
        typeof value.user.id !== 'string' ||
        typeof value.user.loginName !== 'string' ||
        typeof value.user.displayName !== 'string' ||
        Date.parse(value.expiresAt) <= Date.now()
      ) {
        this.clear();
        return undefined;
      }
      return value as StoredCliSession;
    } catch {
      return undefined;
    }
  }

  save(result: AuthResult): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.filePath,
      JSON.stringify({
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        user: result.user,
      } satisfies StoredCliSession),
      { encoding: 'utf8', mode: 0o600 },
    );
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // POSIX permissions are unavailable on some platforms.
    }
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}
