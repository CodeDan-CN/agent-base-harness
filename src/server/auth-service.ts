import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import type { Logger } from '../infrastructure/logging/logger';
import type {
  AuthRepository,
  LocalAuthCredential,
  PasswordDigestParams,
} from '../infrastructure/sqlite/repositories';
import { BridgeError } from '../shared/contracts/errors';
import type {
  AuthResult,
  AuthSessionView,
  AuthenticatedUser,
  ClientKind,
} from '../shared/contracts/auth';
import type { Clock } from '../shared/domain/ports';
import type { LocalUserId } from '../shared/domain/user';
import type { UserRepository } from '../infrastructure/sqlite/repositories';

const DEFAULT_PARAMS: PasswordDigestParams = {
  algorithm: 'scrypt',
  keyLength: 32,
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
};
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DUMMY_SALT = Buffer.alloc(16, 0xa7).toString('base64url');
let dummyDigestPromise: Promise<string> | undefined;

export const BUILTIN_LOCAL_ACCOUNTS = [
  { userId: 'user-a', loginName: 'user-a' },
  { userId: 'user-b', loginName: 'user-b' },
] as const;
export const BUILTIN_LOCAL_PASSWORD = '123456';

export interface TrustedAuthSession {
  id: string;
  userId: LocalUserId;
  loginName: string;
  displayName: string;
  clientKind: ClientKind;
  expiresAt: string;
}

interface StoredSession extends TrustedAuthSession {
  tokenDigest: string;
}

export interface LocalAuthServiceOptions {
  authRepository: AuthRepository;
  userRepository: UserRepository;
  clock: Clock;
  logger: Logger;
  sessionTtlMs?: number;
  randomToken?: () => string;
  onAccountCreated?: (userId: LocalUserId) => void | Promise<void>;
}

export class LocalAuthService {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly sessionTtlMs: number;
  private readonly randomToken: () => string;

  constructor(private readonly options: LocalAuthServiceOptions) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async provisionBuiltinAccounts(): Promise<void> {
    this.options.logger.registerSecret(BUILTIN_LOCAL_PASSWORD);
    const current = await Promise.all(
      BUILTIN_LOCAL_ACCOUNTS.map(async (account) => {
        const credential = this.options.authRepository.getByUserId(account.userId);
        return (
          credential?.normalizedLoginName === normalizeLoginName(account.loginName) &&
          (await verifyCredential(BUILTIN_LOCAL_PASSWORD, credential))
        );
      }),
    );
    if (current.every(Boolean)) return;

    const now = this.options.clock.nowIso();
    const credentials = await Promise.all(
      BUILTIN_LOCAL_ACCOUNTS.map(async (account) => {
        const passwordSalt = randomBytes(16).toString('base64url');
        return {
          ...account,
          normalizedLoginName: normalizeLoginName(account.loginName),
          passwordDigest: await derivePassword(
            BUILTIN_LOCAL_PASSWORD,
            passwordSalt,
            DEFAULT_PARAMS,
          ),
          passwordSalt,
          passwordParams: DEFAULT_PARAMS,
          now,
        };
      }),
    );
    try {
      this.options.authRepository.replaceBuiltinCredentials(credentials);
    } catch {
      throw new BridgeError('DATABASE_UNAVAILABLE', 'Database unavailable');
    }
    this.options.logger.info('built-in local accounts provisioned', {
      userIds: BUILTIN_LOCAL_ACCOUNTS.map((account) => account.userId),
    });
  }

  async login(input: {
    loginName: string;
    password: string;
    clientKind: ClientKind;
  }): Promise<AuthResult> {
    const normalizedLoginName = normalizeLoginName(input.loginName);
    this.options.logger.registerSecret(input.password);
    const credential = this.options.authRepository.getByNormalizedLoginName(normalizedLoginName);
    const valid = await verifyCredential(input.password, credential);
    if (!credential || !valid) {
      throw new BridgeError('AUTHENTICATION_FAILED', 'Invalid login credentials');
    }
    const user = this.options.userRepository.getUser(credential.userId);
    if (!user) throw new BridgeError('AUTHENTICATION_FAILED', 'Invalid login credentials');
    return this.createSession(user.id, credential.loginName, user.displayName, input.clientKind);
  }

