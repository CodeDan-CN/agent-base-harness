import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import {
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { RuntimeProjection, ProjectedStep } from '@client-contracts';
import { executionActivity } from '../execution-activity';
import { assistantMessagePhase } from '@client-contracts';
import {
  groupExecutionPhases,
  shouldAutoExpandExecutionProcess,
} from '../execution-process-policy';
import { ContextTokenRing, formatCompactToken, formatOptionalToken } from './ContextTokenRing';
import { MarkdownContent } from './MarkdownContent';
import { query, requireClient, userMessage } from '../client';
import { applyEventBatch, hydrateProjection } from '../projection';
import type { SessionSnapshotPayload } from '../types';

interface ExecutionProcessProps {
  projection: RuntimeProjection;
  turnIds: readonly string[];
  sessionId: string | null;
  onOpenError?(message: string): void;
  embedded?: boolean;
  label?: string;
}

export function ExecutionProcess({
  projection,
  turnIds,
  sessionId,
  onOpenError,
  embedded = false,
  label = '执行过程',
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
    const messages = projection.messages.filter(
      (message) => message.turnId === turn.id && message.role === 'assistant',
    );
    const commentary = messages
      .filter((message) => message.stepId && assistantMessagePhase(message) === 'commentary')
      .map((message) => ({
        id: message.requestId ?? String(message.seq),
        stepId: message.stepId!,
        content: message.content,
        finalized: true,
      }));
    const streams = [...projection.streams.values()].filter(
      (stream) =>
        stream.turnId === turn.id &&
        stream.stepId &&
        !messages.some((message) => message.requestId === stream.requestId) &&
        ((!stream.finalized && stream.displayPhase === 'commentary') || stream.interrupted),
    );
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
      phases: groupExecutionPhases({
        steps,
        tools,
        reasoning,
        commentary: [
          ...commentary,
          ...streams.map((stream) => ({
            id: stream.requestId,
            stepId: stream.stepId!,
            content: stream.content,
            finalized: stream.finalized,
            interrupted: stream.interrupted,
          })),
        ],
      }),
      steps,
    };
  });
  const steps = sections.flatMap((section) => section.steps);
  const latestContextStep = [...steps].reverse().find((step) => step.requestContext);
  const delegationByToolCall = new Map(
    [...projection.delegations.values()].map((delegation) => [
      delegation.parentToolCallId,
      delegation,
    ]),
  );
  const interactionStepCount = sections.filter((section) => section.interaction).length;
  const endedWithoutAnswer =
    latestTurn.status === 'completed' &&
    latestTurn.endReason === 'complete' &&
    projection.messages.some(
      (message) =>
        message.turnId === latestTurn.id &&
        message.role === 'assistant' &&
        assistantMessagePhase(message) === 'commentary',
    ) &&
    !projection.messages.some(
      (message) =>
        message.turnId === latestTurn.id &&
        message.role === 'assistant' &&
        assistantMessagePhase(message) === 'final_answer' &&
        message.content.trim(),
    );
  if (sections.every((section) => section.phases.length === 0) && interactionStepCount === 0) {
    return null;
  }
  return (
    <section
      className={`execution-card ${embedded ? 'embedded-execution-card' : ''}`}
      aria-label={label}
    >
      <div className="execution-header">
        <button
          className="execution-header-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span>
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {latestTurn.status === 'running' && <Loader2 className="spin" size={16} />}
            {label}
          </span>
          <small>
            {latestTurn.status === 'running'
              ? `已完成 ${
                  steps.filter((step) => step.status !== 'running').length + interactionStepCount
                } 步`
              : endedWithoutAnswer
                ? '本轮已结束，未返回最终回答'
                : statusText(latestTurn.status, latestTurn.endReason)}
          </small>
        </button>
        {!embedded && (
          <div className="execution-context-summary">
            <span className="execution-context-label">
              {latestContextStep?.requestContext
                ? `上下文约 ${latestContextStep.requestContext.estimatedInputTokens} Token`
                : '上下文待计算'}
            </span>
            <ExecutionContextTokenIndicator
              projection={projection}
              turnIds={turns.map((turn) => turn.id)}
              steps={steps}
            />
          </div>
        )}
      </div>
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
                    </div>

                    {phase.commentary.map((message) => (
                      <section
                        className="execution-commentary"
                        aria-label="执行说明"
                        key={message.id}
                      >
                        <div className="execution-section-title">
                          <span>{message.interrupted ? '输出中断' : '执行说明'}</span>
                          {!message.finalized && <Loader2 className="spin" size={12} />}
                        </div>
                        <MarkdownContent
                          content={message.content}
                          sessionId={sessionId}
                          streaming={!message.finalized}
                          streamKey={`commentary:${message.id}`}
                          onOpenError={onOpenError}
                        />
                      </section>
                    ))}

                    {(latestStep.status === 'running' || phase.commentary.length === 0) && (
                      <ExecutionActivity projection={projection} step={latestStep} />
                    )}

                    {phase.reasoning && (
                      <ReasoningPanel
                        content={phase.reasoning.content}
                        finalized={phase.reasoning.finalized}
                        streamKey={`reasoning:${phase.reasoning.requestId}`}
                        sessionId={sessionId}
                        onOpenError={onOpenError}
                      />
                    )}

                    {phase.tools.length > 0 && (
                      <AutoOpenDetails
                        className="tool-execution-panel"
                        ariaLabel="执行内容"
                        autoOpen={phase.tools.some((tool) => {
                          const delegation = delegationByToolCall.get(tool.id);
                          return delegation && isActiveDelegationStatus(delegation.status);
                        })}
                      >
                        <summary className="execution-section-title execution-disclosure">
                          <Wrench size={13} />
                          <span>执行内容</span>
                          <ChevronRight className="disclosure-chevron" size={13} />
                          {phase.tools.some((tool) => tool.status === 'running') && (
                            <Loader2 className="spin" size={12} />
                          )}
                        </summary>
                        {phase.tools.map((tool) => {
                          const delegation = delegationByToolCall.get(tool.id);
                          return delegation ? (
                            <DelegationCallCard
                              key={tool.id}
                              delegation={delegation}
                              tool={tool}
                              sessionId={sessionId}
                              onOpenError={onOpenError}
                            />
                          ) : (
                            <ToolCallCard
                              key={tool.id}
                              tool={tool}
                              sessionId={sessionId}
                              onOpenError={onOpenError}
                            />
                          );
                        })}
                      </AutoOpenDetails>
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
        </div>
      )}
    </section>
  );
}

