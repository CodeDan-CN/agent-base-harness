import {
  CLIENT_USER_HEADER,
  clientUserSchema,
  type AuthenticatedUser,
} from '../../protocol/src/contracts/auth';
import {
  ClientLocalAuth,
  LocalAccountError,
  MemoryAccountStorage,
  localId,
  type LocalAccountStorage,
} from './local-auth';
import type {
  AuthResult,
  AuthSessionView,
  ClientKind,
  RegisterRequest,
} from '../../protocol/src/contracts/auth';
import type { CommandMethod, QueryMethod } from '../../protocol/src/contracts/ipc';
import type { SessionLogEvent } from '../../protocol/src/domain/session';
import { API_VERSION } from '../../protocol/src/client/api-version';
import {
  MAX_SESSION_FILE_BYTES,
  sessionFileNameSchema,
  uploadedSessionFileSchema,
  type UploadedSessionFile,
} from '../../protocol/src/contracts/session-file';

export interface AgentClientOptions {
  baseUrl: string;
  clientKind: ClientKind;
  accessToken?: string;
  connectionId?: string;
  /** Client-owned account persistence; defaults to an isolated in-memory store. */
  accountStorage?: LocalAccountStorage;
  /** Explicit identity for integrations that own their user system. */
  user?: AuthenticatedUser;
  fetch?: typeof fetch;
}

export class AgentClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AgentClientError';
  }
}

export class AgentClient {
  readonly connectionId: string;
  private readonly fetchImplementation: typeof fetch;
  private token: string | undefined;
  private readonly localAuth: ClientLocalAuth;
  private user: AuthenticatedUser | undefined;
  private readonly streams = new Set<AbortController>();

  constructor(private readonly options: AgentClientOptions) {
    this.connectionId = options.connectionId ?? localId();
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = options.accessToken;
    this.localAuth = new ClientLocalAuth(
      options.accountStorage ?? new MemoryAccountStorage(),
      options.clientKind,
    );
    this.user = options.user ? clientUserSchema.parse(options.user) : undefined;
  }

  setAccessToken(token: string | undefined): void {
    this.stopStreams();
    this.user = undefined;
    this.token = token;
  }

  get accessToken(): string | undefined {
    return this.token;
  }

  async health(): Promise<{
    status: string;
    version: string;
    protocolVersion: number;
    instanceId: string;
  }> {
    return this.request('GET', '/healthz');
  }

  /** Legacy SDK alias; registration is now local and bootstrapToken is ignored. */
  async register(_bootstrapToken: string, input: RegisterRequest): Promise<AuthResult> {
    return this.registerRemote(input);
  }

  async login(loginName: string, password: string): Promise<AuthResult> {
    return this.authenticateLocally(() => this.localAuth.login(loginName, password));
  }

  /** Kept for source compatibility. This creates a client-local account without HTTP. */
  async registerRemote(input: RegisterRequest): Promise<AuthResult> {
    return this.authenticateLocally(() => this.localAuth.register(input));
  }

  setUser(user: AuthenticatedUser | undefined): void {
    this.stopStreams();
    this.token = undefined;
    this.user = user ? clientUserSchema.parse(user) : undefined;
  }

  private async authenticateLocally(action: () => Promise<AuthResult>): Promise<AuthResult> {
    try {
      const result = await action();
      this.stopStreams();
      this.localAuth.logout(this.token);
      this.token = result.accessToken;
      this.user = undefined;
      return result;
    } catch (error) {
      throw localError(error);
    }
  }

