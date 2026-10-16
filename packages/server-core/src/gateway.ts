import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { URL } from 'node:url';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../../execution/src/logging/logger';
import type { RuntimeFacade, RequestContext } from './runtime-facade';
import { BridgeError, toErrorPayload, type ErrorCode } from '../../protocol/src/contracts/errors';
import {
  MAX_REQUEST_BYTES,
  commandRequestSchema,
  queryParamsSchema,
  queryRequestSchema,
  runtimeResponseSchema,
} from '../../protocol/src/contracts/schemas';
import {
  clientKindSchema,
  clientUserSchema,
  CLIENT_USER_HEADER,
  type ClientKind,
} from '../../protocol/src/contracts/auth';
import type { SessionEventBatch } from '../../protocol/src/contracts/ipc';
import type { SessionLogEvent } from '../../protocol/src/domain/session';
import { bootstrapResultSchema } from '../../protocol/src/contracts/bootstrap';
import { healthSnapshotSchema } from '../../protocol/src/contracts/health';
import { resolveSessionFile } from '../../execution/src/files/session-file';
import { extractSkillArchive } from '../../execution/src/files/skill-archive';
import { storeSessionFile } from '../../execution/src/files/session-file-upload';
import {
  MAX_SESSION_FILE_BYTES,
  sessionFileNameSchema,
} from '../../protocol/src/contracts/session-file';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SKILL_ARCHIVE_BYTES = 20 * 1024 * 1024;

export interface GatewayOptions {
  runtime: RuntimeFacade;
  bootstrapToken: string;
  logger: Logger;
  version: string;
  instanceId: string;
  appDataDir?: string;
  webRoot?: string;
  onStopRequested?: () => void;
}

export interface GatewayAddress {
  host: string;
  port: number;
  baseUrl: string;
}

export class Gateway {
  private readonly server: Server;
  private readonly sseResponses = new Set<ServerResponse>();

