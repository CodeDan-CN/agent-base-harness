import { useEffect, useState, type CSSProperties } from 'react';
import type { ProjectedDelegation } from '@client-contracts';
import room from './assets/office-room-reference.png';
import { deskPosition, officeVisitPath } from './office-layout';
import type { OfficeAgent as OfficeMember } from './office-model';
import type { OfficeStage, OfficeVisit } from './office-choreography';
import { OfficeAgent } from './OfficeAgent';
import { OfficeDesk } from './OfficeDesk';
import { useOfficeIdle } from './use-office-idle';
import { idleDestinations, idleLabels, idlePath } from './office-idle';

export function OfficeScene({
  members,
  selectedId,
  onSelect,
  statuses,
  bubbles,
  visit,
  stage,
  reducedMotion,
  delegation,
  visitText,
  idleEnabled,
  reservedIds,
  onVisitArrive,
}: {
  members: OfficeMember[];
  selectedId: string;
  onSelect(id: string): void;
  statuses: Record<string, string>;
  bubbles: Record<string, string>;
  visit: OfficeVisit | null;
  stage: 'outbound' | 'speaking' | 'returning';
  reducedMotion: boolean;
  delegation?: ProjectedDelegation;
  visitText: string;
  idleEnabled: boolean;
  reservedIds: string[];
  onVisitArrive(id: string, stage: OfficeStage): void;
}) {
  const { activities: idle, arrive: arriveIdle } = useOfficeIdle(
    members,
    statuses,
    idleEnabled && !reducedMotion,
    reservedIds,
  );
  const [arrivals, setArrivals] = useState<Record<string, string>>({});
  const [walking, setWalking] = useState<Record<string, boolean>>({});
  const height = Math.max(660, 660 + Math.ceil((members.length - 4) / 2) * 230);
  const caller = members[0];
  const targetIndex = members.findIndex((item) => item.id === delegation?.targetAgentId);
  const movingIndex = visit && targetIndex > 0 ? (visit.kind === 'assign' ? 0 : targetIndex) : -1;
  const from = deskPosition(Math.max(0, movingIndex));
  const to = deskPosition(visit?.kind === 'assign' ? Math.max(0, targetIndex) : 0);
  const path = officeVisitPath(from, to, stage === 'returning');
  const destination = { x: to.x + (to.x < 500 ? 112 : -112), y: to.y + 66 };
  const receiverIndex = visit?.kind === 'assign' ? targetIndex : 0;
  const visitKey = visit ? `${visit.id}:${stage}` : '';
  useEffect(() => {
    if (!visit || stage === 'speaking') return;
    const mover = members[movingIndex];
    const receiver = members[receiverIndex];
    if (
      !mover ||
      !receiver ||
      (arrivals[mover.id] === visitKey &&
        (stage === 'returning' || arrivals[receiver.id] === visitKey))
    ) {
      onVisitArrive(visit.id, stage);
    }
  }, [visit, stage, members, movingIndex, receiverIndex, arrivals, visitKey, onVisitArrive]);

  return (
    <div className="office-scene-scroll custom-scrollbar">
      <svg
        className="office-scene"
        viewBox={`0 0 1000 ${height}`}
        aria-label="智能体办公室，点击角色或工位查看任务"
        style={
          {
            minHeight: members.length > 4 ? height * 0.48 : 0,
            aspectRatio: `1000 / ${height}`,
          } as CSSProperties
        }
      >
        <defs>
          <pattern id="office-floor" width="200" height="34" patternUnits="userSpaceOnUse">
            <rect width="200" height="34" fill="#d6b17f" />
            <path d="M0 33h200M0 0v33" stroke="#b99365" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="1000" height={height} fill="url(#office-floor)" />
        <image href={room} width="1000" height="660" preserveAspectRatio="none" />
        {visit && movingIndex >= 0 && (
          <path
            d={officeVisitPath(from, to)}
            fill="none"
            stroke="#3b795b"
            strokeWidth="3"
            strokeDasharray="5 9"
            opacity=".45"
          />
        )}
        {members.map((member, index) => {
          const position = deskPosition(index);
          const status = statuses[member.id] ?? '待命';
          return (
            <g
              key={`desk:${member.id}`}
              transform={`translate(${position.x} ${position.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${member.name}的工位：${status}`}
              aria-pressed={selectedId === member.id}
              className="office-station"
              onClick={() => onSelect(member.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(member.id);
                }
              }}
            >
              <title>
                {member.name} · {status}
              </title>
              <OfficeDesk
                index={index}
                selected={selectedId === member.id}
                working={status.includes('执行中')}
              />
              <foreignObject x="-115" y="-108" width="230" height="38">
                <div className={`office-nameplate ${status.includes('等待') ? 'waiting' : ''}`}>
                  <i />
                  <b className="office-member-name">{member.name}</b>
                  <span>{status}</span>
                </div>
              </foreignObject>
            </g>
          );
        })}
        {members.map((member, index) => {
          const moving = index === movingIndex;
          const position = deskPosition(index);
          const atMeeting = moving && stage === 'speaking';
          const activity = idle[member.id];
          const resting = activity?.phase === 'resting';
          const point =
            activity && resting
              ? idleDestinations[activity.kind]
              : atMeeting && !reducedMotion
                ? destination
                : { x: position.x, y: position.y + 66 };
          const receiving =
            visit && stage === 'speaking' && index === (visit.kind === 'assign' ? targetIndex : 0);
          const motionKey =
            visit && (moving || index === receiverIndex)
              ? visitKey
              : activity
                ? `${activity.kind}:${activity.phase}:${activity.startedAt}`
                : 'desk';
          const bubble = atMeeting ? visitText : moving || receiving ? '' : bubbles[member.id];
          return (
            <OfficeAgent
              key={member.id}
              index={index}
              point={point}
              path={
                moving && !atMeeting && !reducedMotion
                  ? path
                  : activity && !resting
                    ? idlePath(index, activity.kind, activity.phase === 'returning')
                    : undefined
              }
              motionKey={motionKey}
              reducedMotion={reducedMotion}
              onMovingChange={(value) =>
                setWalking((current) =>
                  current[member.id] === value ? current : { ...current, [member.id]: value },
                )
              }
              onArrive={() => {
                setArrivals((current) =>
                  current[member.id] === motionKey
                    ? current
                    : { ...current, [member.id]: motionKey },
                );
                if (activity && !resting) arriveIdle(member.id, activity);
              }}
              idleKind={resting ? activity.kind : undefined}
              idleLabel={
                activity
                  ? `${member.name} · ${activity.phase === 'returning' ? '回到工位' : idleLabels[activity.kind]}`
                  : undefined
              }
              agentId={member.id}
              sitting={!moving && !activity}
              bubble={bubble ?? ''}
              label={
                atMeeting
                  ? visit?.kind === 'assign'
                    ? `${caller?.name}交代任务`
                    : `${member.name}交付结果`
                  : member.name
              }
              handoff={atMeeting}
              onSelect={() => onSelect(member.id)}
            />
          );
        })}
        {/* Chair backs sit in front of seated characters. Moving actors remain above the furniture. */}
        {members.slice(0, 4).map((member, index) => {
          if (index === movingIndex || idle[member.id] || walking[member.id]) return null;
          const position = deskPosition(index);
          return (
            <svg
              key={`chair:${member.id}`}
              x={position.x - 37}
              y={position.y - 6}
              width="74"
              height="89"
              viewBox={`${position.x - 37} ${position.y - 6} 74 89`}
              pointerEvents="none"
              aria-hidden="true"
            >
              <defs>
                <clipPath id={`office-chair-${index}`}>
                  <path
                    d={`M ${position.x - 24} ${position.y - 5} Q ${position.x - 31} ${position.y - 5} ${position.x - 31} ${position.y + 5} L ${position.x - 30} ${position.y + 48} Q ${position.x} ${position.y + 59} ${position.x + 29} ${position.y + 48} L ${position.x + 30} ${position.y + 5} Q ${position.x + 30} ${position.y - 5} ${position.x + 20} ${position.y - 5} Z`}
                  />
                </clipPath>
              </defs>
              <image
                href={room}
                width="1000"
                height="660"
                preserveAspectRatio="none"
                clipPath={`url(#office-chair-${index})`}
              />
            </svg>
          );
        })}
      </svg>
    </div>
  );
}
