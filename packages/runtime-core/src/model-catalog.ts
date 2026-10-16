import { z } from 'zod';

export const MODEL_CATALOG_SCHEMA_VERSION = 1;

const positiveInteger = z.number().int().positive();

export const modelCatalogSchema = z
  .object({
    schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION),
    source: z.literal('https://models.dev/api.json'),
    generatedAt: z.string().min(1),
    providers: z
      .array(
        z
          .object({
            id: z.string().min(1),
            apiHosts: z.array(z.string().min(1)),
            models: z
              .array(
                z
                  .object({
                    id: z.string().min(1),
                    context: positiveInteger,
                    input: positiveInteger.optional(),
                    output: positiveInteger,
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type CatalogModel = ModelCatalog['providers'][number]['models'][number];

export type CapabilityMatchKind =
  'profile' | 'preset' | 'host' | 'model-unique' | 'model-consensus' | 'unresolved';

export interface ModelCapabilityMatch {
  model: CatalogModel | null;
  providerId: string | null;
  matchKind: CapabilityMatchKind;
  conflicts: string[];
}

export function validateCatalog(value: unknown): ModelCatalog {
  return modelCatalogSchema.parse(value);
}

/** 将 models.dev 全量结构转换为 Client 内置的最小稳定目录。 */
export function simplifyModelsDevCatalog(value: unknown, generatedAt: string): ModelCatalog {
  const root = record(value);
  if (!root) throw new Error('MODEL_CATALOG_SOURCE_INVALID');

  const providers = Object.entries(root)
    .map(([key, rawProvider]) => simplifyProvider(key, rawProvider))
    .filter((provider): provider is ModelCatalog['providers'][number] => provider !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  return validateCatalog({
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    source: 'https://models.dev/api.json',
    generatedAt,
    providers,
  });
}

export function matchModelCapability(
  catalog: ModelCatalog,
  input: {
    modelId: string;
    apiEndpoint?: string | null;
    providerPresetId?: string | null;
    capabilityProfileRef?: string | null;
  },
): ModelCapabilityMatch {
  const normalizedModelId = normalizeModelId(input.modelId);

  if (input.capabilityProfileRef) {
    const [providerId, ...modelParts] = input.capabilityProfileRef.split(':');
    const modelId = modelParts.join(':');
    const exact = findModel(catalog, providerId ?? '', modelId);
    if (exact)
      return { model: exact, providerId: providerId ?? null, matchKind: 'profile', conflicts: [] };
  }

  const presetProvider = providerIdForPreset(input.providerPresetId);
  if (presetProvider) {
    const exact = findModel(catalog, presetProvider, input.modelId);
    if (exact)
      return { model: exact, providerId: presetProvider, matchKind: 'preset', conflicts: [] };
  }

  const endpointHost = hostOf(input.apiEndpoint);
  if (endpointHost) {
    for (const provider of catalog.providers) {
      if (!provider.apiHosts.some((host) => hostsMatch(host, endpointHost))) continue;
      const exact = provider.models.find(
        (model) => normalizeModelId(model.id) === normalizedModelId,
      );
      if (exact) return { model: exact, providerId: provider.id, matchKind: 'host', conflicts: [] };
    }
  }

  const matches = catalog.providers.flatMap((provider) =>
    provider.models
      .filter((model) => normalizeModelId(model.id) === normalizedModelId)
      .map((model) => ({ providerId: provider.id, model })),
  );
  if (matches.length === 1) {
    return {
      model: matches[0]!.model,
      providerId: matches[0]!.providerId,
      matchKind: 'model-unique',
      conflicts: [],
    };
  }
  if (matches.length > 1) {
    const signatures = new Set(
      matches.map(({ model }) => `${model.context}:${model.input ?? ''}:${model.output}`),
    );
    if (signatures.size === 1) {
      return {
        model: matches[0]!.model,
        providerId: null,
        matchKind: 'model-consensus',
        conflicts: matches.map(({ providerId }) => providerId),
      };
    }
    const context = uniqueMode(matches.map(({ model }) => model.context));
    const input = uniqueMode(matches.map(({ model }) => model.input ?? null));
    const output = uniqueMode(matches.map(({ model }) => model.output));
    const representative = matches.find(
      ({ model }) =>
        model.context === context && (model.input ?? null) === input && model.output === output,
    );
    if (context !== undefined && input !== undefined && output !== undefined && representative) {
      return {
        model: representative.model,
        providerId: null,
        matchKind: 'model-consensus',
        conflicts: matches.map(({ providerId }) => providerId),
      };
    }
    return {
      model: null,
      providerId: null,
      matchKind: 'unresolved',
      conflicts: matches.map(({ providerId }) => providerId),
    };
  }
  return { model: null, providerId: null, matchKind: 'unresolved', conflicts: [] };
}

function simplifyProvider(
  fallbackId: string,
  value: unknown,
): ModelCatalog['providers'][number] | null {
  const provider = record(value);
  if (!provider) return null;
  const id = stringValue(provider.id) ?? fallbackId;
  const apiHosts = collectApiHosts(provider);
  const modelsRecord = record(provider.models);
  const modelEntries = modelsRecord
    ? Object.entries(modelsRecord)
    : Array.isArray(provider.models)
      ? provider.models.map((model, index) => [String(index), model] as const)
      : [];
  const models = modelEntries
    .map(([key, rawModel]) => simplifyModel(key, rawModel))
    .filter((model): model is CatalogModel => model !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  return models.length > 0 ? { id, apiHosts, models } : null;
}

function simplifyModel(fallbackId: string, value: unknown): CatalogModel | null {
  const model = record(value);
  if (!model) return null;
  const limits = record(model.limit) ?? record(model.limits) ?? model;
  const context = positiveIntegerValue(limits.context);
  const input = positiveIntegerValue(limits.input);
  const output = positiveIntegerValue(limits.output);
  if (!context || !output) return null;
  return {
    id: stringValue(model.id) ?? fallbackId,
    context,
    ...(input ? { input } : {}),
    output,
  };
}

function collectApiHosts(provider: Record<string, unknown>): string[] {
  const candidates = [provider.apiHosts, provider.api, provider.baseURL, provider.baseUrl].flatMap(
    (value) => (Array.isArray(value) ? value : [value]),
  );
  return [...new Set(candidates.map(hostOf).filter((host): host is string => Boolean(host)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function findModel(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
): CatalogModel | null {
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  return (
    provider?.models.find((model) => normalizeModelId(model.id) === normalizeModelId(modelId)) ??
    null
  );
}

function providerIdForPreset(presetId: string | null | undefined): string | null {
  if (presetId === 'deepseek-official') return 'deepseek';
  if (presetId === 'alibaba-bailian') return 'alibaba';
  return null;
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostsMatch(catalogHost: string, endpointHost: string): boolean {
  const normalized = catalogHost.replace(/^\*\./, '').toLowerCase();
  return endpointHost === normalized || endpointHost.endsWith(`.${normalized}`);
}

function normalizeModelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function uniqueMode<T extends string | number | null>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  if (!ranked[0] || ranked[0][1] === ranked[1]?.[1]) return undefined;
  return ranked[0][0];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveIntegerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
