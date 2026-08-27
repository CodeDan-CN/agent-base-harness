export type ProviderPresetId = 'deepseek-official' | 'alibaba-bailian';
export type ThinkingMode = 'auto' | 'enabled' | 'disabled';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelThinkingSettings {
  thinkingMode: ThinkingMode;
  reasoningEffort: ReasoningEffort | null;
}

export interface ProviderPreset {
  id: ProviderPresetId;
  version: number;
  displayName: string;
  defaultEndpoint: string;
  allowedHosts: readonly string[];
  supportedReasoningEfforts: readonly ReasoningEffort[];
}

const ALL_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek-official',
    version: 1,
    displayName: 'DeepSeek',
    defaultEndpoint: 'https://api.deepseek.com/',
    allowedHosts: ['api.deepseek.com'],
    supportedReasoningEfforts: ALL_REASONING_EFFORTS,
  },
  {
    id: 'alibaba-bailian',
    version: 1,
    displayName: '阿里云百炼',
    defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    allowedHosts: ['dashscope.aliyuncs.com', 'maas.aliyuncs.com'],
    supportedReasoningEfforts: ALL_REASONING_EFFORTS,
  },
] as const;

export function getProviderPreset(id: string | null | undefined): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * 只对已知官方 Host 推导预制，用于让阶段 4 之前创建的服务获得等价的思考设置。
 * 未知网关和本地代理仍保持自定义 OpenAI-compatible，不猜测供应商。
 */
export function inferProviderPresetFromEndpoint(endpoint: string): ProviderPreset | null {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    PROVIDER_PRESETS.find((preset) =>
      preset.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
    ) ?? null
  );
}

export function validatePresetEndpoint(preset: ProviderPreset, endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  return preset.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function supportedReasoningEffortsFor(
  presetId: string | null | undefined,
  remoteModelId: string,
): readonly ReasoningEffort[] {
  const preset = getProviderPreset(presetId);
  if (!preset) return [];
  if (preset.id !== 'alibaba-bailian') return preset.supportedReasoningEfforts;

  const model = remoteModelId.toLowerCase();
  if (model === 'deepseek-v4-flash-0731' || model === 'deepseek-v4-pro-0813') {
    return ['low', 'high', 'max'];
  }
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro') {
    return ['high', 'max'];
  }
  return preset.supportedReasoningEfforts;
}

export function normalizeReasoningEffort(
  presetId: string | null | undefined,
  remoteModelId: string,
  effort: ReasoningEffort | null,
): ReasoningEffort | null {
  if (!effort) return null;
  const preset = getProviderPreset(presetId);
  if (preset?.id !== 'alibaba-bailian') return effort;

  const model = remoteModelId.toLowerCase();
  if (model === 'deepseek-v4-flash-0731' || model === 'deepseek-v4-pro-0813') {
    if (effort === 'minimal') return 'low';
    if (effort === 'medium' || effort === 'xhigh') return 'high';
    return effort;
  }
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro') {
    if (effort === 'max' || effort === 'xhigh') return 'max';
    return 'high';
  }
  return effort;
}

/** 供应商专用字段只能由已确认的预制产生，自定义 OpenAI-compatible 不进入此函数。 */
export function applyThinkingSettings(
  presetId: string | null | undefined,
  remoteModelId: string,
  settings: ModelThinkingSettings,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const preset = getProviderPreset(presetId);
  if (!preset || settings.thinkingMode === 'auto') return { ...params };

  const output = { ...params };
  if (preset.id === 'deepseek-official') {
    output.thinking = { type: settings.thinkingMode };
  } else {
    output.enable_thinking = settings.thinkingMode === 'enabled';
  }
  if (settings.thinkingMode === 'enabled' && settings.reasoningEffort) {
    const effort = normalizeReasoningEffort(presetId, remoteModelId, settings.reasoningEffort);
    if (!effort || !supportedReasoningEffortsFor(presetId, remoteModelId).includes(effort)) {
      throw new Error('MODEL_REASONING_EFFORT_UNSUPPORTED');
    }
    output.reasoning_effort = effort;
  }
  return output;
}
