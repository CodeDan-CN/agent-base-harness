export interface ExecutionStepLike {
  id: string;
  stepIndex: number;
  status: string;
}

export interface ExecutionToolLike {
  id: string;
  stepId: string | null;
  callIndex: number;
}

export interface ExecutionReasoningLike {
  stepId: string;
  content: string;
}

export interface ExecutionPhase<
  Step extends ExecutionStepLike,
  Tool extends ExecutionToolLike,
  Reasoning extends ExecutionReasoningLike,
> {
  steps: Step[];
  tools: Tool[];
  reasoning: Reasoning | null;
}

export function shouldAutoExpandExecutionProcess(status: string | undefined): boolean {
  return status === 'running';
}

/**
 * 以模型实际返回的 reasoning 作为新的展示阶段边界。
 * 后续未返回新 reasoning 的串行工具调用继续追加到最近阶段；同一步里的并行工具按 callIndex 排列。
 */
export function groupExecutionPhases<
  Step extends ExecutionStepLike,
  Tool extends ExecutionToolLike,
  Reasoning extends ExecutionReasoningLike,
>(input: {
  steps: readonly Step[];
  tools: readonly Tool[];
  reasoning: readonly Reasoning[];
}): ExecutionPhase<Step, Tool, Reasoning>[] {
  const reasoningByStep = new Map(
    input.reasoning
      .filter((item) => Boolean(item.content.trim()))
      .map((item) => [item.stepId, item] as const),
  );
  const toolsByStep = new Map<string, Tool[]>();
  for (const tool of input.tools) {
    if (!tool.stepId) continue;
    const stepTools = toolsByStep.get(tool.stepId) ?? [];
    stepTools.push(tool);
    toolsByStep.set(tool.stepId, stepTools);
  }
  for (const stepTools of toolsByStep.values()) {
    stepTools.sort((left, right) => left.callIndex - right.callIndex);
  }

  const phases: ExecutionPhase<Step, Tool, Reasoning>[] = [];
  for (const step of [...input.steps].sort((left, right) => left.stepIndex - right.stepIndex)) {
    const stepReasoning = reasoningByStep.get(step.id) ?? null;
    if (phases.length === 0 || stepReasoning) {
      phases.push({ steps: [], tools: [], reasoning: stepReasoning });
    }
    const phase = phases.at(-1);
    if (!phase) continue;
    phase.steps.push(step);
    phase.tools.push(...(toolsByStep.get(step.id) ?? []));
  }

  return phases.filter(
    (phase) =>
      phase.reasoning !== null ||
      phase.tools.length > 0 ||
      phase.steps.some((step) => step.status === 'running'),
  );
}
