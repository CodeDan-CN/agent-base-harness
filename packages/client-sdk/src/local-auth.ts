import { compare, hash } from 'bcryptjs';
import { z } from 'zod';
import {
  clientUserSchema,
  registerRequestSchema,
  type AuthResult,
  type AuthSessionView,
  type ClientKind,
  type RegisterRequest,
} from '../../protocol/src/contracts/auth';

/** Client-owned persistence. No password or password digest is sent to Runtime. */
export interface LocalAccountStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryAccountStorage implements LocalAccountStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

export class LocalAccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const accountSchema = z.object({ user: clientUserSchema, digest: z.string().regex(/^\$2[aby]\$/) });
const sessionSchema = z.object({
  id: z.string(),
  user: clientUserSchema,
  expiresAt: z.string().datetime(),
  clientKind: z.enum(['web', 'electron', 'cli', 'mobile']),
});

export function localId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export function normalizeLoginName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export class ClientLocalAuth {
  constructor(
    private readonly storage: LocalAccountStorage,
    private readonly clientKind: ClientKind,
  ) {
    // Local installation's built-in account retains the legacy data partition.
    // Only seed missing accounts: never reset an existing local password or ID.
    const key = this.accountKey('user-a');
    if (this.storage.getItem(key) === null) {
      this.storage.setItem(
        key,
        JSON.stringify({
          user: { id: 'user-a', loginName: 'user-a', displayName: 'User A' },
          digest: '$2b$10$GVkISpEusiPRPfaJX0UqM.B9iGEj8FndQ0pw9UuDxHDTluCFphjte',
        }),
      );
    }
  }

  async register(input: RegisterRequest): Promise<AuthResult> {
    const parsed = registerRequestSchema.safeParse(input);
    const loginName = input.loginName.trim().normalize('NFKC');
    if (
      !parsed.success ||
      !/^[\p{L}\p{N}._@-]{3,64}$/u.test(loginName) ||
      new TextEncoder().encode(input.password).length > 72
    ) {
      throw new LocalAccountError(
        'INVALID_REQUEST',
        '账号需为 3–64 个字符，密码至少 6 个字符且不超过 72 字节',
      );
    }
    const key = this.accountKey(loginName);
    if (this.storage.getItem(key)) throw new LocalAccountError('CONFLICT', '本地账号已存在');
    const digest = await hash(input.password, 10);
    // Recheck after hashing so concurrent registrations cannot overwrite an account.
    if (this.storage.getItem(key)) throw new LocalAccountError('CONFLICT', '本地账号已存在');
    const user = { id: `local-${localId()}`, loginName, displayName: loginName };
    this.storage.setItem(key, JSON.stringify({ user, digest }));
    return this.session(user);
  }

  async login(loginName: string, password: string): Promise<AuthResult> {
    let account: z.infer<typeof accountSchema> | undefined;
    try {
      account = accountSchema.parse(
        JSON.parse(this.storage.getItem(this.accountKey(loginName)) ?? 'null'),
      );
    } catch {
      /* Unknown or corrupt local account. */
    }
    if (
      !account ||
      new TextEncoder().encode(password).length > 72 ||
      !(await compare(password, account.digest))
    ) {
      throw new LocalAccountError(
        'AUTHENTICATION_FAILED',
        '本地账号或密码错误；首次使用此客户端请先创建账号',
      );
    }
    return this.session(account.user);
  }

  current(token?: string): AuthSessionView {
    try {
      const value = sessionSchema.parse(
        JSON.parse(this.storage.getItem(`session:${token}`) ?? 'null'),
      );
      if (Date.parse(value.expiresAt) > Date.now()) return value;
    } catch {
      /* Missing, expired or old server-issued session. */
    }
    if (token) this.logout(token);
    throw new LocalAccountError('AUTHENTICATION_REQUIRED', '请先登录本地账号');
  }

  logout(token?: string): void {
    if (token) this.storage.removeItem(`session:${token}`);
  }

  private accountKey(name: string): string {
    return `account:${normalizeLoginName(name)}`;
  }

  private session(user: AuthResult['user']): AuthResult {
    const accessToken = localId();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    this.storage.setItem(
      `session:${accessToken}`,
      JSON.stringify({ id: accessToken, user, expiresAt, clientKind: this.clientKind }),
    );
    return { accessToken, expiresAt, user };
  }
}

export function browserAccountStorage(namespace: string): LocalAccountStorage {
  const prefix = `agent-harness-local-accounts:${namespace}:`;
  return {
    getItem: (key) => localStorage.getItem(prefix + key),
    setItem: (key, value) => localStorage.setItem(prefix + key, value),
    removeItem: (key) => localStorage.removeItem(prefix + key),
  };
}
