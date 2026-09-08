import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const revision = z.number().int().nonnegative();
const permissionPreset = z.enum(['approval-required', 'guarded', 'full-access']);

export const agentProfileSchema = z
  .object({
    id,
    userId: id,
    name: z.string(),
    description: z.string(),
    avatarKey: z.string().nullable(),
    instructions: z.string(),
    defaultModelId: z.string().nullable(),
    permissionPreset,
    status: z.enum(['active', 'archived']),
    isDefault: z.boolean(),
    revision,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const agentBindingsSchema = z
  .object({
    skillIds: z.array(id),
    mcp: z.array(
      z
        .object({
          agentId: id,
          serverId: id,
          accessScope: z.enum(['user', 'agent']),
          enabled: z.boolean(),
        })
        .strict(),
    ),
    delegateAgentIds: z.array(id),
  })
  .strict();

export const agentManagementSnapshotSchema = z
  .object({
    revision,
    defaultAgentId: id,
    agents: z.array(
      z.object({ profile: agentProfileSchema, bindings: agentBindingsSchema }).strict(),
    ),
    homeAgentIds: z.array(id),
  })
  .strict();
export type AgentManagementSnapshot = z.infer<typeof agentManagementSnapshotSchema>;

const navigationSessionSchema = z
  .object({
    id,
    userId: id,
    title: z.string(),
    status: z.enum(['active', 'archived']),
    agentId: id,
    origin: z.literal('direct'),
    parentSessionId: z.null(),
    permissionPreset,
    nextSeq: z.number().int().positive(),
    version: revision,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const agentNavigationParamsSchema = z
  .object({ sessionsPerAgent: z.number().int().min(1).max(50).default(20) })
  .strict();

export const agentNavigationSnapshotSchema = z
  .object({
    revision,
    defaultAgentId: id,
    items: z.array(
      z
        .object({
          agent: agentProfileSchema,
          sortOrder: z.number().int().nonnegative(),
          sessions: z.array(navigationSessionSchema),
        })
        .strict(),
    ),
    availableToAdd: z.array(agentProfileSchema),
  })
  .strict();
export type AgentNavigationSnapshot = z.infer<typeof agentNavigationSnapshotSchema>;

const editableProfileFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(''),
  avatarKey: z.string().trim().max(256).nullable().default(null),
  instructions: z.string().max(32_000).default(''),
  defaultModelId: id.nullable().default(null),
  permissionPreset: permissionPreset.default('guarded'),
};

export const agentCreateParamsSchema = z
  .object({ ...editableProfileFields, expectedRevision: revision })
  .strict();
export type AgentCreateParams = z.infer<typeof agentCreateParamsSchema>;

export const agentUpdateParamsSchema = z
  .object({
    agentId: id,
    ...editableProfileFields,
    expectedProfileRevision: revision,
    expectedRevision: revision,
  })
  .strict();
export type AgentUpdateParams = z.infer<typeof agentUpdateParamsSchema>;

export const agentRuntimeDefaultsSetParamsSchema = z
  .object({
    agentId: id,
    defaultModelId: id.nullable(),
    permissionPreset,
    expectedProfileRevision: revision,
    expectedRevision: revision,
  })
  .strict();
export type AgentRuntimeDefaultsSetParams = z.infer<typeof agentRuntimeDefaultsSetParamsSchema>;

export const agentTargetParamsSchema = z
  .object({ agentId: id, expectedRevision: revision })
  .strict();
export const agentHomeReorderParamsSchema = z
  .object({ agentIds: z.array(id).max(100), expectedRevision: revision })
  .strict();
export const agentSkillToggleParamsSchema = z
  .object({ agentId: id, skillId: id, enabled: z.boolean(), expectedRevision: revision })
  .strict();
export const agentMcpToggleParamsSchema = z
  .object({
    agentId: id,
    serverId: id,
    accessScope: z.enum(['user', 'agent']),
    enabled: z.boolean(),
    expectedRevision: revision,
  })
  .strict();
export const agentDelegateToggleParamsSchema = z
  .object({
    callerAgentId: id,
    calleeAgentId: id,
    enabled: z.boolean(),
    expectedRevision: revision,
  })
  .strict();
