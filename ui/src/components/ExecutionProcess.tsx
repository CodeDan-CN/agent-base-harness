import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { RuntimeProjection } from '@client-contracts';
import {
  groupExecutionPhases,
  shouldAutoExpandExecutionProcess,
} from '../execution-process-policy';
import { ContextTokenRing, formatCompactToken, formatOptionalToken } from './ContextTokenRing';
import { MarkdownContent } from './MarkdownContent';

interface ExecutionProcessProps {
  projection: RuntimeProjection;
  turnIds: readonly string[];
  sessionId: string | null;
  onOpenError?(message: string): void;
}

export function ExecutionProcess({
  projection,
  turnIds,
  sessionId,
  onOpenError,
}: ExecutionProcessProps): JSX.Element | null {
  const turns = turnIds
    .map((turnId) => projection.turns.get(turnId))
    .filter((turn) => turn !== undefined);
  const latestTurn = turns.at(-1);
  const [expanded, setExpanded] = useState(() =>
    shouldAutoExpandExecutionProcess(latestTurn?.status),
  );

  useEffect(() => {
    setExpanded(shouldAutoExpandExecutionProcess(latestTurn?.status));
  }, [latestTurn?.id, latestTurn?.status]);

  if (!latestTurn) return null;

  let nextStepIndex = 1;
  const sections = turns.map((turn, turnIndex) => {
    const steps = [...projection.steps.values()]
      .filter((step) => step.turnId === turn.id)
      .sort((left, right) => left.stepIndex - right.stepIndex)
      .map((step) => ({ ...step, stepIndex: nextStepIndex++ }));
    const tools = [...projection.toolCalls.values()].filter((tool) => tool.turnId === turn.id);
    const reasoning = [...projection.reasoning.values()].filter((item) => item.turnId === turn.id);
    const nextTurnId = turns[turnIndex + 1]?.id;
    const interaction = nextTurnId
      ? [...projection.interactions.values()].find(
          (item) => item.turnId === turn.id && item.continuationTurnId === nextTurnId,
        )
      : undefined;
    const interactionStepIndex = interaction ? nextStepIndex++ : null;
    return {
      interaction,
      interactionStepIndex,
      phases: groupExecutionPhases({ steps, tools, reasoning }),
      steps,
    };
  });
  const steps = sections.flatMap((section) => section.steps);
  const interactionStepCount = sections.filter((section) => section.interaction).length;
  if (sections.every((section) => section.phases.length === 0) && interactionStepCount === 0) {
    return null;
  }
  return (
    <section className="execution-card" aria-label="执行过程">
      <button
        className="execution-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {latestTurn.status === 'running' && <Loader2 className="spin" size={16} />}
          执行过程
        </span>
        <small>
          {latestTurn.status === 'running'
            ? `已完成 ${
                steps.filter((step) => step.status !== 'running').length + interactionStepCount
              } 步`
            : statusText(latestTurn.status, latestTurn.endReason)}
        </small>
      </button>
      {expanded && (
        <div className="execution-body">
          {sections.map((section, sectionIndex) => (
            <div key={turns[sectionIndex]?.id}>
              {section.phases.map((phase) => {
                const firstStep = phase.steps[0];
                const latestStep = phase.steps.at(-1) ?? firstStep;
                if (!firstStep || !latestStep) return null;
                const stepLabel =
                  firstStep.stepIndex === latestStep.stepIndex
                    ? `步骤 ${firstStep.stepIndex}`
                    : `步骤 ${firstStep.stepIndex}–${latestStep.stepIndex}`;
                return (
                  <div className="execution-step" key={firstStep.id}>
                    <div className="step-heading">
                      <StatusIcon status={latestStep.status} />
                      <span>{stepLabel}</span>
                      <small>
                        {latestStep.requestContext
                          ? `上下文约 ${latestStep.requestContext.estimatedInputTokens} Token`
                          : '准备模型请求'}
                      </small>
                    </div>

                    {phase.reasoning && (
                      <ReasoningPanel
                        content={phase.reasoning.content}
                        finalized={phase.reasoning.finalized}
                        sessionId={sessionId}
                        onOpenError={onOpenError}
                      />
                    )}

                    {phase.tools.length > 0 && (
                      <section className="tool-execution-panel" aria-label="执行内容">
                        <div className="execution-section-title">
                          <Wrench size={13} />
                          <span>执行内容</span>
                        </div>
                        {phase.tools.map((tool) => (
                          <ToolCallCard
                            key={`${tool.id}-${tool.status}`}
                            tool={tool}
                            sessionId={sessionId}
                            onOpenError={onOpenError}
                          />
                        ))}
                      </section>
                    )}
                  </div>
                );
              })}
              {section.interaction && section.interactionStepIndex !== null && (
                <InteractionAnswerStep
                  interaction={section.interaction}
                  stepIndex={section.interactionStepIndex}
                />
              )}
            </div>
          ))}
          <ExecutionContextTokenIndicator
            projection={projection}
            turnIds={turns.map((turn) => turn.id)}
            steps={steps}
          />
        </div>
      )}
    </section>
  );
}

