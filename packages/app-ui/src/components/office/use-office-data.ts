import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentManagementSnapshot, RuntimeProjection } from '@client-contracts';
import { query, userMessage } from '../../client';
import { useSessionProjection } from '../../use-session-projection';
import { producedFilesForMessage } from '../../produced-files';
import {
  activeDelegation,
  callerStatus,
  delegationLabels,
  officeActivity,
  officeMembers,
  type OfficeAgent,
} from './office-model';

type ChildState = ReturnType<typeof useSessionProjection>;

export function OfficeSessionObserver({
  sessionId,
  onChange,
}: {
  sessionId: string;
  onChange(id: string, state: ChildState | null): void;
}) {
  const state = useSessionProjection(sessionId);
  useEffect(() => {
    onChange(sessionId, state);
  }, [sessionId, state.projection, state.status, state.error, onChange]);
  useEffect(() => () => onChange(sessionId, null), [sessionId, onChange]);
  return null;
}

export function useOfficeData({
  caller,
  projection,
  sessionId,
  runtimeReady,
  revision,
}: {
  caller: OfficeAgent;
  projection: RuntimeProjection | null;
  sessionId: string | null;
  runtimeReady: boolean;
  revision?: number;
}) {
  const [management, setManagement] = useState<AgentManagementSnapshot | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterAttempt, setRosterAttempt] = useState(0);
  useEffect(() => {
    if (!runtimeReady) return;
    let active = true;
    void query<AgentManagementSnapshot>('agent-management.snapshot')
      .then((snapshot) => {
        if (active) {
          setManagement(snapshot);
          setRosterError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) setRosterError(userMessage(error));
      });
    return () => {
      active = false;
    };
  }, [caller.id, revision, runtimeReady, rosterAttempt]);
  const agents = useMemo(() => {
    const ids = new Set(
      management?.agents.find((item) => item.profile.id === caller.id)?.bindings.delegateAgentIds ??
        [],
    );
    return (management?.agents ?? [])
      .filter((item) => ids.has(item.profile.id) && item.profile.status === 'active')
      .map((item) => item.profile);
  }, [management, caller.id]);
  const delegations = useMemo(
    () =>
      [...(projection?.delegations.values() ?? [])].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    [projection?.delegations],
  );
  const members = useMemo(
    () => officeMembers(caller, agents, delegations),
    [caller, agents, delegations],
  );
  const [selectedId, setSelectedId] = useState(caller.id);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<string, ChildState>>({});
  const onChildChange = useCallback(
    (id: string, state: ChildState | null) =>
      setChildren((previous) => {
        const next = { ...previous };
        if (state) next[id] = state;
        else delete next[id];
        return next;
      }),
    [],
  );
  const selected = members.find((member) => member.id === selectedId) ?? caller;
  const tasks = delegations.filter((item) => item.targetAgentId === selected.id).reverse();
  const selectedTask =
    tasks.find((item) => item.id === selectedTaskId) ?? tasks.find(activeDelegation) ?? tasks[0];
  const subscribedIds = [
    ...new Set([
      ...delegations.filter(activeDelegation).map((item) => item.delegatedSessionId),
      ...(selectedTask ? [selectedTask.delegatedSessionId] : []),
    ]),
  ];
  const selectedState = selectedTask ? children[selectedTask.delegatedSessionId] : undefined;
  const selectedProjection =
    selected.id === caller.id ? projection : (selectedState?.projection ?? null);
  const selectedSessionId =
    selected.id === caller.id ? sessionId : (selectedTask?.delegatedSessionId ?? null);
  const turns = [...(selectedProjection?.turns.keys() ?? [])];
  const pendingCount =
    [...(projection?.interactions.values() ?? [])].filter((item) => item.status === 'pending')
      .length +
    [...(projection?.approvals.values() ?? [])].filter((item) => item.status === 'pending').length;
  const activeCount = delegations.filter(activeDelegation).length;
  const select = useCallback((id: string) => {
    setSelectedId(id);
    setSelectedTaskId(null);
  }, []);
  const statuses: Record<string, string> = {};
  const bubbles: Record<string, string> = {};
  for (const member of members) {
    const memberTasks = delegations.filter((item) => item.targetAgentId === member.id);
    const ongoing = memberTasks.filter(activeDelegation);
    const task =
      ongoing.find((item) => item.status === 'awaiting_user') ??
      ongoing.at(-1) ??
      memberTasks.at(-1);
    if (member.id === caller.id) {
      statuses[member.id] = callerStatus(projection, runtimeReady, activeCount);
      if (!activeCount) bubbles[member.id] = officeActivity(projection) ?? '';
    } else {
      const child = task ? children[task.delegatedSessionId] : undefined;
      statuses[member.id] = task ? delegationLabels[task.status] : '待命';
      if (ongoing.length > 1 && task?.status !== 'awaiting_user')
        statuses[member.id] = `${ongoing.length} 项执行中`;
      if (
        child?.projection &&
        [...child.projection.approvals.values()].some((item) => item.status === 'pending')
      )
        statuses[member.id] = '等待授权';
      if (task && activeDelegation(task)) {
        bubbles[member.id] = child?.error
          ? '进展连接失败，点击查看详情'
          : (officeActivity(child?.projection ?? null) ??
            (task.status === 'awaiting_user' ? '需要你补充信息' : '已接收任务，准备执行…'));
      }
    }
  }
  const latestAnswer = [...(selectedProjection?.messages ?? [])]
    .reverse()
    .find(
      (item) => item.role === 'assistant' && !item.toolCalls?.length && item.phase !== 'commentary',
    );
  const files =
    selectedProjection && latestAnswer
      ? producedFilesForMessage(selectedProjection, latestAnswer.turnId, latestAnswer.seq)
      : [];

  return {
    delegations,
    members,
    selected,
    selectedTask,
    selectedTaskId,
    setSelectedTaskId,
    tasks,
    subscribedIds,
    onChildChange,
    selectedState,
    selectedProjection,
    selectedSessionId,
    turns,
    pendingCount,
    activeCount,
    select,
    statuses,
    bubbles,
    latestAnswer,
    files,
    rosterError,
    retryRoster: () => setRosterAttempt((value) => value + 1),
  };
}
