import { ArrowRight, CheckCircle2, Hand, Loader2, X } from 'lucide-react';
import { ExecutionProcess } from '../ExecutionProcess';
import { MarkdownContent } from '../MarkdownContent';
import { ProducedFiles } from '../ProducedFiles';
import { PixelPerson } from './OfficeAgent';
import { delegationLabels, delegationTask, type OfficeAgent } from './office-model';
import type { RuntimeProjection } from '@client-contracts';
import type { useOfficeData } from './use-office-data';
import type { ReactNode } from 'react';
import { OfficeTaskTimeline } from './OfficeTaskTimeline';

export function OfficeInspector({
  data,
  caller,
  projection,
  sessionId,
  onClose,
  onOpenPending,
  onOpenConversation,
  onNotifyError,
  pendingContent,
}: {
  data: ReturnType<typeof useOfficeData>;
  caller: OfficeAgent;
  projection: RuntimeProjection | null;
  sessionId: string | null;
  onClose(): void;
  onOpenPending(): void;
  onOpenConversation(): void;
  onNotifyError(message: string): void;
  pendingContent: ReactNode;
}) {
  const {
    selected,
    members,
    statuses,
    selectedTask,
    tasks,
    setSelectedTaskId,
    pendingCount,
    selectedProjection,
    turns,
    selectedSessionId,
    latestAnswer,
    files,
    selectedState,
    activeCount,
  } = data;
  const latestTurn = [...(selectedProjection?.turns.values() ?? [])].at(-1);
  const latestRequest = [...(projection?.messages ?? [])]
    .reverse()
    .find((item) => item.role === 'user');
  return (
    <aside className="office-inspector custom-scrollbar" aria-label={`${selected.name}的任务详情`}>
      <p className="office-inspector-motto">好的创意，值得一群人一起实现。</p>
      <div className="office-inspector-heading">
        <svg viewBox="-28 -64 56 74" aria-hidden="true">
          <PixelPerson index={members.findIndex((item) => item.id === selected.id)} />
        </svg>
        <div>
          <h3>{selected.name}</h3>
          <p>
            {selected.description || (selected.id === caller.id ? '当前对话的智能体' : '协作伙伴')}
          </p>
        </div>
        <button className="icon-button" onClick={() => onClose()} aria-label="收起任务详情">
          <X size={16} />
        </button>
      </div>
      <span
        className={`office-status-pill ${statuses[selected.id]?.includes('等待') ? 'waiting' : ''}`}
      >
        {statuses[selected.id]}
      </span>
      {selectedTask ? (
        <>
          <section className="office-detail-section">
            <h4>当前委派</h4>
            {tasks.length > 1 && (
              <select
                aria-label="选择委派任务"
                value={selectedTask.id}
                onChange={(event) => setSelectedTaskId(event.target.value)}
              >
                {tasks.map((task, index) => (
                  <option key={task.id} value={task.id}>
                    {tasks.length - index}. {delegationLabels[task.status]} ·{' '}
                    {delegationTask(projection, task).slice(0, 35)}
                  </option>
                ))}
              </select>
            )}
            <MarkdownContent
              content={delegationTask(projection, selectedTask)}
              sessionId={sessionId}
              onOpenError={onNotifyError}
            />
            <small>
              来自 {selectedTask.callerAgentName ?? caller.name} ·{' '}
              {delegationLabels[selectedTask.status]}
            </small>
          </section>
          {selectedTask.report && (
            <section className="office-detail-section">
              <h4>
                <CheckCircle2 size={15} />
                交付报告
              </h4>
              <MarkdownContent
                content={selectedTask.report}
                sessionId={selectedTask.delegatedSessionId}
                onOpenError={onNotifyError}
              />
            </section>
          )}
        </>
      ) : (
        <section className="office-detail-section">
          <h4>{selected.id === caller.id ? '当前任务' : '等待协作'}</h4>
          {selected.id === caller.id && latestRequest ? (
            <>
              <details className="office-task-brief">
                <summary>
                  {latestRequest.content.slice(0, 80)}
                  {latestRequest.content.length > 80 ? '…' : ''}
                </summary>
                <MarkdownContent
                  content={latestRequest.content}
                  sessionId={sessionId}
                  onOpenError={onNotifyError}
                />
              </details>
              {activeCount > 0 && <p>正在协调 {activeCount} 项委派，结果会回到当前对话。</p>}
              {latestTurn?.endReason === 'model_credential_missing' && (
                <p className="office-error">当前模型缺少凭据，请在模型设置中补充后重试。</p>
              )}
            </>
          ) : (
            <p>
              {selected.id === caller.id
                ? '在下方描述你的目标，我会根据任务请求伙伴协作。'
                : '本会话还没有交给这位伙伴的任务。'}
            </p>
          )}
        </section>
      )}
      {pendingContent && (
        <section className="office-detail-section office-confirmation">
          <h4>需要你确认</h4>
          {pendingContent}
        </section>
      )}
      {pendingCount > 0 && !pendingContent && (
        <button className="office-pending-button" onClick={onOpenPending}>
          <Hand size={15} />
          处理待办
          <ArrowRight size={14} />
        </button>
      )}
      {selectedProjection && (
        <section className="office-detail-section">
          <h4>执行记录</h4>
          <OfficeTaskTimeline projection={selectedProjection} task={selectedTask} />
          <details className="office-full-execution">
            <summary>查看完整执行过程 →</summary>
            <ExecutionProcess
              projection={selectedProjection}
              turnIds={turns}
              sessionId={selectedSessionId}
              embedded
              onOpenError={onNotifyError}
            />
          </details>
          {selected.id === caller.id && latestAnswer && (
            <MarkdownContent
              content={latestAnswer.content}
              sessionId={sessionId}
              onOpenError={onNotifyError}
            />
          )}
          <ProducedFiles sessionId={selectedSessionId} paths={files} onOpenError={onNotifyError} />
        </section>
      )}
      {selectedTask && !selectedProjection && (
        <div className="office-detail-section" role="status">
          {selectedState?.error ? (
            <>
              <p>{selectedState.error}</p>
              <button className="office-link" onClick={() => selectedState.retry()}>
                重新连接执行记录
              </button>
            </>
          ) : (
            <p>
              <Loader2 size={14} className="spin" /> 正在读取执行记录…
            </p>
          )}
        </div>
      )}
      <button className="office-link" onClick={onOpenConversation}>
        回到完整对话
        <ArrowRight size={14} />
      </button>
    </aside>
  );
}
