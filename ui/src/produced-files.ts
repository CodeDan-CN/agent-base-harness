import type { RuntimeProjection } from '@client-contracts';

export function producedFilesForMessage(
  projection: RuntimeProjection,
  turnId: string,
  closingSeq: number,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const call of projection.toolCalls.values()) {
    if (call.turnId !== turnId || call.status !== 'success') continue;
    if (call.resultSeq === undefined || call.resultSeq > closingSeq) continue;
    const presentation = recordOf(call.presentation);
    if (presentation?.status !== 'success' || !Array.isArray(presentation.locations)) continue;
    for (const location of presentation.locations) {
      const path = recordOf(location)?.path;
      if (typeof path !== 'string' || !path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export function resolveProducedFileMention(
  paths: readonly string[],
  value: string,
): string | undefined {
  if (paths.includes(value)) return value;
  const matches = paths.filter((path) => basename(path) === value);
  return matches.length === 1 ? matches[0] : undefined;
}

export function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index < 0 ? path : path.slice(index + 1);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
