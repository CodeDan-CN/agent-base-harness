import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  ArrowDown,
  Check,
  Copy,
  Edit3,
  Loader2,
  PanelLeft,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import type { InboxItem, RuntimeProjection } from '@client-contracts';
import { ExecutionProcess } from './ExecutionProcess';
import { InputArea } from './InputArea';
import { MarkdownContent } from './MarkdownContent';
import { ProducedFiles } from './ProducedFiles';
import { SelectMenu } from './SelectMenu';
import { producedFilesForMessage } from '../produced-files';
import {
  isExecutionProcessAssistant,
  shouldRenderExecutionForMessage,
  shouldRenderStandaloneExecution,
} from '../chat-layout-policy';

interface ChatAreaProps {
  sessionId: string | null;
  title: string;
  modelLabel: string;
  sidebarOpen: boolean;
  loading: boolean;
  runtimeReady: boolean;
  projection: RuntimeProjection | null;
  busyActionId: string | null;
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
}

export function ChatArea(props: ChatAreaProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const projection = props.projection;
  const allMessages = projection?.messages ?? [];
  const messages = useMemo(
    () =>
      allMessages.filter(
        (message) =>
          !isExecutionProcessAssistant({
            role: message.role,
            toolCallCount: message.toolCalls?.length ?? 0,
          }),
      ),
    [allMessages],
  );
  const active = projection?.activeTurn ?? null;
  const executionTurn = active ?? [...(projection?.turns.values() ?? [])].at(-1) ?? null;
  const runningStream = useMemo(
    () => [...(projection?.streams.values() ?? [])].reverse().find((stream) => !stream.finalized),
    [projection],
  );
  const executionTurnHasAssistant = messages.some(
    (message) => message.role === 'assistant' && message.turnId === executionTurn?.id,
  );
  const pendingInteraction = [...(projection?.interactions.values() ?? [])]
    .reverse()
    .find((interaction) => interaction.status === 'pending');

  useEffect(() => {
    const target = scrollRef.current;
    if (!target || !pinnedToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, runningStream?.content, projection?.lastSeq]);

  const scrollToBottom = () => {
    const target = scrollRef.current;
    if (!target) return;
    pinnedToBottom.current = true;
    setShowBackToBottom(false);
    target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
  };

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
          const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 72;
          pinnedToBottom.current = nearBottom;
          setShowBackToBottom(!nearBottom);
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
            {messages.map((message, index) => {
              const isLastAssistant =
                message.role === 'assistant' &&
                !messages.slice(index + 1).some((candidate) => candidate.role === 'assistant');
              const producedFiles =
                message.role === 'assistant'
                  ? producedFilesForMessage(projection, message.turnId, message.seq)
                  : [];
              return (
                <article
                  className={`message ${message.role}`}
                  key={`${message.seq}-${message.role}`}
                >
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
                      {shouldRenderExecutionForMessage({
                        isLastAssistant,
                        messageTurnId: message.turnId,
                        executionTurnId: executionTurn?.id ?? null,
                        hasRunningStream: Boolean(runningStream),
                      }) && (
                        <ExecutionProcess
                          projection={projection}
                          sessionId={props.sessionId}
                          onOpenError={props.onNotifyError}
                        />
                      )}
                      <MarkdownContent
                        content={message.content}
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
                            onClick={() => void navigator.clipboard.writeText(message.content)}
                            title="复制"
                          >
                            <Copy size={14} />
                          </button>
                          <button title="重新发送暂未开放" disabled>
                            <RotateCcw size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
            {shouldRenderStandaloneExecution({
              executionTurnId: executionTurn?.id ?? null,
              hasRunningStream: Boolean(runningStream),
              executionTurnHasAssistant,
            }) && (
              <div className="assistant-block">
                <ExecutionProcess
                  projection={projection}
                  sessionId={props.sessionId}
                  onOpenError={props.onNotifyError}
                />
              </div>
            )}
            {runningStream && (
              <article className="message assistant streaming" aria-live="polite">
                <div className="assistant-block">
                  <ExecutionProcess
                    projection={projection}
                    sessionId={props.sessionId}
                    onOpenError={props.onNotifyError}
                  />
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
              </article>
            )}
            {pendingInteraction && (
              <InteractionCard
                interaction={pendingInteraction}
                onResolve={props.onResolveInteraction}
              />
            )}
          </div>
        )}
        {showBackToBottom && (
          <button className="back-to-bottom" onClick={scrollToBottom} aria-label="回到最新消息">
            <ArrowDown size={16} />
          </button>
        )}
      </div>

      <div className="input-gradient">
        <InputArea
          processing={Boolean(active)}
          disabled={!projection || !props.runtimeReady}
          queue={projection?.inbox ?? []}
          busyActionId={props.busyActionId}
          onSend={props.onSend}
          onStop={props.onStop}
          onRemove={props.onRemove}
          onReplace={props.onReplace}
          onPromote={props.onPromote}
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
  const [value, setValue] = useState(interaction.options[0] ?? '');
  const confirmation = interaction.kind === 'confirm' || interaction.kind === 'approval';
  return (
    <section className="interaction-card">
      <span className="interaction-label">需要你的确认</span>
      <p>{interaction.prompt}</p>
      {!confirmation && interaction.options.length > 0 && (
        <SelectMenu
          value={value}
          ariaLabel="选择回复"
          options={interaction.options.map((option) => ({ value: option, label: option }))}
          onChange={setValue}
        />
      )}
      {!confirmation && interaction.options.length === 0 && (
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="请输入回复"
        />
      )}
      <div className="interaction-actions">
        <button className="secondary" onClick={() => onResolve(interaction.id, null, 'cancelled')}>
          <X size={14} /> 取消
        </button>
        {confirmation && (
          <button
            className="secondary danger"
            onClick={() => onResolve(interaction.id, false, 'rejected')}
          >
            拒绝
          </button>
        )}
        <button
          className="primary"
          onClick={() => onResolve(interaction.id, confirmation ? true : value)}
        >
          <Check size={14} /> 提交
        </button>
      </div>
    </section>
  );
}
