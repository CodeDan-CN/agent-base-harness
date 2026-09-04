import { z } from 'zod';

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();

export const credentialMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('unchanged') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().min(1).max(16_384) }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
]);
export type CredentialMutation = z.infer<typeof credentialMutationSchema>;

export const modelServiceSaveParamsSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(120),
    providerType: z.enum(['openai-compatible']),
    providerPresetId: z.enum(['deepseek-official', 'alibaba-bailian']).nullable().optional(),
    endpoint: z.string().url().max(2048),
    enabled: z.boolean(),
    config: z.record(z.unknown()).default({}),
    credential: credentialMutationSchema,
    expectedRevision: revision,
  })
  .strict();
export type ModelServiceSaveParams = z.infer<typeof modelServiceSaveParamsSchema>;

export const modelServiceTestParamsSchema = modelServiceSaveParamsSchema
  .omit({ expectedRevision: true })
  .strict();
export type ModelServiceTestParams = z.infer<typeof modelServiceTestParamsSchema>;

export const modelServiceArchiveParamsSchema = z
  .object({ id, expectedRevision: revision })
  .strict();

export const modelSaveParamsSchema = z
  .object({
    id: id.optional(),
    serviceId: id,
    remoteModelId: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(256),
    contextWindow: z.number().int().min(1024).max(4_000_000),
    contextWindowOverride: z.number().int().min(1024).max(4_000_000).nullable().optional(),
    compactionTriggerRatio: z.number().min(0.5).max(0.95).optional(),
    inputCapability: z.number().int().min(1).max(4_000_000).nullable().optional(),
    maxOutputCapability: z.number().int().min(1).max(1_000_000).nullable().optional(),
    requestMaxOutputTokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
    metadataSource: z.enum(['manual', 'endpoint', 'catalog', 'fallback', 'legacy']).optional(),
    catalogVersion: z.string().nullable().optional(),
    capabilityProfileRef: z.string().nullable().optional(),
    capabilityMatchKind: z
      .enum([
        'profile',
        'preset',
        'host',
        'model-unique',
        'model-consensus',
        'manual',
        'unresolved',
      ])
      .optional(),
    thinkingMode: z.enum(['auto', 'enabled', 'disabled']).optional(),
    reasoningEffort: z
      .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .nullable()
      .optional(),
    capabilities: z
      .object({ tools: z.boolean(), streaming: z.boolean(), vision: z.boolean().default(false) })
      .strict(),
    defaultParams: z.record(z.unknown()).default({}),
    enabled: z.boolean(),
    expectedRevision: revision,
  })
  .strict();
export type ModelSaveParams = z.infer<typeof modelSaveParamsSchema>;

export const modelArchiveParamsSchema = z.object({ id, expectedRevision: revision }).strict();
export const modelDefaultSetParamsSchema = z
  .object({ modelId: id, expectedRevision: revision })
  .strict();
export const modelDiscoverParamsSchema = z.object({ serviceId: id }).strict();

export const skillToggleParamsSchema = z
  .object({ skillName: id, expectedRevision: revision })
  .strict();

export const capabilityCategoryCreateParamsSchema = z
  .object({
    type: z.enum(['skill', 'mcp']),
    name: z.string().trim().min(1).max(40),
    expectedRevision: revision,
  })
  .strict();
export const capabilityCategoryRenameParamsSchema = z
  .object({
    type: z.enum(['skill', 'mcp']),
    id,
    name: z.string().trim().min(1).max(40),
    expectedRevision: revision,
  })
  .strict();
export const capabilityCategoryDeleteParamsSchema = z
  .object({ type: z.enum(['skill', 'mcp']), id, expectedRevision: revision })
  .strict();
export const skillCategorySetParamsSchema = z
  .object({ skillName: id, categoryId: id, expectedRevision: revision })
  .strict();

const capabilityCategorySchema = z
  .object({
    id: z.string(),
    type: z.enum(['skill', 'mcp']),
    name: z.string(),
    sortOrder: z.number().int(),
    system: z.boolean(),
  })
  .strict();

export const modelManagementSnapshotSchema = z
  .object({
    revision,
    defaultModelId: z.string().nullable(),
    services: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          providerType: z.string(),
          providerPresetId: z.string().nullable(),
          endpoint: z.string(),
          status: z.enum(['enabled', 'disabled', 'archived']),
          credentialStatus: z.enum(['configured', 'missing']),
          config: z.record(z.unknown()),
          modelCount: z.number().int().nonnegative(),
          agentReady: z.boolean(),
        })
        .strict(),
    ),
    models: z.array(
      z
        .object({
          id: z.string(),
          serviceId: z.string(),
          remoteModelId: z.string(),
          displayName: z.string(),
          contextWindow: z.number().int().positive().nullable(),
          automaticContextWindow: z.number().int().positive().nullable(),
          contextWindowOverride: z.number().int().positive().nullable(),
          compactionTriggerRatio: z.number().min(0.5).max(0.95),
          maxOutputTokens: z.number().int().positive().nullable(),
          inputCapability: z.number().int().positive().nullable(),
          maxOutputCapability: z.number().int().positive().nullable(),
          requestMaxOutputTokens: z.number().int().positive().nullable(),
          metadataSource: z.enum(['manual', 'endpoint', 'catalog', 'fallback', 'legacy']),
          automaticMetadataSource: z.enum(['manual', 'endpoint', 'catalog', 'fallback', 'legacy']),
          catalogVersion: z.string().nullable(),
          capabilityProfileRef: z.string().nullable(),
          capabilityMatchKind: z.enum([
            'profile',
            'preset',
            'host',
            'model-unique',
            'model-consensus',
            'manual',
            'unresolved',
          ]),
          thinkingMode: z.enum(['auto', 'enabled', 'disabled']),
          reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
          supportedReasoningEfforts: z.array(
            z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
          ),
          capabilities: z.record(z.unknown()),
          defaultParams: z.record(z.unknown()),
          source: z.enum(['discovered', 'manual']),
          status: z.enum(['enabled', 'disabled', 'archived']),
        })
        .strict(),
    ),
  })
  .strict();
