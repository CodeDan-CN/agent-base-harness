import sprites from './assets/office-walk-characters.png';
import type { OfficeWalkFrame } from './office-walk';

// Measured atlas anchors keep the head and planted foot steady between poses.
// Left-facing frames reuse the right-facing artwork without mirroring UI labels.
const centers = [132, 354, 575, 797, 1025, 1245, 1470, 1690];
const rows = [
  [0, 226],
  [228, 218],
  [447, 218],
  [665, 222],
];

export function OfficeWalkPerson({ index, walk }: { index: number; walk: OfficeWalkFrame }) {
  const column =
    walk.facing === 'up'
      ? 6 + Math.floor(walk.frame / 2)
      : walk.facing === 'down'
        ? 4 + Math.floor(walk.frame / 2)
        : walk.frame;
  const [top, height] = rows[Math.max(0, index) % 4]!;
  return (
    <g
      className="office-walk-sprite"
      data-facing={walk.facing}
      data-frame={walk.frame}
      transform={walk.facing === 'left' ? 'scale(-1 1)' : undefined}
    >
      <svg
        x="-49"
        y="-127"
        width="98"
        height="132"
        viewBox={`${centers[column]! - 82} ${top} 164 ${height}`}
        preserveAspectRatio="xMidYMax meet"
        overflow="hidden"
      >
        <image href={sprites} width="1774" height="887" />
      </svg>
    </g>
  );
}
