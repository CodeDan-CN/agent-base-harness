/** Renderer-safe model output budget policy shared by management UI and Worker. */

export interface RecommendedOutputBudgetInput {
  contextWindow: number;
  compactionTriggerRatio: number;
  maxOutputCapability?: number | null;
}

export const MAX_CONFIGURABLE_OUTPUT_TOKENS = 1_000_000;

/**
 * Returns the output budget that fits in the context headroom left by the
 * compaction trigger, capped by the model's declared output capability.
 */
export function recommendedOutputBudget(input: RecommendedOutputBudgetInput): number {
  const compactionTriggerTokens = Math.floor(input.contextWindow * input.compactionTriggerRatio);
  const contextHeadroom = Math.max(1, input.contextWindow - compactionTriggerTokens);
  return Math.min(
    input.maxOutputCapability ?? contextHeadroom,
    contextHeadroom,
    MAX_CONFIGURABLE_OUTPUT_TOKENS,
  );
}

/** Maximum valid manual output budget for the effective context window. */
export function maximumManualOutputBudget(input: {
  contextWindow: number;
  maxOutputCapability?: number | null;
}): number {
  const contextLimit = Math.max(1, input.contextWindow - 1);
  return Math.min(
    input.maxOutputCapability ?? contextLimit,
    contextLimit,
    MAX_CONFIGURABLE_OUTPUT_TOKENS,
  );
}
