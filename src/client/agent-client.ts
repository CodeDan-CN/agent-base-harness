import { randomUUID } from 'node:crypto';
import type {
  AuthResult,
  AuthSessionView,
  ClientKind,
  RegisterRequest,
} from '../shared/contracts/auth';
import type { CommandMethod, QueryMethod } from '../shared/contracts/ipc';
import type { SessionLogEvent } from '../shared/domain/session';
import { API_VERSION } from '../shared/contracts/schemas';

export interface AgentClientOptions {
  baseUrl: string;
  clientKind: ClientKind;
  accessToken?: string;
  connectionId?: string;
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

  constructor(private readonly options: AgentClientOptions) {
    this.connectionId = options.connectionId ?? randomUUID();
    this.fetchImplementation = options.fetch ?? fetch;
    this.token = options.accessToken;
  }

  setAccessToken(token: string | undefined): void {
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

  async register(bootstrapToken: string, input: RegisterRequest): Promise<AuthResult> {
    const result = await this.request<AuthResult>('POST', '/v1/auth/register', input, {
      'x-agent-bootstrap': bootstrapToken,
      'x-agent-client-kind': this.options.clientKind,
    });
    this.token = result.accessToken;
    return result;
  }

  async login(loginName: string, password: string): Promise<AuthResult> {
    const result = await this.request<AuthResult>('POST', '/v1/auth/login', {
      loginName,
      password,
      clientKind: this.options.clientKind,
    });
    this.token = result.accessToken;
    return result;
  }

  async me(): Promise<AuthSessionView> {
    return this.request('GET', '/v1/auth/me');
  }

  async logout(): Promise<void> {
    await this.request('POST', '/v1/auth/logout');
    this.token = undefined;
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
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    void this.followEventStream(sessionId, afterSeq, listener, controller.signal).catch((error) => {
      if (!controller.signal.aborted) options.onError?.(error);
    });
    return () => {
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
    };
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
      'x-request-id': randomUUID(),
      ...extraHeaders,
    };
    if (json) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
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