  constructor(private readonly options: GatewayOptions) {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        this.handleError(response, error);
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<GatewayAddress> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new BridgeError('RUNTIME_UNAVAILABLE', 'Gateway address unavailable');
    }
    return {
      host,
      port: address.port,
      baseUrl: `http://${isWildcardHost(host) ? '127.0.0.1' : formatUrlHost(host)}:${address.port}`,
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
    response.setHeader('referrer-policy', 'same-origin');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    this.assertBrowserOrigin(request);
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

    if (url.pathname.startsWith('/v1/auth/')) {
      this.json(response, 410, {
        error: {
          code: 'INVALID_REQUEST',
          message:
            'Account management moved to the client. Update the client and supply x-agent-user.',
        },
      });
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

    if (method === 'POST' && url.pathname === '/v1/skills/install') {
      const context = this.requestContext(request);
      const contentType = header(request, 'content-type')?.split(';', 1)[0]?.trim();
      if (contentType !== 'application/zip' && contentType !== 'application/octet-stream') {
        throw new BridgeError('INVALID_REQUEST', 'Skill upload must be a ZIP archive');
      }
      const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-web-upload-'));
      const archivePath = path.join(temporaryRoot, 'skill.zip');
      let extracted: Awaited<ReturnType<typeof extractSkillArchive>> | undefined;
      try {
        writeFileSync(archivePath, await readBody(request, MAX_SKILL_ARCHIVE_BYTES), {
          mode: 0o600,
        });
        extracted = await extractSkillArchive(archivePath);
        const result = await this.options.runtime.request(context, 'skill.install.directory', {
          sourcePath: extracted.skillRoot,
        });
        this.json(response, 200, validateRuntimeResponse('skill.install.directory', result));
      } finally {
        extracted?.cleanup();
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
      return;
    }

    const eventsMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (method === 'GET' && eventsMatch?.[1]) {
      const sessionId = decodeURIComponent(eventsMatch[1]);
      const afterSeq = parseAfterSeq(url.searchParams.get('afterSeq'));
      await this.streamSessionEvents(response, this.requestContext(request), sessionId, afterSeq);
      return;
    }

    const filesMatch = /^\/v1\/sessions\/([^/]+)\/files$/.exec(url.pathname);
    if (method === 'POST' && filesMatch?.[1]) {
      const context = this.requestContext(request);
      const sessionId = decodeURIComponent(filesMatch[1]);
      if (!this.options.appDataDir) {
        throw new BridgeError('INVALID_REQUEST', 'Session uploads are unavailable');
      }
      let name: string;
      try {
        name = sessionFileNameSchema.parse(
          decodeURIComponent(header(request, 'x-agent-file-name') ?? ''),
        );
      } catch {
        throw new BridgeError('INVALID_REQUEST', 'Invalid file name');
      }
      // Resolve identity and verify ownership before consuming or persisting any file bytes.
      await this.options.runtime.request(context, 'session.snapshot', { sessionId });
      const bytes = await readBody(request, MAX_SESSION_FILE_BYTES);
      const file = await storeSessionFile({
        appDataDir: this.options.appDataDir,
        userId: context.userId,
        sessionId,
        name,
        bytes,
      });
      this.json(response, 201, file);
      return;
    }
    if (method === 'GET' && filesMatch?.[1]) {
      const context = this.requestContext(request);
      const sessionId = decodeURIComponent(filesMatch[1]);
      const target = url.searchParams.get('target');
      if (!target || !this.options.appDataDir) {
        throw new BridgeError('INVALID_REQUEST', 'Invalid file request');
      }
      await this.options.runtime.request(context, 'session.snapshot', { sessionId });
      const file = await resolveSessionFile({
        appDataDir: this.options.appDataDir,
        userId: context.userId,
        sessionId,
        target,
      });
      this.file(response, file);
      return;
    }

    if ((method === 'GET' || method === 'HEAD') && this.serveWeb(response, url.pathname, method)) {
      return;
    }

    throw new BridgeError('INVALID_REQUEST', 'Unknown endpoint');
  }

  private requestContext(request: IncomingMessage): RequestContext {
    const value = header(request, CLIENT_USER_HEADER);
    if (!value) throw new BridgeError('AUTHENTICATION_REQUIRED', 'Client user identity required');
    let user;
    try {
      user = clientUserSchema.parse(JSON.parse(decodeURIComponent(value)));
    } catch {
      throw new BridgeError('INVALID_REQUEST', 'Invalid client user identity');
    }
    return {
      requestId: requestId(request),
      connectionId: connectionId(request),
      userId: user.id,
      user,
      clientKind: parseClientKind(request),
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
        const page = (await this.options.runtime.request(context, 'session.events.replay', {
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

  private assertBrowserOrigin(request: IncomingMessage): void {
    const origin = header(request, 'origin');
    if (!origin) return;
    const host = header(request, 'host');
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host)
        return;
    } catch {
      // Fall through to the same-origin rejection.
    }
    throw new BridgeError('AUTHORIZATION_FAILED', 'Cross-origin browser requests are not allowed');
  }

  private serveWeb(response: ServerResponse, pathname: string, method: string): boolean {
    const webRoot = this.options.webRoot;
    if (!webRoot || !existsSync(webRoot)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new BridgeError('INVALID_REQUEST', 'Invalid web path');
    }
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (
      !relative ||
      relative.split('/').some((segment) => !segment || segment === '..' || segment.startsWith('.'))
    ) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid web path');
    }
    const root = path.resolve(webRoot);
    let target = path.resolve(root, relative);
    if (!isInside(root, target) || !isRegularFile(target)) {
      if (path.extname(relative) || relative.startsWith('v1/')) return false;
      target = path.join(root, 'index.html');
      if (!isRegularFile(target)) return false;
    }
    const metadata = statSync(target);
    response.statusCode = 200;
    response.setHeader('content-type', contentTypeFor(target));
    response.setHeader('content-length', metadata.size);
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
        "font-src 'self' data:; connect-src 'self'",
    );
    response.setHeader(
      'cache-control',
      relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    if (method === 'HEAD') response.end();
    else createReadStream(target).pipe(response);
    return true;
  }

  private file(response: ServerResponse, file: string): void {
    const metadata = statSync(file);
    response.statusCode = 200;
    response.setHeader('content-type', contentTypeFor(file));
    response.setHeader('content-length', metadata.size);
    response.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    );
    response.setHeader('content-security-policy', "default-src 'none'; sandbox");
    createReadStream(file).pipe(response);
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, MAX_REQUEST_BYTES);
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new BridgeError('INVALID_REQUEST', 'Invalid JSON');
  }
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new BridgeError('INVALID_REQUEST', 'Payload too large');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      request.destroy();
      throw new BridgeError('INVALID_REQUEST', 'Payload too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

function formatUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRegularFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(target: string): string {
  switch (path.extname(target).toLocaleLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.txt':
    case '.md':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
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
