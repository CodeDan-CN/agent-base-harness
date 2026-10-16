import type { OfficePoint } from './office-layout';

export const OFFICE_WALK_SPEED = 230;
export const pointDistance = (a: OfficePoint, b: OfficePoint) => Math.hypot(a.x - b.x, a.y - b.y);

export function officePathPoints(path: string): OfficePoint[] {
  return [...path.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));
}

export function officePointAt(points: OfficePoint[], distance: number): OfficePoint {
  let remaining = Math.max(0, distance);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const length = pointDistance(from, to);
    if (length > 0 && remaining < length) {
      const fraction = remaining / length;
      return { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
    }
    remaining -= length;
  }
  return points.at(-1) ?? { x: 0, y: 0 };
}

// Join the old and new aisle routes at their shared vertices. Splitting edges at
// the current position lets interruptions reverse or continue without teleporting
// to the new route's nominal starting point or cutting across a desk.
export function continueOfficeRoute(
  current: OfficePoint,
  previous: OfficePoint[],
  requested: OfficePoint[],
): OfficePoint[] {
  const target = requested.at(-1) ?? current;
  if (pointDistance(current, target) < 0.01) return [target];
  const vertices: OfficePoint[] = [];
  const vertex = (point: OfficePoint) => {
    const existing = vertices.findIndex((candidate) => pointDistance(candidate, point) < 0.01);
    if (existing >= 0) return existing;
    vertices.push(point);
    return vertices.length - 1;
  };
  const start = vertex(current);
  const end = vertex(target);
  [...previous, ...requested].forEach(vertex);
  const edges = vertices.map(() => new Map<number, number>());
  for (const route of [previous, requested]) {
    for (let index = 1; index < route.length; index += 1) {
      const a = route[index - 1]!;
      const b = route[index]!;
      const length = pointDistance(a, b);
      if (!length) continue;
      const onEdge = vertices
        .map((point, id) => ({ id, distance: pointDistance(a, point), point }))
        .filter(
          ({ point, distance }) => Math.abs(distance + pointDistance(point, b) - length) < 0.01,
        )
        .sort((left, right) => left.distance - right.distance);
      for (let part = 1; part < onEdge.length; part += 1) {
        const from = onEdge[part - 1]!;
        const to = onEdge[part]!;
        const cost = to.distance - from.distance;
        edges[from.id]!.set(to.id, cost);
        edges[to.id]!.set(from.id, cost);
      }
    }
  }
  const distances = vertices.map(() => Infinity);
  const parents = vertices.map(() => -1);
  const visited = new Set<number>();
  distances[start] = 0;
  while (visited.size < vertices.length) {
    let nearest = -1;
    for (let id = 0; id < vertices.length; id += 1) {
      if (
        !visited.has(id) &&
        Number.isFinite(distances[id]) &&
        (nearest < 0 || distances[id]! < distances[nearest]!)
      )
        nearest = id;
    }
    if (nearest < 0 || nearest === end) break;
    visited.add(nearest);
    for (const [next, cost] of edges[nearest]!) {
      if (distances[nearest]! + cost < distances[next]!) {
        distances[next] = distances[nearest]! + cost;
        parents[next] = nearest;
      }
    }
  }
  // A roster/layout change can introduce an unrelated desk. Still move continuously.
  if (!Number.isFinite(distances[end])) return [current, ...requested];
  const result: OfficePoint[] = [];
  for (let id = end; id >= 0; id = parents[id]!) result.unshift(vertices[id]!);
  return result;
}
