/**
 * Read-only facts about picked entities and measurements between two of them. Pure: works
 * on a {@link StepModel} only (exact values from `faceGeometry` / `edgeGeometry`, the rest from the
 * mesh). Numbers, not text — the info panel formats them, the AI payload will reuse them.
 * Lengths in mm (OpenCascade converts STEP units to mm), angles in degrees.
 */
import { EDGE_GEOMETRY_STRIDE, FACE_GEOMETRY_STRIDE, type StepModel } from './model.js';
import { add, at3, cross, dist, dot, isFiniteV3, len, scale, sub, unit, type V3 } from './vec.js';

export type EntityKind = 'vertex' | 'edge' | 'face' | 'body';
export interface EntityRef {
  readonly kind: EntityKind;
  readonly id: number;
}

/** What a model needs for the functions here (tests build small ones by hand). */
export type InfoModel = Pick<
  StepModel,
  | 'positions'
  | 'indices'
  | 'triangleFace'
  | 'faceBody'
  | 'faceTypes'
  | 'faceGeometry'
  | 'edgePoints'
  | 'edgeRanges'
  | 'edgeBody'
  | 'edgeTypes'
  | 'edgeGeometry'
  | 'vertexPositions'
  | 'vertexBody'
  | 'bodyNames'
  | 'bodyPaths'
>;

/** Fields are `undefined` when they do not apply to the entity (or could not be read). */
export interface EntityInfo {
  readonly kind: EntityKind;
  readonly id: number;
  readonly body: number;
  /** Surface / curve type (`plane`, `cylinder`, `line`, `circle`, …); none for vertices and bodies. */
  readonly type?: string | undefined;
  /** Vertex position. */
  readonly position?: V3 | undefined;
  /** Edge length (exact). */
  readonly length?: number | undefined;
  /** Circle / arc, cylinder, sphere radius; torus major radius. */
  readonly radius?: number | undefined;
  /** Torus minor (tube) radius. */
  readonly minorRadius?: number | undefined;
  /** Circle, sphere, torus centre. */
  readonly centre?: V3 | undefined;
  /** Circle (normal of its plane), cylinder, cone, torus axis. */
  readonly axis?: V3 | undefined;
  /** A point on the axis (circle / torus centre, cylinder axis point, cone apex). */
  readonly axisPoint?: V3 | undefined;
  /** Line edge direction (start → end) and start point. */
  readonly direction?: V3 | undefined;
  readonly start?: V3 | undefined;
  /** Arc angle in degrees (circles; 360 = full circle). */
  readonly arcAngle?: number | undefined;
  /** Plane face outward normal. */
  readonly normal?: V3 | undefined;
  /** A point on a plane face. */
  readonly planePoint?: V3 | undefined;
  /** Cone half-angle, degrees. */
  readonly halfAngle?: number | undefined;
  /** Cone apex. */
  readonly apex?: V3 | undefined;
  /** Cylinder / cone: `hole` (concave) or `shaft` (convex); sphere: `hollow` / `ball`. */
  readonly form?: 'hole' | 'shaft' | 'hollow' | 'ball' | undefined;
  /** Face / body surface area from the mesh (≈, within the tessellation tolerance). */
  readonly area?: number | undefined;
  /** Body: name, assembly path, counts, mesh bounding box. */
  readonly name?: string | undefined;
  readonly path?: string | undefined;
  readonly faceCount?: number | undefined;
  readonly edgeCount?: number | undefined;
  readonly bboxMin?: V3 | undefined;
  readonly bboxMax?: V3 | undefined;
}

const finite = (x: number | undefined): number | undefined =>
  x !== undefined && Number.isFinite(x) ? x : undefined;
const vecOrUndef = (v: V3): V3 | undefined => (isFiniteV3(v) ? v : undefined);
const deg = (rad: number): number => (rad * 180) / Math.PI;

