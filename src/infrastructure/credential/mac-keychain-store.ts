import { execFile } from 'node:child_process';
import { credentialRefOf, isCredentialRef } from './credential-store';
import type { CredentialScope, CredentialStatus, CredentialStore } from './credential-store';

type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function defaultExec(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * 首发操作系统（macOS）Credential Adapter，基于 `security` 通用密码项。
 * account = credentialRef（namespace），service 固定为应用标识。
 */
export class MacKeychainCredentialStore implements CredentialStore {
  private readonly service: string;
  private readonly exec: ExecFn;

  constructor(opts: { service?: string; exec?: ExecFn } = {}) {
    this.service = opts.service ?? 'agent-client-harness';
    this.exec = opts.exec ?? defaultExec;
  }

  async set(scope: CredentialScope, value: string): Promise<void> {
    const ref = credentialRefOf(scope);
    await this.exec('/usr/bin/security', [
      'add-generic-password',
      '-s',
      this.service,
      '-a',
      ref,
      '-w',
      value,
      '-U',
    ]);
  }

  async get(scope: CredentialScope): Promise<string | null> {
    const ref = credentialRefOf(scope);
    return this.getByRef(ref);
  }

  async getByRef(ref: string): Promise<string | null> {
    if (!isCredentialRef(ref)) return null;
    try {
      const { stdout } = await this.exec('/usr/bin/security', [
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        ref,
        '-w',
      ]);
      return stdout.replace(/\n$/, '');
    } catch {
      return null;
    }
  }

  async delete(scope: CredentialScope): Promise<void> {
    const ref = credentialRefOf(scope);
    try {
      await this.exec('/usr/bin/security', [
        'delete-generic-password',
        '-s',
        this.service,
        '-a',
        ref,
      ]);
    } catch {
      return;
    }
  }

  async status(scope: CredentialScope): Promise<CredentialStatus> {
    const value = await this.get(scope);
    return value === null ? 'missing' : 'configured';
  }

  async available(): Promise<boolean> {
    try {
      await this.exec('/usr/bin/security', ['list-keychains']);
      return true;
    } catch {
      return false;
    }
  }
}