  async installSkill(zip: Blob, fileName: string): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.options.baseUrl}/v1/skills/install`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/zip',
        'x-agent-file-name': encodeURIComponent(fileName),
      }),
      body: zip,
    });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }

  async uploadSessionFile(
    sessionId: string,
    file: Blob,
    name: string,
  ): Promise<UploadedSessionFile> {
    if (!sessionFileNameSchema.safeParse(name).success || file.size > MAX_SESSION_FILE_BYTES) {
      throw new AgentClientError('INVALID_REQUEST', '文件名无效或文件超过 20 MB');
    }
    const response = await this.fetchImplementation(
      `${this.options.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/files`,
      {
        method: 'POST',
        headers: this.headers({
          'content-type': 'application/octet-stream',
          'x-agent-file-name': encodeURIComponent(name),
        }),
        body: file,
      },
    );
    if (!response.ok) throw await responseError(response);
    return uploadedSessionFileSchema.parse(await response.json());
  }

  async downloadSessionFile(sessionId: string, target: string): Promise<Blob> {
    const response = await this.fetchImplementation(
      `${this.options.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/files?target=${encodeURIComponent(target)}`,
      { headers: this.headers() },
    );
    if (!response.ok) throw await responseError(response);
    return response.blob();
  }

  async me(): Promise<AuthSessionView> {
    try {
      return this.localAuth.current(this.token);
    } catch (error) {
      throw localError(error);
    }
  }

  async logout(): Promise<void> {
    this.stopStreams();
    this.localAuth.logout(this.token);
    this.token = undefined;
    this.user = undefined;
  }

  async stopService(bootstrapToken: string): Promise<void> {
    await this.request('POST', '/v1/server/stop', undefined, {
      'x-agent-bootstrap': bootstrapToken,
    });
  }

  query<T>(method: QueryMethod, params?: unknown): Promise<T> {
    return this.request('POST', '/v1/queries', { apiVersion: API_VERSION, method, params });
  }

  command<T>(method: CommandMethod, params?: unknown): Promise<T> {
    return this.request('POST', '/v1/commands', { apiVersion: API_VERSION, method, params });
  }

  subscribeSession(
    sessionId: string,
    afterSeq: number,
    listener: (event: SessionLogEvent) => void,
    options: { signal?: AbortSignal; onError?: (error: unknown) => void } = {},
  ): () => void {
    const controller = new AbortController();
    this.streams.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    void this.followEventStream(sessionId, afterSeq, listener, controller.signal).catch((error) => {
      if (!controller.signal.aborted) options.onError?.(error);
    });
    return () => {
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
      this.streams.delete(controller);
    };
  }

  private stopStreams(): void {
    for (const controller of this.streams) controller.abort();
    this.streams.clear();
  }

  private async followEventStream(
    sessionId: string,
    afterSeq: number,
    listener: (event: SessionLogEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = afterSeq;
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.consumeEventStream(
          sessionId,
          cursor,
          (event) => {
            if (event.seq <= cursor) return;
            failures = 0;
            cursor = event.seq;
            listener(event);
          },
          signal,
        );
        if (signal.aborted) return;
        failures += 1;
        if (failures >= 5) {
          throw new AgentClientError('CONNECTION_ERROR', 'Event stream closed repeatedly');
        }
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        if (
          failures >= 5 ||
          (error instanceof AgentClientError &&
            (error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'AUTHORIZATION_FAILED'))
        ) {
          throw error;
        }
      }
      await abortableDelay(Math.min(250 * 2 ** failures, 4000), signal);
    }
  }

  private async consumeEventStream(
    sessionId: string,
    afterSeq: number,
    listener: (event: SessionLogEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImplementation(
      `${this.options.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${afterSeq}`,
      {
        method: 'GET',
        headers: this.headers(),
        signal,
      },
    );
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new AgentClientError('PROTOCOL_ERROR', 'Event stream unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed.event === 'runtime-event' && parsed.data) {
          listener(JSON.parse(parsed.data) as SessionLogEvent);
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.options.baseUrl}${path}`, {
        method,
        headers: this.headers(extraHeaders, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new AgentClientError(
        'CONNECTION_ERROR',
        error instanceof Error ? error.message : 'Unable to connect to local service',
      );
    }
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private headers(extraHeaders: Record<string, string> = {}, json = false): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-agent-connection-id': this.connectionId,
      'x-request-id': localId(),
      ...extraHeaders,
    };
    if (json) headers['content-type'] = 'application/json';
    let user = this.user;
    if (this.token) {
      try {
        user = this.localAuth.current(this.token).user;
      } catch (error) {
        throw localError(error);
      }
    }
    if (user) headers[CLIENT_USER_HEADER] = encodeURIComponent(JSON.stringify(user));
    headers['x-agent-client-kind'] = this.options.clientKind;
    return headers;
  }
}

async function responseError(response: Response): Promise<AgentClientError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    return new AgentClientError(
      body.error?.code ?? 'PROTOCOL_ERROR',
      body.error?.message ?? `Service request failed (${response.status})`,
      response.status,
    );
  } catch {
    return new AgentClientError(
      'PROTOCOL_ERROR',
      `Service returned an invalid error (${response.status})`,
      response.status,
    );
  }
}

function parseSseBlock(block: string): { event: string; data: string } {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trimStart();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function localError(error: unknown): unknown {
  return error instanceof LocalAccountError
    ? new AgentClientError(error.code, error.message)
    : error;
}