  async register(input: {
    loginName: string;
    password: string;
    clientKind: ClientKind;
  }): Promise<AuthResult> {
    const loginName = input.loginName.trim().normalize('NFKC');
    const normalizedLoginName = normalizeLoginName(loginName);
    assertLoginName(loginName, normalizedLoginName);
    assertPassword(input.password);
    if (this.options.authRepository.getByNormalizedLoginName(normalizedLoginName)) {
      throw new BridgeError('CONFLICT', 'Login name is unavailable');
    }

    this.options.logger.registerSecret(input.password);
    const userId = `local-${randomUUID()}`;
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordDigest = await derivePassword(input.password, passwordSalt, DEFAULT_PARAMS);
    try {
      this.options.authRepository.createLocalAccount({
        userId,
        loginName,
        normalizedLoginName,
        displayName: loginName,
        passwordDigest,
        passwordSalt,
        passwordParams: DEFAULT_PARAMS,
        now: this.options.clock.nowIso(),
      });
    } catch (error) {
      if (String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
        throw new BridgeError('CONFLICT', 'Login name is unavailable');
      }
      throw new BridgeError('DATABASE_UNAVAILABLE', 'Database unavailable');
    }
    try {
      await this.options.onAccountCreated?.(userId);
    } catch (error) {
      this.options.logger.warn('local account defaults could not be fully initialized', {
        userId,
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      });
    }
    this.options.logger.info('local account registered', { userId });
    return this.createSession(userId, loginName, loginName, input.clientKind);
  }

  authenticate(accessToken: string): TrustedAuthSession {
    if (!accessToken) throw new BridgeError('AUTHENTICATION_REQUIRED', 'Authentication required');
    const digest = digestToken(accessToken);
    const session = this.sessions.get(digest);
    if (!session || Date.parse(session.expiresAt) <= this.options.clock.now().getTime()) {
      if (session) this.sessions.delete(digest);
      throw new BridgeError('AUTHENTICATION_REQUIRED', 'Authentication required');
    }
    return { ...session };
  }

  current(accessToken: string): AuthSessionView {
    const session = this.authenticate(accessToken);
    return toSessionView(session);
  }

  logout(accessToken: string): void {
    if (!accessToken) throw new BridgeError('AUTHENTICATION_REQUIRED', 'Authentication required');
    const digest = digestToken(accessToken);
    if (!this.sessions.delete(digest)) {
      throw new BridgeError('AUTHENTICATION_REQUIRED', 'Authentication required');
    }
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  private createSession(
    userId: LocalUserId,
    loginName: string,
    displayName: string,
    clientKind: ClientKind,
  ): AuthResult {
    const token = this.randomToken();
    const expiresAt = new Date(
      this.options.clock.now().getTime() + this.sessionTtlMs,
    ).toISOString();
    const tokenDigest = digestToken(token);
    const session: StoredSession = {
      id: randomUUID(),
      userId,
      loginName,
      displayName,
      clientKind,
      expiresAt,
      tokenDigest,
    };
    this.sessions.set(tokenDigest, session);
    this.options.logger.registerSecret(token);
    this.options.logger.info('local login session created', {
      authSessionId: session.id,
      userId,
      clientKind,
    });
    return {
      accessToken: token,
      expiresAt,
      user: toUser(session),
    };
  }
}

export function normalizeLoginName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export async function derivePassword(
  password: string,
  salt: string,
  params: PasswordDigestParams = DEFAULT_PARAMS,
): Promise<string> {
  if (params.algorithm !== 'scrypt') throw new BridgeError('INTERNAL_ERROR', 'Invalid credential');
  const result = await new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      password,
      Buffer.from(salt, 'base64url'),
      params.keyLength,
      {
        N: params.cost,
        r: params.blockSize,
        p: params.parallelization,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
  return result.toString('base64url');
}

async function verifyCredential(
  password: string,
  credential: LocalAuthCredential | undefined,
): Promise<boolean> {
  const params = credential?.passwordParams ?? DEFAULT_PARAMS;
  const salt = credential?.passwordSalt ?? DUMMY_SALT;
  const expected = credential?.passwordDigest ?? (await dummyDigest());
  try {
    const actual = await derivePassword(password, salt, params);
    const actualBytes = Buffer.from(actual, 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    return (
      actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    );
  } catch {
    return false;
  }
}

function dummyDigest(): Promise<string> {
  dummyDigestPromise ??= derivePassword('not-a-real-password', DUMMY_SALT, DEFAULT_PARAMS);
  return dummyDigestPromise;
}

function assertLoginName(loginName: string, normalized: string): void {
  if (loginName.length < 3 || loginName.length > 64 || !/^[\p{L}\p{N}._@-]+$/u.test(loginName)) {
    throw new BridgeError('INVALID_REQUEST', 'Invalid login name');
  }
  if (normalized.length < 3 || normalized.length > 64) {
    throw new BridgeError('INVALID_REQUEST', 'Invalid login name');
  }
}

function assertPassword(password: string): void {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (password.length < 6 || bytes > 1024) {
    throw new BridgeError('INVALID_REQUEST', 'Password must be at least 6 characters');
  }
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function toUser(session: TrustedAuthSession): AuthenticatedUser {
  return {
    id: session.userId,
    loginName: session.loginName,
    displayName: session.displayName,
  };
}

function toSessionView(session: TrustedAuthSession): AuthSessionView {
  return {
    id: session.id,
    expiresAt: session.expiresAt,
    clientKind: session.clientKind,
    user: toUser(session),
  };
}
