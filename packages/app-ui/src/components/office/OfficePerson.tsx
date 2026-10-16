import sprites from './assets/office-characters.png';
import idleSprites from './assets/office-idle-characters.png';

// Atlas bounds are measured from the generated asset; no face or role is inferred from Agent data.
const standing = [
  [94, 40, 235, 520],
  [470, 52, 240, 510],
  [829, 56, 245, 505],
  [1211, 40, 238, 520],
];
const seated = [
  [87, 594, 247, 390],
  [470, 612, 245, 370],
  [837, 615, 247, 369],
  [1214, 598, 249, 387],
];
const portraits = [
  [133, 42, 170, 188],
  [508, 62, 171, 191],
  [874, 62, 171, 191],
  [1246, 42, 176, 194],
];

export function OfficePerson({
  index,
  sitting = false,
  portrait = false,
  idlePose,
}: {
  index: number;
  sitting?: boolean;
  portrait?: boolean;
  idlePose?: 'sofa' | 'window';
}) {
  const column = Math.max(0, index) % 4;
  if (idlePose) {
    const sofa = idlePose === 'sofa';
    return (
      <svg
        x={sofa ? -70 : -34}
        y={sofa ? -70 : -127}
        width={sofa ? 140 : 68}
        height={sofa ? 70 : 132}
        viewBox={sofa ? `${column * 384} 720 384 190` : `${column * 384 + 88} 55 236 545`}
        preserveAspectRatio="xMidYMax meet"
        overflow="hidden"
      >
        <image href={idleSprites} width="1536" height="1024" />
      </svg>
    );
  }
  const bounds = (portrait ? portraits : sitting ? seated : standing)[Math.max(0, index) % 4]!;
  return (
    <svg
      x={portrait ? -28 : sitting ? -43 : -34}
      y={portrait ? -60 : sitting ? -133 : -127}
      width={portrait ? 56 : sitting ? 86 : 68}
      height={portrait ? 70 : sitting ? 133 : 132}
      viewBox={bounds.join(' ')}
      preserveAspectRatio="xMidYMax meet"
      overflow="hidden"
    >
      <image href={sprites} width="1536" height="1024" />
    </svg>
  );
}
