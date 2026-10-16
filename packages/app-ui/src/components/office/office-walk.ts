export type OfficeFacing = 'left' | 'right' | 'up' | 'down';

export type OfficeWalkSegment = { end: number; facing: OfficeFacing };
export type OfficeWalkFrame = { facing: OfficeFacing; frame: number; moving: boolean };

// Office routes are M/L polylines. Distances match the shared position/frame clock,
// including short segments and repeated points at shared aisle intersections.
export function officeWalkSegments(path: string): OfficeWalkSegment[] {
  const points = [...path.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));
  let distance = 0;
  const segments: OfficeWalkSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index]!.x - points[index - 1]!.x;
    const dy = points[index]!.y - points[index - 1]!.y;
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    distance += length;
    segments.push({
      end: distance,
      facing: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up',
    });
  }
  return segments;
}

export function officeWalkFrame(
  segments: OfficeWalkSegment[],
  elapsedMs: number,
  durationMs: number,
): OfficeWalkFrame {
  const total = segments.at(-1)?.end ?? 0;
  const progress = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1;
  const facing =
    segments.find((segment) => segment.end > total * progress)?.facing ??
    segments.at(-1)?.facing ??
    'down';
  const moving = total > 0 && progress < 1;
  return { facing, frame: moving ? Math.floor(Math.max(0, elapsedMs) / 120) % 4 : 0, moving };
}
