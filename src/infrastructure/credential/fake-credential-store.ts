import { credentialRefOf, isCredentialRef } from './credential-store';
import type { CredentialScope, CredentialStatus, CredentialStore } from './credential-store';

export interface AuditEntry {
  operation: 'set' | 'get' | 'delete' | 'status';
  ref: string;
  result: 'ok' | 'missing' | 'error';
}

/**
 * 内存 Fake Credential Store。支持故障注入与访问审计，测试用。
 */
export class FakeCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  readonly audit: AuditEntry[] = [];
  private unavailable = false;

  setUnavailable(value: boolean): void {
    this.unavailable = value;
  }

  async set(scope: CredentialScope, value: string): Promise<void> {
    this.ensureAvailable();
    this.values.set(credentialRefOf(scope), value);
    this.audit.push({ operation: 'set', ref: credentialRefOf(scope), result: 'ok' });
  }

  async get(scope: CredentialScope): Promise<string | null> {
    this.ensureAvailable();
    const ref = credentialRefOf(scope);
    return this.getByRef(ref);
  }

  async getByRef(ref: string): Promise<string | null> {
    this.ensureAvailable();
    if (!isCredentialRef(ref)) {
      this.audit.push({ operation: 'get', ref: '(invalid)', result: 'error' });
      return null;
    }
    const value = this.values.get(ref) ?? null;
    this.audit.push({ operation: 'get', ref, result: value === null ? 'missing' : 'ok' });
    return value;
  }

  async delete(scope: CredentialScope): Promise<void> {
    this.ensureAvailable();
    const ref = credentialRefOf(scope);
    const existed = this.values.delete(ref);
    this.audit.push({ operation: 'delete', ref, result: existed ? 'ok' : 'missing' });
  }

  async status(scope: CredentialScope): Promise<CredentialStatus> {
    this.ensureAvailable();
    const exists = this.values.has(credentialRefOf(scope));
    this.audit.push({
      operation: 'status',
      ref: credentialRefOf(scope),
      result: exists ? 'ok' : 'missing',
    });
    return exists ? 'configured' : 'missing';
  }

  async available(): Promise<boolean> {
    return !this.unavailable;
  }

  private ensureAvailable(): void {
    if (this.unavailable) {
      this.audit.push({ operation: 'get', ref: '(unavailable)', result: 'error' });
      throw new Error('credential store unavailable');
    }
  }
}
