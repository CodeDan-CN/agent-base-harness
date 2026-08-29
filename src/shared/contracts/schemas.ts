/** IPC 请求与参数的运行时 Schema 校验（zod）。 */

import { z } from 'zod';
import {
  eventReadParamsSchema,
  eventsPageParamsSchema,
  inboxPromoteParamsSchema,
  inboxRemoveParamsSchema,
  inboxReplaceParamsSchema,
  inputSubmitParamsSchema,
  interactionResolveParamsSchema,
  sessionArchiveParamsSchema,
  sessionCreateParamsSchema,
  sessionRenameParamsSchema,
  sessionTargetSchema,
  turnCancelAndQueueParamsSchema,
  turnCancelParamsSchema,
  turnReadParamsSchema,
} from '../../client-contracts/runtime';
import {
  modelArchiveParamsSchema,
  modelDefaultSetParamsSchema,
  modelDiscoverParamsSchema,
  modelDiscoveryResultSchema,
  modelManagementSnapshotSchema,
  modelSaveParamsSchema,
  modelServiceArchiveParamsSchema,
  modelServiceSaveParamsSchema,
  modelServiceTestParamsSchema,
  modelServiceTestResultSchema,
  mcpManagementSnapshotSchema,
  mcpServerSaveParamsSchema,
  mcpServerTargetParamsSchema,
  mcpServerTestParamsSchema,
  mcpToolToggleParamsSchema,
  skillManagementSnapshotSchema,
  skillToggleParamsSchema,
} from './management';
import { modelCallStatisticsParamsSchema, modelCallStatisticsSnapshotSchema } from './statistics';

/** Stage 1 Bridge API 版本。preload 请求必须携带，不支持版本明确拒绝。 */
export const API_VERSION = 1;

export const switchUserParamsSchema = z
  .object({
    userId: z.string().min(1).max(128),
  })
  .strict();
export type SwitchUserParams = z.infer<typeof switchUserParamsSchema>;

export const queryRequestSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    method: z.enum([
      'app.bootstrap',
      'system.health',
      'session.list',
      'session.snapshot',
      'session.events.page',
      'conversation.event.list',
      'conversation.event.read',
      'execution.turn.list',
      'execution.turn.read',
      'model-management.snapshot',
      'model-call-statistics.query',
      'skill-management.snapshot',
      'mcp-management.snapshot',
    ]),
    params: z.unknown().optional(),
  })
  .strict();
export type QueryRequestSchema = z.infer<typeof queryRequestSchema>;

export const commandRequestSchema = z.discriminatedUnion('method', [
  z
    .object({
      apiVersion: z.literal(API_VERSION),
      method: z.literal('user.switch'),
      params: switchUserParamsSchema,
    })
    .strict(),
  z
    .object({
      apiVersion: z.literal(API_VERSION),
      method: z.literal('runtime.retry'),
      params: z.undefined().optional(),
    })
    .strict(),
  command('session.create', sessionCreateParamsSchema),
  command('session.rename', sessionRenameParamsSchema),
  command('session.archive', sessionArchiveParamsSchema),
  command('input.submit', inputSubmitParamsSchema),
  command('inbox.remove', inboxRemoveParamsSchema),
  command('inbox.replace', inboxReplaceParamsSchema),
  command('inbox.promote', inboxPromoteParamsSchema),
  command('turn.cancel', turnCancelParamsSchema),
  command('turn.cancel-and-queue', turnCancelAndQueueParamsSchema),
  command('interaction.resolve', interactionResolveParamsSchema),
  command('model-service.save', modelServiceSaveParamsSchema),
  command('model-service.test', modelServiceTestParamsSchema),
  command('model-service.archive', modelServiceArchiveParamsSchema),
  command('model.save', modelSaveParamsSchema),
  command('model.archive', modelArchiveParamsSchema),
  command('model.default.set', modelDefaultSetParamsSchema),
  command('model.discover', modelDiscoverParamsSchema),
  command('skill.enable', skillToggleParamsSchema),
  command('skill.disable', skillToggleParamsSchema),
  command('mcp-server.save', mcpServerSaveParamsSchema),
  command('mcp-server.test', mcpServerTestParamsSchema),
  command('mcp-server.archive', mcpServerTargetParamsSchema),
  command('mcp-server.refresh', z.object({ id: z.string().min(1).max(128) }).strict()),
  command('mcp-tool.toggle', mcpToolToggleParamsSchema),
]);
export type CommandRequestSchema = z.infer<typeof commandRequestSchema>;

