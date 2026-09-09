/** Stage 1 Bridge 的固定 channel、方法与可信上下文契约。 */

import { z } from 'zod';
import type { LocalUserId } from '../domain/user';
import type { BridgeErrorPayload } from './errors';
import type { SessionLogEvent } from '../domain/session';

/** Preload 固化的 channel，Renderer 无法构造任意 channel。 */
export const IPC_CHANNELS = {
  authRegister: 'agent-client:auth-register',
  authLogin: 'agent-client:auth-login',
  authLogout: 'agent-client:auth-logout',
  authMe: 'agent-client:auth-me',
  query: 'agent-client:query',
  command: 'agent-client:command',
  subscribe: 'agent-client:subscribe',
  unsubscribe: 'agent-client:unsubscribe',
  lifecycle: 'agent-client:lifecycle',
  sessionEvents: 'agent-client:session-events',
  selectSkillDirectory: 'agent-client:select-skill-directory',
  openSessionFile: 'agent-client:open-session-file',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Main 注入 Worker 的可信请求上下文。userId 只来自 Main。 */
export interface TrustedRequestContext {
  requestId: string;
  userId: LocalUserId;
  windowId: string;
  workerGeneration: number;
}

export type QueryMethod =
  | 'app.bootstrap'
  | 'system.health'
  | 'session.list'
  | 'session.snapshot'
  | 'session.events.page'
  | 'conversation.event.list'
  | 'conversation.event.read'
  | 'execution.turn.list'
  | 'execution.turn.read'
  | 'model-management.snapshot'
  | 'model-call-statistics.query'
  | 'skill-management.snapshot'
  | 'mcp-management.snapshot'
  | 'agent-management.snapshot'
  | 'agent.navigation'
  | 'agent.delegation.get';
export type CommandMethod =
  | 'user.switch'
  | 'runtime.retry'
  | 'session.create'
  | 'session.rename'
  | 'session.archive'
  | 'input.submit'
  | 'inbox.remove'
  | 'inbox.replace'
  | 'inbox.promote'
  | 'turn.cancel'
  | 'turn.cancel-and-queue'
  | 'interaction.resolve'
  | 'approval.resolve'
  | 'permission.preset.set'
  | 'model-service.save'
  | 'model-service.test'
  | 'model-service.archive'
  | 'model.save'
  | 'model.archive'
  | 'model.default.set'
  | 'model.discover'
  | 'skill.enable'
  | 'skill.disable'
  | 'skill.install.directory'
  | 'skill.description.update'
  | 'skill.delete'
  | 'skill.category.set'
  | 'capability-category.create'
  | 'capability-category.rename'
  | 'capability-category.delete'
  | 'mcp-server.save'
  | 'mcp-server.test'
  | 'mcp-server.archive'
  | 'mcp-server.refresh'
  | 'mcp-tool.toggle'
  | 'agent.create'
  | 'agent.update'
  | 'agent.runtime.defaults.set'
  | 'agent.archive'
  | 'agent.default.set'
  | 'agent.home.add'
  | 'agent.home.remove'
  | 'agent.home.reorder'
  | 'agent.skill.toggle'
  | 'agent.mcp.toggle'
  | 'agent.delegate.toggle';

export interface QueryRequest {
  method: QueryMethod;
  params?: unknown;
}

export interface CommandRequest {
  method: CommandMethod;
  params?: unknown;
}

/** Renderer 可见的 Bridge 客户端 API（Preload 通过 contextBridge 暴露）。 */
export interface AgentClientApi {
  register(input: { loginName: string; password: string }): Promise<RpcEnvelope>;
  login(input: { loginName: string; password: string }): Promise<RpcEnvelope>;
  logout(): Promise<RpcEnvelope>;
  currentAuth(): Promise<RpcEnvelope>;
  query(method: QueryMethod, params?: unknown): Promise<RpcEnvelope>;
  command(method: CommandMethod, params?: unknown): Promise<RpcEnvelope>;
  subscribeLifecycle(listener: (event: LifecycleEvent) => void): () => void;
  subscribeSession(
    sessionId: string,
    afterSeq: number,
    listener: (event: SessionSubscriptionEvent) => void,
  ): () => void;
  selectAndInstallSkill(): Promise<RpcEnvelope>;
  openSessionFile(sessionId: string, target: string): Promise<RpcEnvelope>;
}

export const sessionFileOpenSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    target: z.string().min(1).max(4096),
  })
  .strict();

/** Main 返回的统一响应信封。 */
export type RpcEnvelope = { ok: true; result: unknown } | { ok: false; error: BridgeErrorPayload };

/** 生命周期订阅事件，由 Main 发布。 */
export type LifecycleEvent =
  | { type: 'runtime'; status: RuntimeWorkerStatus; generation: number }
  | { type: 'user-changed'; userId: LocalUserId };

export interface SessionEventBatch {
  userId: LocalUserId;
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  events: SessionLogEvent[];
}

export type SessionSubscriptionEvent =
  | {
      type: 'events';
      subscriptionId?: string;
      sessionId: string;
      fromSeq: number;
      toSeq: number;
      events: SessionLogEvent[];
    }
  | {
      type: 'resync-required';
      subscriptionId?: string;
      sessionId: string;
      expectedSeq: number;
      receivedSeq: number;
    };

export const sessionSubscriptionRequestSchema = z
  .object({
    kind: z.literal('session'),
    subscriptionId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    afterSeq: z.number().int().nonnegative(),
  })
  .strict();

export const sessionUnsubscriptionRequestSchema = z
  .object({
    kind: z.literal('session'),
    subscriptionId: z.string().min(1).max(128),
  })
  .strict();

const sessionLogEventSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  seq: z.number().int().positive(),
  eventId: z.string(),
  eventType: z.string(),
  schemaVersion: z.number().int().positive(),
  occurredAt: z.string(),
  requestId: z.string().nullable(),
  idempotencyKey: z.string().nullable().optional(),
  payload: z.unknown(),
});

export const sessionSubscriptionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('events'),
    subscriptionId: z.string().optional(),
    sessionId: z.string(),
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    events: z.array(sessionLogEventSchema),
  }),
  z.object({
    type: z.literal('resync-required'),
    subscriptionId: z.string().optional(),
    sessionId: z.string(),
    expectedSeq: z.number().int().positive(),
    receivedSeq: z.number().int().positive(),
  }),
]);

export const RUNTIME_WORKER_STATUSES = [
  'stopped',
  'starting',
  'ready',
  'restarting',
  'failed',
  'stopping',
] as const;

export const runtimeWorkerStatusSchema = z.enum(RUNTIME_WORKER_STATUSES);

export type RuntimeWorkerStatus = z.infer<typeof runtimeWorkerStatusSchema>;

export const lifecycleEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('runtime'),
    status: runtimeWorkerStatusSchema,
    generation: z.number(),
  }),
  z.object({ type: z.literal('user-changed'), userId: z.string() }),
]);