function faceRecord(m: InfoModel, id: number): number[] {
  return Array.from(
    m.faceGeometry.subarray(id * FACE_GEOMETRY_STRIDE, (id + 1) * FACE_GEOMETRY_STRIDE),
  );
}
function edgeRecord(m: InfoModel, id: number): number[] {
  return Array.from(
    m.edgeGeometry.subarray(id * EDGE_GEOMETRY_STRIDE, (id + 1) * EDGE_GEOMETRY_STRIDE),
  );
}
const dirOf = (r: number[]): V3 => [r[0] ?? NaN, r[1] ?? NaN, r[2] ?? NaN];
const pointOf = (r: number[]): V3 => [r[3] ?? NaN, r[4] ?? NaN, r[5] ?? NaN];

function triangleArea(m: InfoModel, t: number): number {
  const a = at3(m.positions, m.indices[t * 3] ?? 0);
  const b = at3(m.positions, m.indices[t * 3 + 1] ?? 0);
  const c = at3(m.positions, m.indices[t * 3 + 2] ?? 0);
  return len(cross(sub(b, a), sub(c, a))) / 2;
}

/** Mesh area per face for the given faces, in one pass over the triangles. */
export function faceAreas(m: InfoModel, faces: Iterable<number>): Map<number, number> {
  const areas = new Map<number, number>();
  for (const f of faces) areas.set(f, 0);
  if (areas.size === 0) return areas;
  for (let t = 0; t < m.triangleFace.length; t++) {
    const f = m.triangleFace[t] ?? -1;
    const sum = areas.get(f);
    if (sum !== undefined) areas.set(f, sum + triangleArea(m, t));
  }
  return areas;
}

function bodyStats(m: InfoModel, body: number) {
  let area = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < m.triangleFace.length; t++) {
    if (m.faceBody[m.triangleFace[t] ?? 0] !== body) continue;
    area += triangleArea(m, t);
    for (let k = 0; k < 3; k++) {
      const p = at3(m.positions, m.indices[t * 3 + k] ?? 0);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i] ?? 0, p[i] ?? 0);
        max[i] = Math.max(max[i] ?? 0, p[i] ?? 0);
      }
    }
  }
  const count = (arr: Uint32Array): number => arr.reduce((n, b) => (b === body ? n + 1 : n), 0);
  return {
    area,
    faceCount: count(m.faceBody),
    edgeCount: count(m.edgeBody),
    bboxMin: vecOrUndef(min as unknown as V3),
    bboxMax: vecOrUndef(max as unknown as V3),
  };
}

/**
 * Facts about one entity. Face area needs a pass over the mesh: pass `areas` (from
 * {@link faceAreas}) to share one pass between many faces, or an empty map to skip area (hover).
 */
export function entityInfo(
  m: InfoModel,
  ref: EntityRef,
  areas?: ReadonlyMap<number, number>,
): EntityInfo {
  const { kind, id } = ref;
  if (kind === 'vertex') {
    return { kind, id, body: m.vertexBody[id] ?? -1, position: at3(m.vertexPositions, id) };
  }
  if (kind === 'edge') {
    const r = edgeRecord(m, id);
    const type = m.edgeTypes[id] ?? 'other';
    const base = { kind, id, body: m.edgeBody[id] ?? -1, type, length: finite(r[6]) };
    if (type === 'line')
      return { ...base, direction: vecOrUndef(dirOf(r)), start: vecOrUndef(pointOf(r)) };
    if (type === 'circle') {
      const centre = vecOrUndef(pointOf(r));
      return {
        ...base,
        radius: finite(r[7]),
        centre,
        axis: vecOrUndef(dirOf(r)),
        axisPoint: centre,
        arcAngle: finite(r[8]) !== undefined ? deg(r[8] ?? 0) : undefined,
      };
    }
    return base;
  }
  if (kind === 'face') {
    const r = faceRecord(m, id);
    const type = m.faceTypes[id] ?? 'other';
    const area = (areas ?? faceAreas(m, [id])).get(id);
    const base = { kind, id, body: m.faceBody[id] ?? -1, type, area };
    const sign = r[7];
    switch (type) {
      case 'plane':
        return { ...base, normal: vecOrUndef(dirOf(r)), planePoint: vecOrUndef(pointOf(r)) };
      case 'cylinder':
        return {
          ...base,
          radius: finite(r[6]),
          axis: vecOrUndef(dirOf(r)),
          axisPoint: vecOrUndef(pointOf(r)),
          form: sign === -1 ? 'hole' : sign === 1 ? 'shaft' : undefined,
        };
      case 'cone': {
        const apex = vecOrUndef(pointOf(r));
        return {
          ...base,
          halfAngle: finite(r[6]) !== undefined ? deg(r[6] ?? 0) : undefined,
          axis: vecOrUndef(dirOf(r)),
          axisPoint: apex,
          apex,
          form: sign === -1 ? 'hole' : sign === 1 ? 'shaft' : undefined,
        };
      }
      case 'sphere':
        return {
          ...base,
          radius: finite(r[6]),
          centre: vecOrUndef(pointOf(r)),
          form: sign === -1 ? 'hollow' : sign === 1 ? 'ball' : undefined,
        };
      case 'torus': {
        const centre = vecOrUndef(pointOf(r));
        return {
          ...base,
          radius: finite(r[6]),
          minorRadius: finite(r[7]),
          centre,
          axis: vecOrUndef(dirOf(r)),
          axisPoint: centre,
        };
      }
      default:
        return base;
    }
  }
  return {
    kind,
    id,
    body: id,
    name: m.bodyNames[id],
    path: m.bodyPaths[id] || undefined,
    ...bodyStats(m, id),
  };
}

