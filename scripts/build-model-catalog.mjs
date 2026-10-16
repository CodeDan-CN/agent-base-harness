import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'resources', 'model-catalog.json');
const temporary = `${output}.tmp`;
const sourceFile = process.env.MODEL_CATALOG_SOURCE_FILE;
let source;
let generatedAt;
if (sourceFile) {
  const local = JSON.parse(await readFile(path.resolve(sourceFile), 'utf8'));
  source = local.providers ?? local;
  generatedAt = local.generatedAt ?? new Date().toISOString();
} else {
  const response = await globalThis.fetch('https://models.dev/api.json', {
    signal: globalThis.AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
  source = await response.json();
  generatedAt = response.headers.get('last-modified') ?? new Date().toISOString();
}

const positive = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);
const hostOf = (value) => {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new globalThis.URL(
      value.includes('://') ? value : `https://${value}`,
    ).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
const providers = Object.entries(source)
  .map(([fallbackId, raw]) => {
    const provider = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const apiHosts = [
      ...new Set(
        [provider.apiHosts, provider.api, provider.baseURL, provider.baseUrl]
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .map(hostOf)
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));
    const rawModels = provider.models && typeof provider.models === 'object' ? provider.models : {};
    const models = Object.entries(rawModels)
      .flatMap(([fallbackModelId, rawModel]) => {
        const model =
          rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel) ? rawModel : {};
        const limit = model.limit && typeof model.limit === 'object' ? model.limit : model;
        const context = positive(limit.context);
        const input = positive(limit.input);
        const output = positive(limit.output);
        if (!context || !output) return [];
        return [
          {
            id: typeof model.id === 'string' ? model.id : fallbackModelId,
            context,
            ...(input ? { input } : {}),
            output,
          },
        ];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    return { id: typeof provider.id === 'string' ? provider.id : fallbackId, apiHosts, models };
  })
  .filter((provider) => provider.models.length > 0)
  .sort((a, b) => a.id.localeCompare(b.id));

const digest = createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 16);
const catalog = {
  schemaVersion: 1,
  source: 'https://models.dev/api.json',
  generatedAt: `${generatedAt}#${digest}`,
  providers,
};
if (
  !Array.isArray(catalog.providers) ||
  catalog.providers.length === 0 ||
  catalog.providers.some((provider) => !provider.id || provider.models.length === 0)
) {
  throw new Error('generated catalog is invalid');
}
await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
try {
  await rename(temporary, output);
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  throw error;
}
console.log(`wrote ${providers.length} providers to ${path.relative(root, output)}`);
