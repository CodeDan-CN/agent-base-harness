/** app.bootstrap 响应契约（zod 驱动，类型与运行时校验同源）。 */

import { z } from 'zod';
import { runtimeWorkerStatusSchema } from './ipc';

export const localUserSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  sortOrder: z.number(),
  status: z.literal('active'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const userConfigRevisionsSchema = z.object({
  userId: z.string(),
  modelRevision: z.number(),
  skillRevision: z.number(),
  runtimeRevision: z.number(),
  mcpRevision: z.number(),
  agentRevision: z.number(),
  updatedAt: z.string(),
});

export const bootstrapResultSchema = z.object({
  activeUser: localUserSchema,
  users: z.array(localUserSchema),
  runtime: z.object({
    status: runtimeWorkerStatusSchema,
    generation: z.number(),
  }),
  schemaVersion: z.number(),
  defaultAgentId: z.string().min(1),
  revisions: userConfigRevisionsSchema,
  capabilities: z.object({
    model: z.literal('foundation'),
    skill: z.literal('foundation'),
    runtime: z.enum(['pending', 'ready']),
    agentProfiles: z.enum(['pending', 'ready']),
    agentDelegation: z.enum(['pending', 'ready']),
    scopedMcpInstances: z.enum(['pending', 'ready']),
  }),
});

export type BootstrapResult = z.infer<typeof bootstrapResultSchema>;
export type BootstrapLocalUser = z.infer<typeof localUserSchema>;
export type BootstrapRevisions = z.infer<typeof userConfigRevisionsSchema>;
