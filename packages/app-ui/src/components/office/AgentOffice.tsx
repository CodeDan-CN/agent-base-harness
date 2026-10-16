import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Coffee, Loader2, MessageSquare } from 'lucide-react';
import type { RuntimeProjection } from '@client-contracts';
import { activeDelegation, delegationTask, type OfficeAgent } from './office-model';
import { OfficeScene } from './OfficeScene';
import { PixelPerson } from './OfficeAgent';
import { OfficeInspector } from './OfficeInspector';
import { OfficeActivityLog } from './OfficeActivityLog';
import { useOfficeAnimation } from './use-office-animation';
import { useOfficeData, OfficeSessionObserver } from './use-office-data';
import './office.css';

function isWorkingStatus(status: string): boolean {
  return (
    status === '协调任务' ||
    status === '已接纳' ||
    status.includes('执行中') ||
    status.startsWith('等待')
  );
}

export function AgentOffice({
  caller,
  sidebarOpen,
  embedded = false,
  pendingContent,
  revision,
  projection,
  sessionId,
  loading,
  runtimeReady,
  onOpenConversation,
  onOpenPending,
  onNotifyError,
}: {
  caller: OfficeAgent;
  sidebarOpen: boolean;
  embedded?: boolean;
  pendingContent: ReactNode;
  revision?: number;
  projection: RuntimeProjection | null;
  sessionId: string | null;
  loading: boolean;
  runtimeReady: boolean;
  onOpenConversation(): void;
  onOpenPending(): void;
  onNotifyError(message: string): void;
}) {
  const data = useOfficeData({ caller, projection, sessionId, runtimeReady, revision });
  const {
    delegations,
    members,
    selected,
    subscribedIds,
    onChildChange,
    statuses,
    bubbles,
    activeCount,
  } = data;
  const [inspectorOpen, setInspectorOpen] = useState(() => !embedded && window.innerWidth > 1200);
  const awaitingAgentId = delegations.find(
    (item) => item.status === 'awaiting_user',
  )?.targetAgentId;
  const selectAgent = data.select;
  useEffect(() => {
    if (awaitingAgentId) {
      selectAgent(awaitingAgentId);
      setInspectorOpen(true);
    }
  }, [awaitingAgentId, selectAgent]);
  const [teamSlot, setTeamSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTeamSlot(document.getElementById('office-team-slot'));
  }, [sidebarOpen]);
  const select = (id: string) => {
    data.select(id);
    setInspectorOpen(true);
  };
  const choreography = useOfficeAnimation(delegations, !loading && Boolean(projection));
  const visiting = delegations.find((item) => item.id === choreography.visit?.delegationId);
  const visitText = visiting
    ? choreography.visit?.kind === 'assign'
      ? delegationTask(projection, visiting)
      : (visiting.report ?? '任务已完成，结果已交回。')
    : '';
  const team = (
    <div className="office-team-list" aria-label="办公室成员">
      <h3>团队</h3>
      {members.map((member, index) => (
        <button
          key={member.id}
          className={member.id === selected.id ? 'selected' : ''}
          onClick={() => select(member.id)}
        >
          <svg viewBox="-28 -64 56 74" aria-hidden="true">
            <PixelPerson index={index} />
          </svg>
          <span>
            {member.name}
            <i className={statuses[member.id]?.includes('等待') ? 'waiting' : ''} />
            <small>{statuses[member.id]}</small>
          </span>
        </button>
      ))}
    </div>
  );
  const workingMembers = members.filter((member) => isWorkingStatus(statuses[member.id] ?? ''));
  const workSummary = (member: OfficeAgent): string => {
    const status = statuses[member.id] ?? '待命';
    if (status === '连接中') return '正在连接工作空间';
    if (!isWorkingStatus(status)) return '暂无进行中的任务';
    if (member.id === caller.id) {
      return activeCount > 0
        ? `正在协调 ${activeCount} 项协作`
        : bubbles[member.id] || '正在处理当前对话';
    }
    const task = [...delegations]
      .reverse()
      .find((item) => item.targetAgentId === member.id && activeDelegation(item));
    const summary = task ? delegationTask(projection, task) : null;
    return summary && summary !== '查看委派执行详情' ? summary : '正在处理受派任务';
  };

  return (
    <section
      className={`agent-office ${inspectorOpen ? 'inspector-open' : ''} ${embedded ? 'embedded' : ''}`}
      aria-label="团队办公室"
      data-visit={choreography.visit?.kind ?? 'idle'}
      data-visit-delegation={choreography.visit?.delegationId ?? ''}
      data-stage={choreography.stage}
    >
      {subscribedIds.map((id) => (
        <OfficeSessionObserver key={id} sessionId={id} onChange={onChildChange} />
      ))}
      <div className="office-main">
        {data.rosterError && (
          <div className="office-roster-error" role="status">
            协作伙伴列表暂时不可用 <button onClick={data.retryRoster}>重试</button>
          </div>
        )}
        <div className="office-room-frame">
          {loading ? (
            <div className="office-loading">
              <Loader2 className="spin" size={20} />
              正在恢复办公室…
            </div>
          ) : (
            <OfficeScene
              members={members}
              selectedId={selected.id}
              onSelect={select}
              statuses={statuses}
              bubbles={bubbles}
              {...choreography}
              delegation={visiting}
              visitText={visitText}
              idleEnabled={runtimeReady}
              reservedIds={choreography.queued ? [caller.id, ...choreography.reservedAgentIds] : []}
            />
          )}
          {!runtimeReady && (
            <div className="office-connection" role="status">
              正在连接服务，显示最后收到的状态
            </div>
          )}
        </div>
        {embedded && (
          <div className="office-working-panel" aria-label="智能体工作状态" aria-live="polite">
            <div className="office-working-heading">
              <strong>团队状态</strong>
              <span>
                {workingMembers.length ? `${workingMembers.length} 位正在工作` : '全员待命'}
              </span>
            </div>
            <div className="office-working-list">
              {members.map((member, index) => (
                <button key={member.id} onClick={() => select(member.id)}>
                  <svg viewBox="-28 -64 56 74" aria-hidden="true">
                    <PixelPerson index={index} />
                  </svg>
                  <span className="office-working-copy">
                    <span className="office-working-primary">
                      <strong>{member.name}</strong>
                      <span className="office-working-status">
                        <i
                          className={`office-working-dot ${statuses[member.id]?.startsWith('等待') ? 'waiting' : !isWorkingStatus(statuses[member.id] ?? '') ? 'idle' : ''}`}
                        />
                        {statuses[member.id]}
                      </span>
                    </span>
                    <span className="office-working-summary" title={workSummary(member)}>
                      {workSummary(member)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!embedded && (
          <>
            <div className="office-bottom-strip" aria-live="polite">
              {visiting ? (
                <>
                  <MessageSquare size={15} />
                  <span>
                    {choreography.visit?.kind === 'assign'
                      ? `${caller.name} → ${visiting.targetAgentName ?? '协作伙伴'}：交代任务`
                      : `${visiting.targetAgentName ?? '协作伙伴'} → ${caller.name}：交付结果`}
                  </span>
                  {choreography.queued > 1 && <small>还有 {choreography.queued - 1} 次交接</small>}
                </>
              ) : (
                <>
                  <Coffee size={15} />
                  <span>
                    {activeCount
                      ? '伙伴们正在各自的工位处理任务'
                      : '向下方输入任务，让团队开始协作'}
                  </span>
                </>
              )}
            </div>
            <OfficeActivityLog delegations={delegations} onSelect={select} members={members} />
            {teamSlot ? createPortal(team, teamSlot) : team}
          </>
        )}
        {!inspectorOpen && pendingContent}
      </div>
      {inspectorOpen && (
        <OfficeInspector
          data={data}
          caller={caller}
          projection={projection}
          sessionId={sessionId}
          onClose={() => setInspectorOpen(false)}
          onOpenPending={onOpenPending}
          onOpenConversation={onOpenConversation}
          onNotifyError={onNotifyError}
          pendingContent={pendingContent}
        />
      )}
    </section>
  );
}
