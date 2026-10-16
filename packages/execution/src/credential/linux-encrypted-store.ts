import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { credentialRefOf, isCredentialRef } from './credential-store';
import type { CredentialScope, CredentialStatus, CredentialStore } from './credential-store';

/** Private, authenticated ciphertext files; restricted tool processes must not see this directory. */
export class LinuxEncryptedCredentialStore implements CredentialStore {
  private readonly directory: string;
  private readonly key: Buffer;

  constructor(options: { directory: string; keyFile?: string }) {
    this.directory = path.resolve(options.directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(this.directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
      throw new Error('Credential directory must be private and must not be a symlink');
    }
    const keyFile = options.keyFile ?? path.join(this.directory, 'master.key');
    if (!existsSync(keyFile)) {
      if (options.keyFile || readdirSync(this.directory).some((name) => name.endsWith('.json'))) {
        throw new Error('Credential master key is missing; restore the original key');
      }
      const descriptor = openSync(keyFile, 'wx', 0o600);
      try {
        writeFileSync(descriptor, randomBytes(32));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    const keyStat = lstatSync(keyFile);
    if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) {
      throw new Error('Credential master key must be a private regular file');
    }
    const descriptor = openSync(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      this.key = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (this.key.length !== 32) throw new Error('Credential master key must contain 32 bytes');
  }

  async set(scope: CredentialScope, value: string): Promise<void> {
    const ref = credentialRefOf(scope);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(ref));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    const target = this.fileOf(ref);
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, envelope, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, target);
      this.syncDirectory();
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  async get(scope: CredentialScope): Promise<string | null> {
    return this.getByRef(credentialRefOf(scope));
  }

  async getByRef(ref: string): Promise<string | null> {
    if (!isCredentialRef(ref)) return null;
    const target = this.fileOf(ref);
    let descriptor: number;
    try {
      descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Credential file cannot be opened safely');
    }
    try {
      const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
      if (!value || typeof value !== 'object') throw new Error('Invalid envelope');
      const envelope = value as Record<string, unknown>;
      if (
        envelope.version !== 1 ||
        typeof envelope.nonce !== 'string' ||
        typeof envelope.tag !== 'string' ||
        typeof envelope.ciphertext !== 'string'
      )
        throw new Error('Invalid envelope');
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(ref));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Credential authentication failed; check the master key and stored data');
    } finally {
      closeSync(descriptor);
    }
  }

  async delete(scope: CredentialScope): Promise<void> {
    try {
      unlinkSync(this.fileOf(credentialRefOf(scope)));
      this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async status(scope: CredentialScope): Promise<CredentialStatus> {
    return (await this.get(scope)) === null ? 'missing' : 'configured';
  }

  async available(): Promise<boolean> {
    return true;
  }

  private fileOf(ref: string): string {
    return path.join(this.directory, `${createHash('sha256').update(ref).digest('hex')}.json`);
  }

  private syncDirectory(): void {
    const descriptor = openSync(this.directory, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