function ExecutionActivity({
  projection,
  step,
}: {
  projection: RuntimeProjection;
  step: ProjectedStep;
}): JSX.Element | null {
  const [now, setNow] = useState(Date.now);
  const running = step.status === 'running';
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, step.id]);
  const activity = executionActivity(projection, step);
  if (!activity) return null;
  const seconds = Math.max(0, Math.floor((now - Date.parse(step.startedAt)) / 1000));
  return (
    <p className="execution-activity" aria-label="运行状态">
      <span>{activity}</span>
      {running && Number.isFinite(seconds) && <small>本步骤已耗时 {seconds} 秒</small>}
    </p>
  );
}

function ReasoningPanel({
  content,
  finalized,
  streamKey,
  sessionId,
  onOpenError,
}: {
  content: string;
  finalized: boolean;
  streamKey: string;
  sessionId: string | null;
  onOpenError?: (message: string) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const target = scrollRef.current;
    if (!target || !pinnedToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [content, expanded]);

  return (
    <section
      className={`reasoning-panel ${finalized ? 'finalized' : 'streaming'}`}
      aria-label="模型推理"
    >
      <button
        type="button"
        className="execution-section-title reasoning-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <Brain size={13} />
        <span>模型推理</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {!finalized && <Loader2 className="spin" size={12} />}
      </button>
      {expanded && (
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
            streamKey={streamKey}
            onOpenError={onOpenError}
          />
        </div>
      )}
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
    <div className="execution-context-control">
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
type Delegation = RuntimeProjection['delegations'] extends Map<string, infer Item> ? Item : never;

function DelegationCallCard({
  delegation,
  tool,
  sessionId,
  onOpenError,
}: {
  delegation: Delegation;
  tool: ToolCall;
  sessionId: string | null;
  onOpenError?: (message: string) => void;
}): JSX.Element {
  const caller = delegation.callerAgentName ?? '当前智能体';
  const target = delegation.targetAgentName ?? delegation.targetAgentId;
  const task =
    tool.input && typeof tool.input === 'object' && 'task' in tool.input
      ? String((tool.input as { task?: unknown }).task ?? '')
      : '';
  return (
    <AutoOpenDetails
      className="tool-card delegation-card"
      autoOpen={isActiveDelegationStatus(delegation.status)}
    >
      <summary>
        <Bot size={14} />
        <span className="delegation-route">
          {caller}
          <ArrowRight size={12} aria-hidden="true" />
          {target}
        </span>
        <ChevronRight className="disclosure-chevron" size={13} />
        <small>{delegationStatus(delegation.status)}</small>
      </summary>
      <div className="tool-detail">
        {task && (
          <>
            <label>委派任务</label>
            <MarkdownContent content={task} sessionId={sessionId} onOpenError={onOpenError} />
          </>
        )}
        <DelegatedExecutionProcess
          delegatedSessionId={delegation.delegatedSessionId}
          targetAgentName={target}
          onOpenError={onOpenError}
        />
        {delegation.report && (
          <>
            <label>受派报告</label>
            <MarkdownContent
              content={delegation.report}
              sessionId={sessionId}
              onOpenError={onOpenError}
            />
          </>
        )}
        <small className="delegation-session-ref">受派会话：{delegation.delegatedSessionId}</small>
      </div>
    </AutoOpenDetails>
  );
}

function AutoOpenDetails({
  autoOpen,
  className,
  ariaLabel,
  children,
}: {
  autoOpen: boolean;
  className: string;
  ariaLabel?: string;
  children: ReactNode;
}): JSX.Element {
  const [expanded, setExpanded] = useState(autoOpen);

  useEffect(() => {
    if (autoOpen) setExpanded(true);
  }, [autoOpen]);

  return (
    <details
      className={className}
      aria-label={ariaLabel}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      {children}
    </details>
  );
}

function DelegatedExecutionProcess({
  delegatedSessionId,
  targetAgentName,
  onOpenError,
}: {
  delegatedSessionId: string;
  targetAgentName: string;
  onOpenError?: (message: string) => void;
}): JSX.Element {
  const { projection, status, error } = useDelegatedProjection(delegatedSessionId);
  const turnIds = projection
    ? [...projection.turns.values()]
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map((turn) => turn.id)
    : [];

  return (
    <section className="delegated-execution" aria-label={`${targetAgentName}的执行过程`}>
      {projection && turnIds.length > 0 ? (
        <ExecutionProcess
          projection={projection}
          turnIds={turnIds}
          sessionId={delegatedSessionId}
          onOpenError={onOpenError}
          embedded
          label={`${targetAgentName}的执行过程`}
        />
      ) : (
        <p className={`delegated-execution-state ${status}`}>
          {status === 'error' ? <XCircle size={13} /> : <Loader2 className="spin" size={13} />}
          <span>{error ?? `${targetAgentName}正在准备执行…`}</span>
        </p>
      )}
    </section>
  );
}

function useDelegatedProjection(sessionId: string): {
  projection: RuntimeProjection | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
} {
  const [projection, setProjection] = useState<RuntimeProjection | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef(0);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let unsubscribe: (() => void) | undefined;

    const connect = async () => {
      const currentGeneration = ++generation;
      unsubscribe?.();
      unsubscribe = undefined;
      setStatus('loading');
      try {
        const snapshot = await query<SessionSnapshotPayload>('session.snapshot', { sessionId });
        if (!active || currentGeneration !== generation) return;
        cursorRef.current = snapshot.throughSeq;
        setProjection(hydrateProjection(snapshot));
        setError(null);
        setStatus('ready');
        unsubscribe = requireClient().subscribeSession(sessionId, cursorRef.current, (event) => {
          if (!active || currentGeneration !== generation) return;
          if (event.type === 'resync-required' || event.fromSeq !== cursorRef.current + 1) {
            void connect();
            return;
          }
          cursorRef.current = event.toSeq;
          setProjection((current) => (current ? applyEventBatch(current, event.events) : current));
        });
      } catch (cause) {
        if (!active || currentGeneration !== generation) return;
        setError(`无法载入受派执行过程：${userMessage(cause)}`);
        setStatus('error');
      }
    };

    setProjection(null);
    cursorRef.current = 0;
    void connect();
    return () => {
      active = false;
      generation += 1;
      unsubscribe?.();
    };
  }, [sessionId]);

  return { projection, status, error };
}

function ToolCallCard({
  tool,
  sessionId,
  onOpenError,
}: {
  tool: ToolCall;
  sessionId: string | null;
  onOpenError?: (message: string) => void;
}): JSX.Element {
  return (
    <details className="tool-card">
      <summary>
        <Wrench size={14} />
        <span>{tool.name}</span>
        <ChevronRight className="disclosure-chevron" size={13} />
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

function delegationStatus(status: Delegation['status']): string {
  const labels: Record<Delegation['status'], string> = {
    accepted: '已接纳',
    running: '执行中',
    awaiting_user: '等待用户',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  };
  return labels[status];
}

function isActiveDelegationStatus(status: Delegation['status']): boolean {
  return status === 'accepted' || status === 'running' || status === 'awaiting_user';
}

function toolMarkdown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return '无法显示';
  }
}
