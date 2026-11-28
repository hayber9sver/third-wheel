/**
 * 3D comment pins, pure part: which comments get a pin (`pinSpecs`) and where it may sit
 * (`pinSpots` — per CAD face / edge piece / vertex of the comment's geometry, the point nearest
 * the centre of its bounding box, so a pin lies on the surface, not in the air). The DOM overlay
 * that draws the pins and picks the visible spot is `pin-overlay.ts`.
 */
import { needsAttention, type Comment } from './comments.js';
import type { Vec3 } from './camera-views.js';
import { highlightSphere, type HighlightBuffers } from './highlight-buffers.js';

/** What a pin shows; the viewport adds the anchor. */
export interface PinSpec {
  readonly id: string;
  /** Same number as the comment's card (list position). */
  readonly number: number;
  /** Live markers of the comment (pins without any are not made). */
  readonly markerIds: readonly string[];
  readonly closed: boolean;
  readonly ai: boolean;
  readonly focused: boolean;
  /** Tooltip: "#n · first line of the text". */
  readonly title: string;
}

/**
 * Pins for `comments` (list order, numbered by position like the cards). A comment gets a pin
 * when it has a live marker, at least one of them is visible (hidden markers hide the pin)
 * and it is open or `showClosed` is on (like the cards). The focused comment always gets one: its
 * hidden markers are shown while it is highlighted.
 */
export function pinSpecs(
  comments: readonly Comment[],
  markerVisible: (id: string) => boolean | undefined,
  showClosed: boolean,
  focusedId: string | undefined,
): PinSpec[] {
  const out: PinSpec[] = [];
  comments.forEach((c, i) => {
    const markerIds = c.markerIds.filter((id) => markerVisible(id) !== undefined);
    if (markerIds.length === 0) return;
    const focused = c.id === focusedId;
    const closed = !needsAttention(c); // the AI's unconfirmed close still asks for a look
    if (!focused && closed && !showClosed) return;
    if (!focused && !markerIds.some((id) => markerVisible(id) === true)) return;
    const firstLine = c.text.split('\n')[0] ?? '';
    out.push({
      id: c.id,
      number: i + 1,
      markerIds,
      closed,
      ai: c.author === 'ai',
      focused,
      title: `#${String(i + 1)} · ${firstLine}`,
    });
  });
  return out;
}

/** Most spots a pin may hop between (nearest the centre first). */
export const MAX_PIN_SPOTS = 48;
/**
 * Most extra spots spread over the triangles: one spot per face can sit
 * on the hidden side of a curved face (a ring seen from the side) while the rest of it is visible.
 */
export const MAX_SPREAD_SPOTS = 192;

/**
 * Spots a pin may sit on: for each B-rep face among the triangles
 * (`vertexFace` = face per vertex index), each edge segment and each vertex point, the point
 * nearest the centre of their bounding box — sorted by that distance, at most `max`. The first is
 * the preferred spot; the viewport moves the pin to the first one it can see after a camera move.
 * After those come up to `spread` triangle centres taken evenly over all triangles (also nearest
 * the centre first), so a pin finds a visible spot even when every face's nearest point is hidden.
 * Empty when the buffers are.
 */
export function pinSpots(
  buffers: HighlightBuffers,
  positions: Float32Array,
  vertexFace: ArrayLike<number>,
  max = MAX_PIN_SPOTS,
  spread = MAX_SPREAD_SPOTS,
): Vec3[] {
  const sphere = highlightSphere(buffers, positions);
  if (!sphere) return [];
  const c = sphere.center;
  const byFace = new Map<number, { p: Vec3; d: number }>();
  const other: { p: Vec3; d: number }[] = [];
  const { indices, edgeSegments, points } = buffers;
  const at = (arr: Float32Array, i: number): Vec3 => [
    arr[i * 3] ?? 0,
    arr[i * 3 + 1] ?? 0,
    arr[i * 3 + 2] ?? 0,
  ];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const v = indices[i] ?? 0;
    const p = closestOnTriangle(
      c,
      at(positions, v),
      at(positions, indices[i + 1] ?? 0),
      at(positions, indices[i + 2] ?? 0),
    );
    const d = dist2(p, c);
    const face = vertexFace[v] ?? 0;
    const best = byFace.get(face);
    if (!best || d < best.d) byFace.set(face, { p, d });
  }
  const spreadSpots: { p: Vec3; d: number }[] = [];
  const triangles = Math.floor(indices.length / 3);
  if (spread > 0 && triangles > 0) {
    const step = Math.max(1, Math.ceil(triangles / spread));
    for (let t = 0; t < triangles; t += step) {
      const a = at(positions, indices[t * 3] ?? 0);
      const b = at(positions, indices[t * 3 + 1] ?? 0);
      const d3 = at(positions, indices[t * 3 + 2] ?? 0);
      const p: Vec3 = [
        (a[0] + b[0] + d3[0]) / 3,
        (a[1] + b[1] + d3[1]) / 3,
        (a[2] + b[2] + d3[2]) / 3,
      ];
      spreadSpots.push({ p, d: dist2(p, c) });
    }
  }
  for (let i = 0; i + 1 < edgeSegments.length / 3; i += 2) {
    const p = closestOnSegment(c, at(edgeSegments, i), at(edgeSegments, i + 1));
    other.push({ p, d: dist2(p, c) });
  }
  for (let i = 0; i < points.length / 3; i++) {
    const p = at(points, i);
    other.push({ p, d: dist2(p, c) });
  }
  const byDistance = (a: { d: number }, b: { d: number }): number => a.d - b.d;
  return [
    ...[...byFace.values(), ...other].sort(byDistance).slice(0, max),
    ...spreadSpots.sort(byDistance).slice(0, spread),
  ].map((s) => s.p);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function dist2(a: Vec3, b: Vec3): number {
  const d = sub(a, b);
  return dot(d, d);
}
/** a + s·u + t·v */
function along(a: Vec3, u: Vec3, s: number, v: Vec3 = [0, 0, 0], t = 0): Vec3 {
  return [a[0] + s * u[0] + t * v[0], a[1] + s * u[1] + t * v[1], a[2] + s * u[2] + t * v[2]];
}

export function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 === 0) return a;
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2));
  return along(a, ab, t);
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = va + vb + vc;
  if (denom === 0) return a; // degenerate triangle
  return along(a, ab, vb / denom, ac, vc / denom);
}