// --- Measuring two entities ---------------------------------------------------------------

export interface Measurement {
  /**
   * Shortest distance between the two entities, from the mesh / edge polylines; `exact` only when
   * both are vertices or straight edges. Missing when skipped: see `distanceSkipped`.
   */
  readonly distance?: { readonly value: number; readonly exact: boolean };
  /** Why `distance` is missing: too many triangles to compare, or a pick has no mesh / polyline. */
  readonly distanceSkipped?: 'too-large' | 'no-geometry';
  /** Between the two points (vertices, circle / sphere / torus centres), and its XYZ components. */
  readonly centreDistance?: number;
  readonly delta?: V3;
  /** Between two parallel axes (holes, shafts, circles, straight edges), or a point and an axis. */
  readonly axisDistance?: number;
  /** Perpendicular distance from a plane to a point, a parallel plane or a parallel axis. */
  readonly planeDistance?: number;
  /** Angle between straight edges / axes / plane normals, 0–90°. */
  readonly angle?: number;
  /**
   * What `angle` compares: two lines (straight edges / axes), two planes, or a straight edge / an
   * axis (hole, shaft, circle) against a plane — a hole square to its face reads 90° there.
   */
  readonly angleBetween?: 'lines' | 'planes' | 'edge-plane' | 'axis-plane';
}

/** Above this many primitive pairs the mesh distance is skipped (it is brute force). */
export const MAX_DISTANCE_PAIRS = 200_000;
/** Directions closer than this (degrees) count as parallel. */
const PARALLEL_DEG = 0.01;

interface Line {
  readonly p: V3;
  readonly d: V3;
}

function pointOfInfo(i: EntityInfo): V3 | undefined {
  return i.position ?? i.centre;
}
function lineOfInfo(i: EntityInfo): Line | undefined {
  if (i.direction && i.start) return { p: i.start, d: i.direction };
  return i.axis && i.axisPoint ? { p: i.axisPoint, d: i.axis } : undefined;
}
function planeOfInfo(i: EntityInfo): Line | undefined {
  return i.normal && i.planePoint ? { p: i.planePoint, d: i.normal } : undefined;
}

/** Acute angle between two directions, degrees. */
function acuteAngle(a: V3, b: V3): number {
  const c = Math.min(1, Math.abs(dot(unit(a), unit(b))));
  return deg(Math.acos(c));
}
function pointLineDistance(p: V3, l: Line): number {
  return len(cross(sub(p, l.p), unit(l.d)));
}
function pointPlaneDistance(p: V3, pl: Line): number {
  return Math.abs(dot(sub(p, pl.p), unit(pl.d)));
}