function ReasoningPanel({
  content,
  finalized,
  sessionId,
  onOpenError,
}: {
  content: string;
  finalized: boolean;
  sessionId: string | null;
  onOpenError?: (message: string) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const target = scrollRef.current;
    if (!target || !pinnedToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [content]);

  return (
    <section
      className={`reasoning-panel ${finalized ? 'finalized' : 'streaming'}`}
      aria-label="思考过程"
    >
      <div className="execution-section-title">
        <Brain size={13} />
        <span>Think · 思考过程</span>
        {!finalized && <Loader2 className="spin" size={12} />}
      </div>
      <div
        className="reasoning-scroll custom-scrollbar"
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          pinnedToBottom.current =
            target.scrollHeight - target.scrollTop - target.clientHeight < 12;
        }}
      >
        <MarkdownContent
          content={content}
          className="reasoning-markdown"
          sessionId={sessionId}
          streaming={!finalized}
          onOpenError={onOpenError}
        />
      </div>
    </section>
  );
}

type Interaction = RuntimeProjection['interactions'] extends Map<string, infer Item> ? Item : never;

function InteractionAnswerStep({
  interaction,
  stepIndex,
}: {
  interaction: Interaction;
  stepIndex: number;
}): JSX.Element {
  return (
    <div className="execution-step interaction-answer-step">
      <div className="step-heading">
        <CheckCircle2 className="status-success" size={16} />
        <span>步骤 {stepIndex} · 用户回答</span>
        <small>已继续执行</small>
      </div>
      <p>{interactionAnswerText(interaction)}</p>
    </div>
  );
}

function interactionAnswerText(interaction: Interaction): string {
  if (typeof interaction.value === 'string') return interaction.value;
  if (typeof interaction.value === 'boolean') return interaction.value ? '确认' : '拒绝';
  if (
    interaction.value &&
    typeof interaction.value === 'object' &&
    !Array.isArray(interaction.value)
  ) {
    const answers = interaction.value as Record<string, unknown>;
    const fields = interaction.questions
      .map((question) => {
        const value = answers[question.id];
        if (value === undefined || value === null || value === '') return null;
        return `${question.header ?? question.question}：${String(value)}`;
      })
      .filter((value): value is string => Boolean(value));
    if (fields.length > 0) return fields.join('；');
  }
  try {
    return JSON.stringify(interaction.value) ?? '已提交回答';
  } catch {
    return '已提交回答';
  }
}