export type ModelManagementSnapshot = z.infer<typeof modelManagementSnapshotSchema>;

export const modelDiscoveryResultSchema = z
  .object({
    serviceId: z.string(),
    remoteModelIds: z.array(z.string()),
    models: z
      .array(
        z
          .object({
            id: z.string(),
            contextWindow: z.number().int().positive().nullable(),
            inputCapability: z.number().int().positive().nullable(),
            maxOutputCapability: z.number().int().positive().nullable(),
            metadataSource: z.enum(['endpoint', 'catalog', 'fallback']),
            capabilityMatchKind: z.enum([
              'profile',
              'preset',
              'host',
              'model-unique',
              'model-consensus',
              'unresolved',
            ]),
            conflicts: z.array(z.string()),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ModelDiscoveryResult = z.infer<typeof modelDiscoveryResultSchema>;

export const modelServiceTestResultSchema = z
  .object({ status: z.enum(['success', 'auth', 'network', 'timeout', 'protocol']) })
  .strict();

export const skillManagementSnapshotSchema = z
  .object({
    revision,
    categories: z.array(capabilityCategorySchema),
    skills: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          categoryId: z.string(),
          sourceType: z.string(),
          enabled: z.boolean(),
          status: z.string(),
          compatibilityStatus: z.string(),
          contentDigest: z.string(),
          metadata: z.record(z.unknown()),
        })
        .strict(),
    ),
  })
  .strict();
export type SkillManagementSnapshot = z.infer<typeof skillManagementSnapshotSchema>;

const mcpStdioConfigSchema = z
  .object({
    command: z.string().trim().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(100).default([]),
    cwd: z.string().trim().min(1).max(4096).optional(),
    env: z.record(z.string().max(16_384)).default({}),
  })
  .strict();

const mcpHttpConfigSchema = z
  .object({
    url: z.string().url().max(4096),
    local: z.boolean().default(false),
  })
  .strict();

export const mcpServerSaveParamsSchema = z.discriminatedUnion('transport', [
  z
    .object({
      id: id.optional(),
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z0-9_-]+$/),
      summary: z.string().trim().max(300),
      categoryId: id,
      transport: z.literal('stdio'),
      config: mcpStdioConfigSchema,
      enabled: z.boolean(),
      credential: credentialMutationSchema,
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      id: id.optional(),
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z0-9_-]+$/),
      summary: z.string().trim().max(300),
      categoryId: id,
      transport: z.literal('streamable-http'),
      config: mcpHttpConfigSchema,
      enabled: z.boolean(),
      credential: credentialMutationSchema,
      expectedRevision: revision,
    })
    .strict(),
]);
export type McpServerSaveParams = z.infer<typeof mcpServerSaveParamsSchema>;

export const mcpServerTestParamsSchema = z.discriminatedUnion('transport', [
  mcpServerSaveParamsSchema.options[0].omit({ expectedRevision: true }),
  mcpServerSaveParamsSchema.options[1].omit({ expectedRevision: true }),
]);
export type McpServerTestParams = z.infer<typeof mcpServerTestParamsSchema>;

export const mcpServerTargetParamsSchema = z.object({ id, expectedRevision: revision }).strict();

export const mcpToolToggleParamsSchema = z
  .object({
    serverId: id,
    rawName: z.string().min(1).max(256),
    enabled: z.boolean(),
    expectedRevision: revision,
  })
  .strict();

export const mcpManagementSnapshotSchema = z
  .object({
    revision,
    categories: z.array(capabilityCategorySchema),
    servers: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          summary: z.string(),
          categoryId: z.string(),
          transport: z.enum(['stdio', 'streamable-http']),
          status: z.enum(['enabled', 'disabled']),
          config: z.record(z.unknown()),
          credentialStatus: z.enum(['configured', 'missing']),
          connectionStatus: z.enum(['disconnected', 'connecting', 'connected', 'error']),
          generation: z.number().int().nonnegative(),
          lastError: z.string().nullable(),
          toolCount: z.number().int().nonnegative(),
          enabledToolCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    tools: z.array(
      z
        .object({
          serverId: z.string(),
          rawName: z.string(),
          publicName: z.string(),
          description: z.string(),
          inputSchema: z.record(z.unknown()),
          outputSchema: z.record(z.unknown()).nullable(),
          schemaDigest: z.string(),
          enabled: z.boolean(),
          reviewStatus: z.enum(['pending', 'approved', 'changed']),
          approvalPolicy: z.enum(['never', 'always']),
          generation: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type McpManagementSnapshot = z.infer<typeof mcpManagementSnapshotSchema>;