/** Measure between two entities. */
export function measure(m: InfoModel, a: EntityRef, b: EntityRef): Measurement {
  const areas = faceAreas(
    m,
    [a, b].flatMap((r) => (r.kind === 'face' ? [r.id] : [])),
  );
  const ia = entityInfo(m, a, areas);
  const ib = entityInfo(m, b, areas);
  const out: { -readonly [K in keyof Measurement]: Measurement[K] } = {};

  const md = meshDistance(m, a, b);
  if (md) out.distance = md;
  else
    out.distanceSkipped =
      countPrims(m, a) === 0 || countPrims(m, b) === 0 ? 'no-geometry' : 'too-large';

  const pa = pointOfInfo(ia);
  const pb = pointOfInfo(ib);
  if (pa && pb) {
    out.centreDistance = dist(pa, pb);
    out.delta = sub(pb, pa);
  }

  const la = lineOfInfo(ia);
  const lb = lineOfInfo(ib);
  const qa = planeOfInfo(ia);
  const qb = planeOfInfo(ib);
  const dirA = la?.d ?? qa?.d;
  const dirB = lb?.d ?? qb?.d;
  if (dirA && dirB) {
    const raw = acuteAngle(dirA, dirB);
    // Line vs plane: the angle to the plane is 90° minus the angle to its normal.
    const line = la && qb ? ia : qa && lb ? ib : undefined;
    out.angle = line ? 90 - raw : raw;
    out.angleBetween = line
      ? line.direction
        ? 'edge-plane'
        : 'axis-plane'
      : qa && qb
        ? 'planes'
        : 'lines';
  }

  if (la && lb) {
    if (acuteAngle(la.d, lb.d) < PARALLEL_DEG) out.axisDistance = pointLineDistance(lb.p, la);
  } else if (la && pb) {
    out.axisDistance = pointLineDistance(pb, la);
  } else if (lb && pa) {
    out.axisDistance = pointLineDistance(pa, lb);
  }

  if (qa && qb) {
    if (acuteAngle(qa.d, qb.d) < PARALLEL_DEG) out.planeDistance = pointPlaneDistance(qb.p, qa);
  }
  const plane = qa ?? qb;
  if (plane && !(qa && qb)) {
    const line = qa ? lb : la;
    const point = qa ? pb : pa;
    // An axis parallel to the plane: its distance; else a centre (circle, sphere, vertex): its height.
    if (line && 90 - acuteAngle(line.d, plane.d) < PARALLEL_DEG) {
      out.planeDistance = pointPlaneDistance(line.p, plane);
    } else if (point) {
      out.planeDistance = pointPlaneDistance(point, plane);
    }
  }
  return out;
}

// --- Shortest distance on the mesh ---------------------------------------------------------

/** Points, segments and triangles of one entity, as flat XYZ arrays. */
interface Prims {
  points: V3[];
  segments: [V3, V3][];
  triangles: [V3, V3, V3][];
}

function primsOf(m: InfoModel, ref: EntityRef): Prims {
  const p: Prims = { points: [], segments: [], triangles: [] };
  if (ref.kind === 'vertex') {
    p.points.push(at3(m.vertexPositions, ref.id));
  } else if (ref.kind === 'edge') {
    const first = m.edgeRanges[ref.id * 2] ?? 0;
    const count = m.edgeRanges[ref.id * 2 + 1] ?? 0;
    for (let i = 0; i + 1 < count; i++)
      p.segments.push([at3(m.edgePoints, first + i), at3(m.edgePoints, first + i + 1)]);
    if (count === 1) p.points.push(at3(m.edgePoints, first));
  } else {
    const keep =
      ref.kind === 'face' ? (f: number) => f === ref.id : (f: number) => m.faceBody[f] === ref.id;
    for (let t = 0; t < m.triangleFace.length; t++) {
      if (!keep(m.triangleFace[t] ?? -1)) continue;
      p.triangles.push([
        at3(m.positions, m.indices[t * 3] ?? 0),
        at3(m.positions, m.indices[t * 3 + 1] ?? 0),
        at3(m.positions, m.indices[t * 3 + 2] ?? 0),
      ]);
    }
  }
  return p;
}

