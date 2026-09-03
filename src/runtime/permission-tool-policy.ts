import type { PermissionPreset } from '../shared/domain/permission';
import type { ModelToolDefinition } from './model';

const USER_FACT_FLAG = 'requiresUserProvidedFact';

/**
 * Keep permission-specific prompting out of the shared tool catalog. Ordinary
 * modes see the original schema; full access receives only the one flag it
 * needs to distinguish an indispensable user fact from a model-owned choice.
 */
export function modelToolsForPermission(
  tools: readonly ModelToolDefinition[],
  permissionPreset: PermissionPreset,
): ModelToolDefinition[] {
  return tools.map((tool) => {
    if (tool.name !== 'request_user_input') return tool;

    const properties = isRecord(tool.inputSchema.properties)
      ? { ...tool.inputSchema.properties }
      : {};
    if (permissionPreset === 'full-access') {
      properties[USER_FACT_FLAG] = { type: 'boolean' };
    } else {
      delete properties[USER_FACT_FLAG];
    }

    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties,
      },
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
