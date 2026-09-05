import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  Loader2,
  PanelLeft,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  ApprovalResolution,
  InboxItem,
  PermissionPreset,
  RuntimeProjection,
} from '@client-contracts';
import { ExecutionProcess } from './ExecutionProcess';
import { InputArea } from './InputArea';
import { MarkdownContent } from './MarkdownContent';
import { ProducedFiles } from './ProducedFiles';
import { producedFilesForMessage } from '../produced-files';
import { approvalDisplay } from '../approval-presentation';
import {
  interactionExecutionTurnIds,
  isExecutionProcessAssistant,
  selectChatMessages,
  shouldRenderExecutionForMessage,
  shouldRenderStandaloneExecution,
} from '../chat-layout-policy';

interface ChatAreaProps {
  sessionId: string | null;
  title: string;
  modelLabel: string;
  modelContextLimit: number | null;
  sidebarOpen: boolean;
  loading: boolean;
  runtimeReady: boolean;
  projection: RuntimeProjection | null;
  busyActionId: string | null;
  permissionPreset: PermissionPreset;
  onToggleSidebar(): void;
  onRename(): void;
  onNotifyError(message: string): void;
  onSend(text: string, mode: 'queue' | 'steer'): Promise<boolean>;
  onStop(): void;
  onRemove(item: InboxItem): void;
  onReplace(item: InboxItem): void;
  onPromote(item: InboxItem): void;
  onResolveInteraction(
    id: string,
    value: unknown,
    resolution?: 'submitted' | 'cancelled' | 'rejected',
  ): void;
  onResolveApproval(id: string, resolution: ApprovalResolution): void;
  onPermissionPresetChange(preset: PermissionPreset): void;
}

