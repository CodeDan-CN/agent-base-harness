import room from './assets/office-room-reference.png';

export function OfficeDesk({
  index,
  selected,
  working,
}: {
  index: number;
  selected: boolean;
  working: boolean;
}) {
  return (
    <g className={working ? 'office-desk working' : 'office-desk'}>
      {index >= 4 && (
        <svg x="-125" y="-85" width="250" height="175" viewBox="625 205 250 175">
          <image href={room} width="1000" height="660" preserveAspectRatio="none" />
        </svg>
      )}
      <rect
        x="-104"
        y="-78"
        width="208"
        height="151"
        rx="8"
        fill="transparent"
        stroke={selected ? '#b1f2b9' : 'transparent'}
        strokeWidth="2.5"
      />
      {working && (
        <path
          d="M-49-61h48m-48 7h31"
          stroke="#e7fff1"
          strokeWidth="2"
          opacity=".45"
          className="office-screen-lines"
        />
      )}
    </g>
  );
}
