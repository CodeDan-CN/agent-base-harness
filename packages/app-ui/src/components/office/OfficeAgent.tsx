import { OfficeBubble } from './OfficeBubble';
import { OfficePerson } from './OfficePerson';
import type { OfficePoint } from './office-layout';
import type { OfficeIdleKind } from './office-idle';
import { OfficeWalkPerson } from './OfficeWalkPerson';
import { useOfficeMovement } from './use-office-movement';

// Kept as the shared avatar entry point for member buttons and the inspector.
export function PixelPerson({ index }: { index: number }) {
  return <OfficePerson index={index} portrait />;
}

export function OfficeAgent({
  index,
  point,
  path,
  bubble,
  label,
  handoff,
  idleKind,
  idleLabel,
  agentId,
  motionKey,
  reducedMotion,
  onArrive,
  onMovingChange,
  sitting = false,
  onSelect,
}: {
  index: number;
  point: OfficePoint;
  path?: string;
  bubble: string;
  label: string;
  handoff: boolean;
  idleKind?: OfficeIdleKind;
  idleLabel?: string;
  agentId?: string;
  motionKey: string;
  reducedMotion: boolean;
  onArrive(): void;
  onMovingChange(moving: boolean): void;
  sitting?: boolean;
  onSelect(): void;
}) {
  const { element, walk } = useOfficeMovement({
    point,
    path,
    motionKey,
    reducedMotion,
    onArrive,
    onMovingChange,
  });
  const pose = walk.moving ? undefined : idleKind;
  const seated = sitting && !walk.moving;
  return (
    <g
      ref={element}
      data-moving={walk.moving ? 'true' : 'false'}
      className="office-character"
      data-agent-id={agentId}
      data-idle={idleKind ?? (idleLabel ? 'walking' : undefined)}
      onClick={onSelect}
      aria-hidden="true"
    >
      <g className={`office-person ${walk.moving ? 'walking' : ''}`}>
        {!seated && pose !== 'sofa' && (
          <ellipse cy="1" rx="24" ry="7" fill="#47341f" opacity=".17" />
        )}
        <g>
          <g className={`office-person-body ${pose ? `resting-${pose}` : ''}`}>
            {walk.moving ? (
              <OfficeWalkPerson index={index} walk={walk} />
            ) : (
              <OfficePerson
                index={index}
                sitting={seated}
                idlePose={pose === 'sofa' || pose === 'window' ? pose : undefined}
              />
            )}
            {pose === 'coffee' && (
              <g className="office-coffee-cup">
                <path d="M10-67h13v14H10z" fill="#fff5db" stroke="#b89b6e" strokeWidth="1.5" />
                <path d="M23-65h4v8h-4" fill="none" stroke="#fff5db" strokeWidth="3" />
                <path
                  className="office-steam"
                  d="M13-72q-4-4 0-8m7 8q-4-4 0-8"
                  stroke="#fff9e8"
                  strokeWidth="2"
                  fill="none"
                />
              </g>
            )}
          </g>
        </g>
        {pose === 'sofa' && (
          <g className="office-snooze" fill="#fff9e9" fontSize="14" fontWeight="600">
            <text x="-25" y="-76">
              z
            </text>
            <text x="-12" y="-89">
              z
            </text>
          </g>
        )}
      </g>
      {idleLabel && (
        <foreignObject x="-95" y="13" width="190" height="32">
          <div className="office-idle-label">{idleLabel}</div>
        </foreignObject>
      )}
      {bubble && <OfficeBubble text={bubble} label={label} handoff={handoff} />}
    </g>
  );
}
