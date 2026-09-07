import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { URL } from 'node:url';
import type { Logger } from '../infrastructure/logging/logger';
import type { LocalAuthService } from './auth-service';
import type { RuntimeFacade, RequestContext } from '../runtime/runtime-facade';
import { BridgeError, toErrorPayload, type ErrorCode } from '../shared/contracts/errors';
import {
  MAX_REQUEST_BYTES,
  commandRequestSchema,
  queryParamsSchema,
  queryRequestSchema,
  runtimeResponseSchema,
} from '../shared/contracts/schemas';
import {
  clientKindSchema,
  loginRequestSchema,
  registerRequestSchema,
  type ClientKind,
} from '../shared/contracts/auth';
import type { SessionEventBatch } from '../shared/contracts/ipc';
import type { SessionLogEvent } from '../shared/domain/session';
import { bootstrapResultSchema } from '../shared/contracts/bootstrap';
import { healthSnapshotSchema } from '../shared/contracts/health';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

export interface GatewayOptions {
  runtime: RuntimeFacade;
  auth: LocalAuthService;
  bootstrapToken: string;
  logger: Logger;
  version: string;
  instanceId: string;
  onStopRequested?: () => void;
  loginRateLimit?: { attempts: number; windowMs: number };
}

export interface GatewayAddress {
  host: '127.0.0.1';
  port: number;
  baseUrl: string;
}

export class Gateway {
  private readonly server: Server;
  private readonly sseResponses = new Set<ServerResponse>();
  private readonly loginLimiter: FixedWindowRateLimiter;

  constructor(private readonly options: GatewayOptions) {
    this.loginLimiter = new FixedWindowRateLimiter(
      options.loginRateLimit?.attempts ?? 8,
      options.loginRateLimit?.windowMs ?? 60_000,
    );
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        this.handleError(response, error);
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
  }

  async listen(port = 0): Promise<GatewayAddress> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new BridgeError('RUNTIME_UNAVAILABLE', 'Gateway address unavailable');
    }
    return {
      host: '127.0.0.1',
      port: address.port,
      baseUrl: `http://127.0.0.1:${address.port}`,
    };
  }

  async close(): Promise<void> {
    for (const response of this.sseResponses) response.end();
    this.sseResponses.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    this.rejectBrowserOrigin(request);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/healthz') {
      this.json(response, 200, {
        status: 'ready',
        version: this.options.version,
        protocolVersion: 1,
        instanceId: this.options.instanceId,
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/auth/login') {
      this.enforceRateLimit(request, 'login');
      const parsed = loginRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid login');
      const result = await this.options.auth.login(parsed.data);
      this.loginLimiter.reset(rateLimitKey(request, 'login'));
      this.json(response, 200, result);
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/auth/register') {
      this.requireBootstrap(request);
      this.enforceRateLimit(request, 'register');
      const parsed = registerRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid registration');
      const result = await this.options.auth.register({
        ...parsed.data,
        clientKind: parseClientKind(request),
      });
      this.json(response, 201, result);
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/auth/me') {
      this.json(response, 200, this.options.auth.current(bearerToken(request)));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/auth/logout') {
      this.options.auth.logout(bearerToken(request));
      this.json(response, 200, { loggedOut: true });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/server/stop') {
      this.requireBootstrap(request);
      this.json(response, 202, { stopping: true });
      setImmediate(() => this.options.onStopRequested?.());
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/queries') {
      const context = this.requestContext(request);
      const parsed = queryRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid request');
      const paramsSchema = queryParamsSchema(parsed.data.method);
      const params = paramsSchema?.safeParse(parsed.data.params);
      if (params && !params.success) throw new BridgeError('INVALID_REQUEST', 'Invalid params');
      const result = await this.options.runtime.request(
        context,
        parsed.data.method,
        params?.data ?? parsed.data.params,
      );
      this.json(response, 200, validateRuntimeResponse(parsed.data.method, result));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/commands') {
      const context = this.requestContext(request);
      const parsed = commandRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid request');
      if (parsed.data.method === 'user.switch' || parsed.data.method === 'runtime.retry') {
        throw new BridgeError('INVALID_REQUEST', 'Method is unavailable through the service');
      }
      const result = await this.options.runtime.request(
        context,
        parsed.data.method,
        parsed.data.params,
      );
      this.json(response, 200, validateRuntimeResponse(parsed.data.method, result));
      return;
    }

    const eventsMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (method === 'GET' && eventsMatch?.[1]) {
      const sessionId = decodeURIComponent(eventsMatch[1]);
      const afterSeq = parseAfterSeq(url.searchParams.get('afterSeq'));
      await this.streamSessionEvents(response, this.requestContext(request), sessionId, afterSeq);
      return;
    }

    throw new BridgeError('INVALID_REQUEST', 'Unknown endpoint');
  }

  private requestContext(request: IncomingMessage): RequestContext {
    const auth = this.options.auth.authenticate(bearerToken(request));
    return {
      requestId: requestId(request),
      connectionId: connectionId(request),
      authSessionId: auth.id,
      userId: auth.userId,
      clientKind: auth.clientKind,
    };
  }

  private async streamSessionEvents(
    response: ServerResponse,
    context: RequestContext,
    sessionId: string,
    afterSeq: number,
  ): Promise<void> {
    await this.options.runtime.request(context, 'session.snapshot', { sessionId });
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.sseResponses.add(response);
    let cursor = afterSeq;
    let replaying = true;
    const queued: SessionEventBatch[] = [];
    const unsubscribe = this.options.runtime.subscribe((batch) => {
      if (batch.userId !== context.userId || batch.sessionId !== sessionId) return;
      if (replaying) queued.push(batch);
      else cursor = writeBatch(response, batch.events, cursor);
    });
    const heartbeat = setInterval(() => {
      if (!safeWrite(response, ': heartbeat\n\n')) response.destroy();
    }, SSE_HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.sseResponses.delete(response);
    };
    response.once('close', cleanup);
    try {
      while (!response.destroyed) {
        const page = (await this.options.runtime.request(context, 'session.events.page', {
          sessionId,
          afterSeq: cursor,
          limit: 500,
        })) as { items?: SessionLogEvent[]; nextAfterSeq?: number | null };
        const items = Array.isArray(page.items) ? page.items : [];
        cursor = writeBatch(response, items, cursor);
        if (page.nextAfterSeq === null || page.nextAfterSeq === undefined || items.length === 0) {
          break;
        }
      }
      replaying = false;
      for (const batch of queued) cursor = writeBatch(response, batch.events, cursor);
      safeWrite(response, `event: ready\ndata: ${JSON.stringify({ cursor })}\n\n`);
    } catch (error) {
      cleanup();
      response.destroy(error instanceof Error ? error : undefined);
    }
  }

  private requireBootstrap(request: IncomingMessage): void {
    const supplied = header(request, 'x-agent-bootstrap');
    if (!safeSecretEqual(supplied, this.options.bootstrapToken)) {
      throw new BridgeError('AUTHORIZATION_FAILED', 'Local bootstrap credential required');
    }
  }

  private rejectBrowserOrigin(request: IncomingMessage): void {
    if (header(request, 'origin')) {
      throw new BridgeError('AUTHORIZATION_FAILED', 'Browser origins are not allowed');
    }
  }

  private enforceRateLimit(request: IncomingMessage, action: string): void {
    if (!this.loginLimiter.take(rateLimitKey(request, action), Date.now())) {
      throw new BridgeError('RATE_LIMITED', 'Too many authentication attempts');
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.destroyed) return;
    const json = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': JSON_CONTENT_TYPE,
      'content-length': Buffer.byteLength(json),
    });
    response.end(json);
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    const payload = toErrorPayload(error);
    this.options.logger.warn('gateway request rejected', { errorCode: payload.code });
    this.json(response, statusFor(payload.code), { error: payload });
  }
}