function countPrims(m: InfoModel, ref: EntityRef): number {
  if (ref.kind === 'vertex') return 1;
  if (ref.kind === 'edge') {
    const points = m.edgeRanges[ref.id * 2 + 1] ?? 0;
    return points <= 1 ? points : points - 1; // segments (a lone point counts as one)
  }
  let n = 0;
  for (let t = 0; t < m.triangleFace.length; t++) {
    const f = m.triangleFace[t] ?? -1;
    if (ref.kind === 'face' ? f === ref.id : m.faceBody[f] === ref.id) n++;
  }
  return n;
}

/** Shortest distance on the mesh, or undefined when there is nothing to compare / too much work. */
export function meshDistance(
  m: InfoModel,
  a: EntityRef,
  b: EntityRef,
): { value: number; exact: boolean } | undefined {
  const c = meshClosest(m, a, b);
  return c && { value: c.value, exact: c.exact };
}

/**
 * Shortest distance on the mesh with the two points where it is reached (`from` on `a`, `to` on
 * `b`); undefined when there is nothing to compare or too much work.
 */
export function meshClosest(
  m: InfoModel,
  a: EntityRef,
  b: EntityRef,
): { value: number; exact: boolean; from: V3; to: V3 } | undefined {
  // Count first: two large bodies would otherwise build millions of triangles for nothing.
  const na = countPrims(m, a);
  const nb = countPrims(m, b);
  if (na === 0 || nb === 0 || na * nb > MAX_DISTANCE_PAIRS) return undefined;
  const pa = primsOf(m, a);
  const pb = primsOf(m, b);
  const exactKind = (r: EntityRef): boolean =>
    r.kind === 'vertex' || (r.kind === 'edge' && m.edgeTypes[r.id] === 'line');
  let best = Infinity;
  let from: V3 = [NaN, NaN, NaN];
  let to: V3 = [NaN, NaN, NaN];
  const consider = (p: V3, q: V3, swap: boolean): void => {
    const d = dist(p, q);
    if (d >= best) return;
    best = d;
    from = swap ? q : p;
    to = swap ? p : q;
  };
  // Every pair of primitives; each pair's minimum is at a vertex of one against the other, or
  // between two edges (segments / triangle sides).
  const vertsOf = (p: Prims): V3[] => [...p.points, ...p.segments.flat(), ...p.triangles.flat()];
  const sidesOf = (p: Prims): [V3, V3][] => [
    ...p.segments,
    ...p.triangles.flatMap(([x, y, z]): [V3, V3][] => [
      [x, y],
      [y, z],
      [z, x],
    ]),
  ];
  const against = (verts: V3[], other: Prims, swap: boolean): void => {
    for (const v of verts) {
      for (const q of other.points) consider(v, q, swap);
      for (const [s0, s1] of other.segments) consider(v, closestOnSegment(v, s0, s1), swap);
      for (const [t0, t1, t2] of other.triangles)
        consider(v, closestOnTriangle(v, t0, t1, t2), swap);
    }
  };
  against(vertsOf(pa), pb, false);
  against(vertsOf(pb), pa, true);
  const sa = sidesOf(pa);
  const sb = sidesOf(pb);
  for (const [a0, a1] of sa)
    for (const [b0, b1] of sb) {
      const [p, q] = segmentSegment(a0, a1, b0, b1);
      consider(p, q, false);
    }
  return { value: best, exact: exactKind(a) && exactKind(b), from, to };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

function closestOnSegment(p: V3, a: V3, b: V3): V3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? clamp01(dot(sub(p, a), ab) / l2) : 0;
  return add(a, scale(ab, t));
}

/** Closest points of segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9). */
function segmentSegment(p1: V3, q1: V3, p2: V3, q2: V3): [V3, V3] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-18 && e <= 1e-18) return [p1, p2];
  if (a <= 1e-18) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-18) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-18 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
}

/** Closest point on triangle abc to p (Ericson 5.1.5). */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
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
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}
