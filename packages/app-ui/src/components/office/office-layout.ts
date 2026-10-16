export type OfficePoint = { x: number; y: number };

export function deskPosition(index: number): OfficePoint {
  const slots = [
    { x: 435, y: 524 },
    { x: 244, y: 281 },
    { x: 742, y: 291 },
    { x: 733, y: 524 },
  ];
  return (
    slots[index] ?? { x: index % 2 === 0 ? 244 : 742, y: 750 + Math.floor((index - 4) / 2) * 230 }
  );
}

export function officeVisitPath(from: OfficePoint, to: OfficePoint, returning = false): string {
  const points = [
    { x: from.x, y: from.y + 66 },
    { x: from.x, y: from.y + 112 },
    { x: 585, y: from.y + 112 },
    { x: 585, y: to.y + 112 },
    { x: to.x + (to.x < 500 ? 112 : -112), y: to.y + 112 },
    { x: to.x + (to.x < 500 ? 112 : -112), y: to.y + 66 },
  ];
  if (returning) points.reverse();
  return points.map((p, index) => `${index ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
}