class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, now: number): boolean {
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.maxAttempts;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new BridgeError('INVALID_REQUEST', 'Payload too large');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      request.destroy();
      throw new BridgeError('INVALID_REQUEST', 'Payload too large');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BridgeError('INVALID_REQUEST', 'Invalid JSON');
  }
}

function validateRuntimeResponse(method: string, result: unknown): unknown {
  if (method === 'app.bootstrap') {
    const parsed = bootstrapResultSchema.safeParse(result);
    if (!parsed.success) throw new BridgeError('INTERNAL_ERROR', 'Invalid response from runtime');
    return parsed.data;
  }
  if (method === 'system.health') {
    const parsed = healthSnapshotSchema.safeParse(result);
    if (!parsed.success) throw new BridgeError('INTERNAL_ERROR', 'Invalid response from runtime');
    return parsed.data;
  }
  const schema = runtimeResponseSchema(method);
  if (!schema) return result;
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new BridgeError('INTERNAL_ERROR', 'Invalid response from runtime');
  return parsed.data;
}

function bearerToken(request: IncomingMessage): string {
  const authorization = header(request, 'authorization');
  const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(authorization);
  if (!match?.[1]) throw new BridgeError('AUTHENTICATION_REQUIRED', 'Authentication required');
  return match[1];
}

function parseAfterSeq(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BridgeError('INVALID_REQUEST', 'Invalid event cursor');
  }
  return parsed;
}

function parseClientKind(request: IncomingMessage): ClientKind {
  const parsed = clientKindSchema.safeParse(header(request, 'x-agent-client-kind'));
  if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid client kind');
  return parsed.data;
}

function requestId(request: IncomingMessage): string {
  const value = header(request, 'x-request-id');
  return value.length > 0 && value.length <= 128 ? value : randomUUID();
}

function connectionId(request: IncomingMessage): string {
  const value = header(request, 'x-agent-connection-id');
  return value.length > 0 && value.length <= 128 ? value : randomUUID();
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function safeSecretEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function writeBatch(response: ServerResponse, events: SessionLogEvent[], cursor: number): number {
  let next = cursor;
  for (const event of events) {
    if (event.seq <= next) continue;
    if (
      !safeWrite(
        response,
        `id: ${event.seq}\nevent: runtime-event\ndata: ${JSON.stringify(event)}\n\n`,
      )
    ) {
      response.destroy();
      break;
    }
    next = event.seq;
  }
  return next;
}

function safeWrite(response: ServerResponse, value: string): boolean {
  if (response.destroyed || response.writableEnded) return false;
  if (response.writableLength + Buffer.byteLength(value) > MAX_SSE_BUFFER_BYTES) return false;
  return response.write(value);
}

function rateLimitKey(request: IncomingMessage, action: string): string {
  return `${request.socket.remoteAddress ?? 'local'}:${action}`;
}

function statusFor(code: ErrorCode): number {
  switch (code) {
    case 'AUTHENTICATION_REQUIRED':
    case 'AUTHENTICATION_FAILED':
      return 401;
    case 'UNAUTHORIZED_SENDER':
    case 'AUTHORIZATION_FAILED':
      return 403;
    case 'USER_NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'REVISION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'SESSION_BUSY':
    case 'TURN_CHANGED':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'RUNTIME_NOT_READY':
      return 503;
    case 'RUNTIME_RESTARTED':
    case 'RUNTIME_UNAVAILABLE':
    case 'DATABASE_UNAVAILABLE':
      return 503;
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 400;
  }
}