/** 请求 envelope 体积上限（UTF-8 字节），超限由 Main 在转发 Worker 前拒绝。 */
export const MAX_REQUEST_BYTES = 64 * 1024;

export const sessionSubscriptionSchema = z
  .object({
    kind: z.literal('session'),
    sessionId: z.string().min(1),
    afterSeq: z.number().int().min(0),
  })
  .strict();

export function queryParamsSchema(method: string): z.ZodTypeAny | undefined {
  switch (method) {
    case 'session.snapshot':
    case 'conversation.event.list':
    case 'execution.turn.list':
      return sessionTargetSchema;
    case 'session.events.page':
      return eventsPageParamsSchema;
    case 'conversation.event.read':
      return eventReadParamsSchema;
    case 'execution.turn.read':
      return turnReadParamsSchema;
    case 'model-call-statistics.query':
      return modelCallStatisticsParamsSchema;
    default:
      return undefined;
  }
}

const sessionResultSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    title: z.string(),
    status: z.enum(['active', 'archived']),
    nextSeq: z.number().int().positive(),
    version: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
const acknowledgementSchema = z.object({ sessionId: z.string() }).passthrough();
const inboxResultSchema = z.object({ inboxItemId: z.string() }).passthrough();

/** Main 对 Worker 返回值做最小稳定形状校验，阻止损坏结果进入 Renderer。 */
export function runtimeResponseSchema(method: string): z.ZodTypeAny | undefined {
  switch (method) {
    case 'session.create':
      return sessionResultSchema;
    case 'session.rename':
    case 'session.archive':
      return acknowledgementSchema;
    case 'input.submit':
    case 'inbox.remove':
    case 'inbox.replace':
    case 'inbox.promote':
      return inboxResultSchema;
    case 'turn.cancel':
      return z.object({ turnId: z.string(), status: z.literal('cancelling') }).passthrough();
    case 'turn.cancel-and-queue':
      return z.object({ turnId: z.string(), inboxItemId: z.string() }).passthrough();
    case 'interaction.resolve':
      return z
        .object({ interactionId: z.string(), inboxItemId: z.string().nullable() })
        .passthrough();
    case 'model-service.save':
    case 'model-service.archive':
    case 'model.save':
    case 'model.archive':
      return z.object({ id: z.string() }).passthrough();
    case 'model-service.test':
      return modelServiceTestResultSchema;
    case 'model.default.set':
      return z.object({ modelId: z.string() }).strict();
    case 'model.discover':
      return modelDiscoveryResultSchema;
    case 'skill.enable':
    case 'skill.disable':
      return z.object({ skillName: z.string(), enabled: z.boolean() }).strict();
    case 'mcp-server.save':
    case 'mcp-server.archive':
      return z.object({ id: z.string() }).strict();
    case 'mcp-server.test':
      return z
        .object({
          status: z.enum(['success', 'network', 'protocol']),
          toolCount: z.number().int().nonnegative(),
        })
        .strict();
    case 'mcp-server.refresh':
      return z
        .object({ id: z.string(), toolCount: z.number().int().nonnegative() })
        .strict();
    case 'mcp-tool.toggle':
      return z
        .object({ serverId: z.string(), rawName: z.string(), enabled: z.boolean() })
        .strict();
    case 'session.list':
      return z.array(sessionResultSchema);
    case 'session.snapshot':
      return z
        .object({ session: sessionResultSchema, throughSeq: z.number().int().nonnegative() })
        .passthrough();
    case 'session.events.page':
      return z
        .object({ items: z.array(z.unknown()), nextAfterSeq: z.number().int().nullable() })
        .passthrough();
    case 'conversation.event.list':
    case 'execution.turn.list':
      return z.array(z.object({}).passthrough());
    case 'conversation.event.read':
    case 'execution.turn.read':
      return z.object({ id: z.string() }).passthrough();
    case 'model-management.snapshot':
      return modelManagementSnapshotSchema;
    case 'model-call-statistics.query':
      return modelCallStatisticsSnapshotSchema;
    case 'skill-management.snapshot':
      return skillManagementSnapshotSchema;
    case 'mcp-management.snapshot':
      return mcpManagementSnapshotSchema;
    default:
      return undefined;
  }
}

function command<T extends string, S extends z.ZodTypeAny>(method: T, params: S) {
  return z
    .object({ apiVersion: z.literal(API_VERSION), method: z.literal(method), params })
    .strict();
}
