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
    inputCapability: z.number().int().min(1).max(4_000_000).nullable().optional(),
    maxOutputCapability: z.number().int().min(1).max(1_000_000).nullable().optional(),
    requestMaxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
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
          maxOutputTokens: z.number().int().positive().nullable(),
          inputCapability: z.number().int().positive().nullable(),
          maxOutputCapability: z.number().int().positive().nullable(),
          requestMaxOutputTokens: z.number().int().positive().nullable(),
          metadataSource: z.enum(['manual', 'endpoint', 'catalog', 'fallback', 'legacy']),
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
    skills: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
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