function ExecutionContextTokenIndicator({
  projection,
  turnIds,
  steps,
}: {
  projection: RuntimeProjection;
  turnIds: readonly string[];
  steps: Array<RuntimeProjection['steps'] extends Map<string, infer Item> ? Item : never>;
}): JSX.Element {
  const latestStep = [...steps].reverse().find((step) => step.requestContext);
  const context = latestStep?.requestContext;
  const turnIdSet = new Set(turnIds);
  const replacements = projection.surfaceReplacements.filter((replacement) =>
    turnIdSet.has(replacement.turnId),
  );
  const compressedTokens = replacements.reduce(
    (total, replacement) => total + Math.max(0, replacement.tokensBefore - replacement.tokensAfter),
    0,
  );
  const used = context?.tokenBreakdown?.currentTurnTokens ?? null;
  const budget = context?.budgetTokens ?? null;
  const compressed = replacements.length > 0;

  return (
    <div className="execution-context-footer">
      <ContextTokenRing
        name="当前 Turn 步骤上下文"
        used={used}
        budget={budget}
        compressed={compressed}
        popoverLabel="步骤 Token 统计"
      >
        <div className="context-token-title">
          <strong>执行步骤上下文</strong>
          <span>{latestStep ? `Step ${latestStep.stepIndex}` : '尚未请求'}</span>
        </div>
        <div className="context-token-value">
          <strong>{formatOptionalToken(used)}</strong>
          <span>/ {budget ? formatCompactToken(budget) : '未知'} Token</span>
        </div>
        <dl>
          <div>
            <dt>运行表面压缩</dt>
            <dd>
              {compressed
                ? `已压缩 ${replacements.length} 次，节省 ${formatCompactToken(compressedTokens)}`
                : '未压缩'}
            </dd>
          </div>
          <div>
            <dt>本次请求总上下文</dt>
            <dd>{formatCompactToken(context?.estimatedInputTokens ?? 0)}</dd>
          </div>
          <div>
            <dt>系统与工具固定开销</dt>
            <dd>{formatOptionalToken(context?.tokenBreakdown?.fixedTokens ?? null)}</dd>
          </div>
        </dl>
        {!context?.tokenBreakdown && <p>下一个 Step 后显示精确的执行占用。</p>}
      </ContextTokenRing>
    </div>
  );
}

type ToolCall = RuntimeProjection['toolCalls'] extends Map<string, infer Item> ? Item : never;

function ToolCallCard({
  tool,
  sessionId,
  onOpenError,
}: {
  tool: ToolCall;
  sessionId: string | null;
  onOpenError?: (message: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(tool.status === 'running');

  return (
    <details
      className="tool-card"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Wrench size={14} />
        <span>{tool.name}</span>
        <small>{toolStatus(tool.status)}</small>
      </summary>
      <div className="tool-detail">
        <label>输入</label>
        <MarkdownContent
          content={toolMarkdown(tool.input)}
          sessionId={sessionId}
          onOpenError={onOpenError}
        />
        {tool.output !== undefined && (
          <>
            <label>输出</label>
            <MarkdownContent
              content={toolMarkdown(tool.output)}
              sessionId={sessionId}
              onOpenError={onOpenError}
            />
          </>
        )}
      </div>
    </details>
  );
}

function StatusIcon({ status }: { status: string }): JSX.Element {
  if (status === 'running') return <Loader2 className="spin status-running" size={16} />;
  if (status === 'completed') return <CheckCircle2 className="status-success" size={16} />;
  if (status === 'failed' || status === 'cancelled') {
    return <XCircle className="status-error" size={16} />;
  }
  return <CircleDashed className="status-pending" size={16} />;
}

function statusText(status: string, endReason: string | null): string {
  if (endReason === 'max_steps') return '达到步骤上限';
  if (endReason === 'context_budget_exceeded') return '上下文容量不足';
  if (endReason === 'empty_model_response') return '模型未返回内容';
  const labels: Record<string, string> = {
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已停止',
    interrupted: '意外中断',
  };
  return labels[status] ?? status;
}

function toolStatus(status: string): string {
  if (status === 'running') return '执行中';
  if (status === 'success') return '已完成';
  if (status === 'needs_input') return '等待用户';
  if (status === 'answered') return '已回答';
  return status.includes('error') ? '失败' : status;
}

function toolMarkdown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return '无法显示';
  }
}