export function ChatArea(props: ChatAreaProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const projection = props.projection;
  const allMessages = projection?.messages ?? [];
  const messages = useMemo(
    () => selectChatMessages(allMessages, [...(projection?.interactions.values() ?? [])]),
    [allMessages, projection],
  );
  const active = projection?.activeTurn ?? null;
  const executionTurn = active ?? [...(projection?.turns.values() ?? [])].at(-1) ?? null;
  const interactions = [...(projection?.interactions.values() ?? [])];
  const executionTurnIds = executionTurn
    ? interactionExecutionTurnIds(interactions, executionTurn.id)
    : [];
  const runningStream = useMemo(
    () => [...(projection?.streams.values() ?? [])].reverse().find((stream) => !stream.finalized),
    [projection],
  );
  const streamingTurnId = runningStream
    ? (runningStream.turnId ?? active?.id ?? executionTurn?.id ?? null)
    : null;
  const executionTurnHasAssistant = messages.some(
    (message) => message.role === 'assistant' && executionTurnIds.includes(message.turnId),
  );
  const pendingInteraction = [...(projection?.interactions.values() ?? [])]
    .reverse()
    .find((interaction) => interaction.status === 'pending');
  const pendingApproval = [...(projection?.approvals.values() ?? [])]
    .reverse()
    .find((approval) => approval.status === 'pending');
  const latestMeasuredStep = [...(projection?.steps.values() ?? [])]
    .reverse()
    .find((step) => step.requestContext);
  const latestRequestContext = latestMeasuredStep?.requestContext;
  const turnNumber = latestMeasuredStep
    ? [...(projection?.turns.values() ?? [])].findIndex(
        (turn) => turn.id === latestMeasuredStep.turnId,
      ) + 1
    : 0;
  const compactedTokens =
    projection?.surfaceReplacements.reduce(
      (total, replacement) =>
        total + Math.max(0, replacement.tokensBefore - replacement.tokensAfter),
      0,
    ) ?? 0;
  const contextStats = projection
    ? {
        estimatedInputTokens: latestRequestContext?.estimatedInputTokens ?? 0,
        budgetTokens: latestRequestContext?.budgetTokens ?? props.modelContextLimit,
        exact: Boolean(latestRequestContext),
        fixedTokens: latestRequestContext?.tokenBreakdown?.fixedTokens ?? null,
        historyTokens: latestRequestContext?.tokenBreakdown?.historyTokens ?? null,
        currentTurnTokens: latestRequestContext?.tokenBreakdown?.currentTurnTokens ?? null,
        stepLabel: latestMeasuredStep
          ? `Turn ${turnNumber} · Step ${latestMeasuredStep.stepIndex}`
          : null,
        cumulativeInputTokens: projection.usage.inputTokens,
        cumulativeOutputTokens: projection.usage.outputTokens,
        memoryCompactionCount: projection.usage.compactionRequests,
        surfaceCompactionCount: projection.surfaceReplacements.length,
        compactedTokens,
      }
    : null;

  useEffect(() => {
    const target = scrollRef.current;
    const hasStreamingBody =
      Boolean(runningStream?.content) && runningStream?.displayPhase !== 'commentary';
    if (!target || (!hasStreamingBody && !pinnedToBottom.current)) return;

    // 思考过程只滚动自己的面板；正文一旦开始流式输出，主内容区持续跟随。
    if (hasStreamingBody) pinnedToBottom.current = true;

    const frame = requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    messages.length,
    runningStream?.requestId,
    runningStream?.content,
    runningStream?.displayPhase,
  ]);

  return (
    <main className={`chat-area ${props.sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <header className="chat-header">
        <div className="chat-title-row">
          {!props.sidebarOpen && (
            <button className="icon-button" onClick={props.onToggleSidebar} aria-label="打开侧边栏">
              <PanelLeft size={17} />
            </button>
          )}
          <h1>{props.title}</h1>
          <button className="icon-button" onClick={props.onRename} aria-label="重命名会话">
            <Edit3 size={15} />
          </button>
        </div>
        <div className="header-status">
          <span className={`runtime-dot ${props.runtimeReady ? 'ready' : 'offline'}`} />
          <span>{props.modelLabel}</span>
          <button className="share-button" disabled title="分享功能暂未开放">
            分享
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="message-scroller custom-scrollbar"
        onScroll={(event) => {
          const target = event.currentTarget;
          const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 16;
          pinnedToBottom.current = nearBottom;
        }}
      >
        {props.loading ? (
          <div className="center-state">
            <Loader2 className="spin" /> 正在恢复会话...
          </div>
        ) : !projection || messages.length === 0 ? (
          <div className="welcome-state">
            <h2>今天我能帮你做什么？</h2>
            <p>我可以回答问题、分析资料、调用本地工具，并持续处理排队任务。</p>
          </div>
        ) : (
          <div className="message-column">
            {messages.map((message) => {
              const messageTurnIds = interactionExecutionTurnIds(interactions, message.turnId);
              const producedFiles =
                message.role === 'assistant'
                  ? producedFilesForMessage(projection, message.turnId, message.seq)
                  : [];
              const isCommentary = isExecutionProcessAssistant({
                role: message.role,
                toolCallCount: message.toolCalls?.length ?? 0,
                phase: message.phase,
              });
              return (
                <Fragment key={`${message.seq}-${message.role}`}>
                  <article className={`message ${message.role}`}>
                    {message.role === 'user' ? (
                      <div className="user-bubble">
                        <MarkdownContent
                          content={message.content}
                          sessionId={props.sessionId}
                          onOpenError={props.onNotifyError}
                        />
                      </div>
                    ) : message.role === 'assistant' ? (
                      <div className="assistant-block">
                        {!messageTurnIds.includes(streamingTurnId ?? '') &&
                          shouldRenderExecutionForMessage({
                            messageTurnId: message.turnId,
                            streamingTurnId,
                          }) && (
                            <ExecutionProcess
                              projection={projection}
                              turnIds={messageTurnIds}
                              sessionId={props.sessionId}
                              onOpenError={props.onNotifyError}
                            />
                          )}
                        {!isCommentary && (
                          <>
                            <MarkdownContent
                              content={message.content}
                              className="assistant-response"
                              sessionId={props.sessionId}
                              producedFiles={producedFiles}
                              onOpenError={props.onNotifyError}
                            />
                            <ProducedFiles
                              sessionId={props.sessionId}
                              paths={producedFiles}
                              onOpenError={props.onNotifyError}
                            />
                            {message.content && (
                              <div className="message-actions">
                                <button
                                  onClick={() =>
                                    void navigator.clipboard.writeText(message.content)
                                  }
                                  title="复制"
                                >
                                  <Copy size={14} />
                                </button>
                                <button title="重新发送暂未开放" disabled>
                                  <RotateCcw size={14} />
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ) : null}
                  </article>
                  {message.role === 'user' &&
                    message.turnId !== executionTurn?.id &&
                    !projection.messages.some(
                      (item) => item.role === 'assistant' && messageTurnIds.includes(item.turnId),
                    ) && (
                      <article className="message assistant">
                        <div className="assistant-block">
                          <ExecutionProcess
                            projection={projection}
                            turnIds={interactionExecutionTurnIds(interactions, message.turnId)}
                            sessionId={props.sessionId}
                            onOpenError={props.onNotifyError}
                          />
                        </div>
                      </article>
                    )}
                </Fragment>
              );
            })}
            {executionTurn &&
              shouldRenderStandaloneExecution({
                executionTurnId: executionTurn.id,
                hasRunningStream: Boolean(runningStream),
                executionTurnHasAssistant,
              }) && (
                <div className="assistant-block">
                  <ExecutionProcess
                    projection={projection}
                    turnIds={executionTurnIds}
                    sessionId={props.sessionId}
                    onOpenError={props.onNotifyError}
                  />
                </div>
              )}
            {runningStream && executionTurn && (
              <article className="message assistant streaming" aria-live="polite">
                <div className="assistant-block">
                  <ExecutionProcess
                    projection={projection}
                    turnIds={executionTurnIds}
                    sessionId={props.sessionId}
                    onOpenError={props.onNotifyError}
                  />
                  {runningStream.displayPhase !== 'commentary' && (
                    <div className="streaming-output">
                      {runningStream.content ? (
                        <MarkdownContent
                          content={runningStream.content}
                          className="streaming-markdown"
                          sessionId={props.sessionId}
                          streaming
                          onOpenError={props.onNotifyError}
                        />
                      ) : (
                        <span className="stream-status">
                          <Sparkles size={14} /> 正在生成回复
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </article>
            )}
          </div>
        )}
      </div>

      <div className="input-gradient">
        {(pendingInteraction || pendingApproval) && (
          <div className="pending-action-dock">
            {pendingInteraction && (
              <InteractionCard
                interaction={pendingInteraction}
                onResolve={props.onResolveInteraction}
              />
            )}
            {pendingApproval && (
              <ApprovalCard
                approval={pendingApproval}
                argumentsValue={projection?.toolCalls.get(pendingApproval.toolCallId)?.input}
                onResolve={props.onResolveApproval}
              />
            )}
          </div>
        )}
        <InputArea
          processing={Boolean(active)}
          disabled={!projection || !props.runtimeReady}
          queue={projection?.inbox ?? []}
          busyActionId={props.busyActionId}
          permissionPreset={props.permissionPreset}
          contextStats={contextStats}
          onSend={props.onSend}
          onStop={props.onStop}
          onRemove={props.onRemove}
          onReplace={props.onReplace}
          onPromote={props.onPromote}
          onPermissionPresetChange={props.onPermissionPresetChange}
        />
      </div>
    </main>
  );
}

function InteractionCard({
  interaction,
  onResolve,
}: {
  interaction: RuntimeProjection['interactions'] extends Map<string, infer T> ? T : never;
  onResolve(id: string, value: unknown, resolution?: 'submitted' | 'cancelled' | 'rejected'): void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [singleOther, setSingleOther] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const confirmation = interaction.kind === 'confirm' || interaction.kind === 'approval';
  const questions = interaction.questions ?? [];
  const hasQuestions = questions.length > 0;
  const activeQuestion = questions[questionIndex];
  const activeAnswer = activeQuestion ? answers[activeQuestion.id] : undefined;
  const activeQuestionAnswered = Boolean(
    activeQuestion &&
    activeAnswer &&
    (activeAnswer !== OTHER_CHOICE || (otherAnswers[activeQuestion.id] ?? '').trim()),
  );
  const lastQuestion = questionIndex === questions.length - 1;
  const submittedValue = hasQuestions
    ? Object.fromEntries(
        questions.map((question) => [
          question.id,
          answers[question.id] === OTHER_CHOICE
            ? (otherAnswers[question.id] ?? '').trim()
            : (answers[question.id] ?? ''),
        ]),
      )
    : value === OTHER_CHOICE
      ? singleOther.trim()
      : value;
  const canSubmit = confirmation
    ? true
    : hasQuestions
      ? questions.every((question) => {
          const selected = answers[question.id];
          return Boolean(
            selected && (selected !== OTHER_CHOICE || (otherAnswers[question.id] ?? '').trim()),
          );
        })
      : typeof submittedValue === 'string' && Boolean(submittedValue.trim());

  useEffect(() => {
    setValue('');
    setSingleOther('');
    setAnswers({});
    setOtherAnswers({});
    setQuestionIndex(0);
  }, [interaction.id]);

  return (
    <section className="interaction-card" aria-label="需要你的回答">
      {!hasQuestions && <span className="interaction-label">需要你的回答</span>}
      {!hasQuestions && <p>{interaction.prompt}</p>}
      {!confirmation && activeQuestion && (
        <div className="interaction-questions">
          <fieldset className="interaction-question" key={activeQuestion.id}>
            <legend>
              <span>{activeQuestion.question}</span>
            </legend>
            <ChoiceOptions
              name={`${interaction.id}-${activeQuestion.id}`}
              options={activeQuestion.options}
              value={answers[activeQuestion.id] ?? ''}
              onChange={(nextValue) =>
                setAnswers((current) => ({ ...current, [activeQuestion.id]: nextValue }))
              }
            />
            {answers[activeQuestion.id] === OTHER_CHOICE && (
              <input
                className="interaction-other-input"
                value={otherAnswers[activeQuestion.id] ?? ''}
                onChange={(event) =>
                  setOtherAnswers((current) => ({
                    ...current,
                    [activeQuestion.id]: event.target.value,
                  }))
                }
                placeholder="请输入其他想法"
                autoFocus
              />
            )}
          </fieldset>
        </div>
      )}
      {!confirmation && !hasQuestions && interaction.options.length > 0 && (
        <>
          <ChoiceOptions
            name={interaction.id}
            options={interaction.options}
            value={value}
            onChange={setValue}
          />
          {value === OTHER_CHOICE && (
            <input
              className="interaction-other-input"
              value={singleOther}
              onChange={(event) => setSingleOther(event.target.value)}
              placeholder="请输入其他想法"
              autoFocus
            />
          )}
        </>
      )}
      {!confirmation && !hasQuestions && interaction.options.length === 0 && (
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="请输入回复"
        />
      )}
      <div className={`interaction-footer ${hasQuestions ? '' : 'actions-only'}`}>
        {hasQuestions && (
          <div className="interaction-pagination" aria-label="问题进度">
            <span>
              {questionIndex + 1} / {questions.length}
            </span>
            <div aria-hidden="true">
              {questions.map((question, index) => (
                <i
                  className={`${index === questionIndex ? 'active' : ''} ${answers[question.id] ? 'answered' : ''}`}
                  key={question.id}
                />
              ))}
            </div>
          </div>
        )}
        <div className="interaction-actions">
          <button
            className="secondary icon-action"
            aria-label="取消"
            title="取消"
            onClick={() => onResolve(interaction.id, null, 'cancelled')}
          >
            <X size={14} />
          </button>
          {confirmation && (
            <button
              className="secondary danger"
              onClick={() => onResolve(interaction.id, false, 'rejected')}
            >
              拒绝
            </button>
          )}
          {hasQuestions && questionIndex > 0 && (
            <button
              className="secondary icon-action"
              aria-label="上一题"
              title="上一题"
              onClick={() => setQuestionIndex((index) => index - 1)}
            >
              <ChevronLeft size={14} />
            </button>
          )}
          {hasQuestions && !lastQuestion && (
            <button
              className="primary icon-action"
              aria-label="下一题"
              title="下一题"
              disabled={!activeQuestionAnswered}
              onClick={() => setQuestionIndex((index) => index + 1)}
            >
              <ChevronRight size={14} />
            </button>
          )}
          {(!hasQuestions || lastQuestion) && (
            <button
              className={`primary ${hasQuestions ? 'icon-action' : ''}`}
              aria-label={hasQuestions ? '提交回答' : undefined}
              title={hasQuestions ? '提交回答' : undefined}
              disabled={!canSubmit}
              onClick={() => onResolve(interaction.id, confirmation ? true : submittedValue)}
            >
              <Check size={hasQuestions ? 14 : 13} /> {!hasQuestions && '提交'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

const OTHER_CHOICE = '__other__';

function ChoiceOptions({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: string[];
  value: string;
  onChange(value: string): void;
}): JSX.Element {
  const choices = options.filter((option) => option.trim() && option.trim() !== '其他');
  return (
    <div className="interaction-choices" role="radiogroup">
      {[...choices, OTHER_CHOICE].map((option) => {
        const label = option === OTHER_CHOICE ? '其他' : option;
        return (
          <label className="interaction-choice" key={option}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

function ApprovalCard({
  approval,
  argumentsValue,
  onResolve,
}: {
  approval: RuntimeProjection['approvals'] extends Map<string, infer T> ? T : never;
  argumentsValue?: unknown;
  onResolve(id: string, resolution: ApprovalResolution): void;
}): JSX.Element {
  const display = approvalDisplay(approval.toolName, approval.presentation, argumentsValue);
  return (
    <section className="approval-card" aria-live="polite">
      <div className="approval-heading">
        <span className="approval-symbol">
          <ShieldAlert size={16} />
        </span>
        <div>
          <span className="interaction-label">需要你的批准</span>
          <strong>{display.title}</strong>
          <code className="approval-tool-name">{approval.toolName}</code>
        </div>
      </div>
      <p className={display.technicalDetail ? 'technical' : undefined}>{display.detail}</p>
      <div className="interaction-actions">
        <button className="secondary danger" onClick={() => onResolve(approval.id, 'rejected')}>
          拒绝
        </button>
        <button className="secondary" onClick={() => onResolve(approval.id, 'allowed-once')}>
          允许一次
        </button>
      </div>
    </section>
  );
}
