export function OfficeBubble({
  text,
  label,
  handoff,
}: {
  text: string;
  label: string;
  handoff: boolean;
}) {
  return (
    <foreignObject x="-115" y="-224" width="230" height="100">
      <div className={`office-speech ${handoff ? 'handoff' : ''}`} title={text}>
        <strong>{label}</strong>
        <span>{text}</span>
      </div>
    </foreignObject>
  );
}
