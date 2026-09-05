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

export interface ExecutionCommentary {
  id: string;
  stepId: string;
  content: string;
  finalized: boolean;
  interrupted?: boolean;
}

export interface ExecutionPhase<
  Step extends ExecutionStepLike,
  Tool extends ExecutionToolLike,
  Reasoning extends ExecutionReasoningLike,
> {
  steps: Step[];
  tools: Tool[];
  reasoning: Reasoning | null;
  commentary: ExecutionCommentary[];
}

export function shouldAutoExpandExecutionProcess(status: string | undefined): boolean {
  return status === 'running';
}

/**
 * 一个执行步骤对应一个模型请求；说明和推理都是可选内容，不决定步骤边界。
 */
export function groupExecutionPhases<
  Step extends ExecutionStepLike,
  Tool extends ExecutionToolLike,
  Reasoning extends ExecutionReasoningLike,
>(input: {
  steps: readonly Step[];
  tools: readonly Tool[];
  reasoning: readonly Reasoning[];
  commentary?: readonly ExecutionCommentary[];
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
    phases.push({
      steps: [step],
      tools: toolsByStep.get(step.id) ?? [],
      reasoning: stepReasoning,
      commentary: (input.commentary ?? []).filter(
        (item) => item.stepId === step.id && item.content.trim(),
      ),
    });
  }

  return phases.filter(
    (phase) =>
      phase.reasoning !== null ||
      phase.commentary.length > 0 ||
      phase.tools.length > 0 ||
      phase.steps.some((step) => step.status === 'running'),
  );
}
