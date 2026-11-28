/**
 * The one dimension drawn in the view for one or two entities: which value is the main one
 * and the two points its line runs between. Nothing is stored; the app works this out for the
 * current selection or the highlighted comment.
 *
 * One entity: a straight edge's length, a circle's Ø (an arc's R), a cylinder's or sphere's Ø
 * (R when only part of it is there, like a fillet or a dimple). Two entities, first that applies:
 * perpendicular distance to a plane (parallel faces, a hole and a face) → distance between
 * parallel axes / an axis and a point → angle when they touch → shortest distance → centre to
 * centre. Values are the ones `entityInfo` / `measure` give (Info shows the same numbers).
 */
import {
  entityInfo,
  meshClosest,
  type EntityInfo,
  type EntityRef,
  type InfoModel,
  type Measurement,
} from './entity-info.js';
import {
  add,
  at3,
  cross,
  dist,
  dot,
  isFiniteV3,
  len,
  mid,
  scale,
  sub,
  unit,
  type V3,
} from './vec.js';

export type DimensionKind = 'length' | 'diameter' | 'radius' | 'distance' | 'angle';

export interface Dimension {
  readonly kind: DimensionKind;
  /** mm, or degrees for an angle. */
  readonly value: number;
  /** False when the value is estimated from the mesh (shown with "≈"). */
  readonly exact: boolean;
  /** The line's ends; equal for an angle (the label sits where the two meet). */
  readonly from: V3;
  readonly to: V3;
}

/** Below this (mm) two things touch / an axis passes through a point. */
const TOUCH = 1e-4;
/** A cylinder / circle that covers at least this much of a full turn reads as Ø, else R. */
const FULL_TURN_DEG = 300;

/** Triangle corner positions of one face. */
function faceCorners(m: InfoModel, face: number): V3[] {
  const out: V3[] = [];
  for (let t = 0; t < m.triangleFace.length; t++) {
    if (m.triangleFace[t] !== face) continue;
    for (let k = 0; k < 3; k++) out.push(at3(m.positions, m.indices[t * 3 + k] ?? 0));
  }
  return out;
}

/** Area-weighted centre of a face's triangles. */
function faceCentre(m: InfoModel, face: number): V3 | undefined {
  let sum: V3 = [0, 0, 0];
  let area = 0;
  for (let t = 0; t < m.triangleFace.length; t++) {
    if (m.triangleFace[t] !== face) continue;
    const a = at3(m.positions, m.indices[t * 3] ?? 0);
    const b = at3(m.positions, m.indices[t * 3 + 1] ?? 0);
    const c = at3(m.positions, m.indices[t * 3 + 2] ?? 0);
    const w = len(cross(sub(b, a), sub(c, a))) / 2;
    sum = add(sum, scale(add(add(a, b), c), w / 3));
    area += w;
  }
  return area > 0 ? scale(sum, 1 / area) : undefined;
}

/** Polyline points of one edge. */
function edgePolyline(m: InfoModel, edge: number): V3[] {
  const first = m.edgeRanges[edge * 2] ?? 0;
  const count = m.edgeRanges[edge * 2 + 1] ?? 0;
  const out: V3[] = [];
  for (let i = 0; i < count; i++) out.push(at3(m.edgePoints, first + i));
  return out;
}

/** Foot of `p` on the line through `o` along `d`. */
function footOnLine(p: V3, o: V3, d: V3): V3 {
  const u = unit(d);
  return add(o, scale(u, dot(sub(p, o), u)));
}
/** Foot of `p` on the plane through `o` with normal `n`. */
function footOnPlane(p: V3, o: V3, n: V3): V3 {
  const u = unit(n);
  return sub(p, scale(u, dot(sub(p, o), u)));
}

/** Degrees of a full turn around the axis that `points` cover (360 minus the largest gap). */
function turnCovered(points: readonly V3[], o: V3, axis: V3): number {
  const z = unit(axis);
  const helper: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = unit(cross(z, helper));
  const y = cross(z, x);
  const angles: number[] = [];
  for (const p of points) {
    const v = sub(p, o);
    const a = Math.atan2(dot(v, y), dot(v, x));
    if (Number.isFinite(a)) angles.push((a * 180) / Math.PI);
  }
  if (angles.length < 2) return 0;
  angles.sort((a, b) => a - b);
  let gap = 360 - ((angles[angles.length - 1] ?? 0) - (angles[0] ?? 0));
  for (let i = 1; i < angles.length; i++)
    gap = Math.max(gap, (angles[i] ?? 0) - (angles[i - 1] ?? 0));
  return 360 - gap;
}

/** Ø across the axis through `centre`, or R from it, towards `towards` (a point on the shape). */
function roundDimension(
  centre: V3,
  axis: V3 | undefined,
  radius: number,
  towards: V3,
  full: boolean,
): Dimension | undefined {
  let v = sub(towards, centre);
  if (axis) v = sub(v, scale(unit(axis), dot(v, unit(axis))));
  const u = unit(v);
  if (!isFiniteV3(u)) return undefined;
  const rim = add(centre, scale(u, radius));
  return full
    ? {
        kind: 'diameter',
        value: radius * 2,
        exact: true,
        from: sub(centre, scale(u, radius)),
        to: rim,
      }
    : { kind: 'radius', value: radius, exact: true, from: centre, to: rim };
}

/** The dimension of one entity, or undefined when it has no single size worth drawing. */
export function entityDimension(m: InfoModel, ref: EntityRef): Dimension | undefined {
  if (ref.kind === 'vertex' || ref.kind === 'body') return undefined;
  const info = entityInfo(m, ref, new Map());
  if (ref.kind === 'edge') {
    if (info.type === 'line' && info.start && info.direction && info.length !== undefined) {
      const to = add(info.start, scale(unit(info.direction), info.length));
      return { kind: 'length', value: info.length, exact: true, from: info.start, to };
    }
    if (info.type === 'circle' && info.centre && info.radius !== undefined) {
      const pts = edgePolyline(m, ref.id);
      const full = (info.arcAngle ?? 360) >= FULL_TURN_DEG;
      const towards = full ? pts[0] : pts[Math.floor(pts.length / 2)];
      return towards && roundDimension(info.centre, info.axis, info.radius, towards, full);
    }
    return undefined;
  }
  if (info.radius === undefined) return undefined;
  if (info.type === 'cylinder' && info.axis && info.axisPoint) {
    const corners = faceCorners(m, ref.id);
    const c = faceCentre(m, ref.id);
    if (!c || corners.length === 0) return undefined;
    const onAxis = footOnLine(c, info.axisPoint, info.axis);
    const full = turnCovered(corners, info.axisPoint, info.axis) >= FULL_TURN_DEG;
    if (full) {
      // A hole / shaft: Ø across its opening (axis end), not halfway inside the part.
      const end = anchorOf(m, ref, info) ?? onAxis;
      return corners[0] && roundDimension(end, info.axis, info.radius, corners[0], true);
    }
    // A partial round (fillet): R from the axis towards the middle of the face.
    const towards = dist(c, onAxis) > info.radius * 0.05 ? c : corners[0];
    return towards && roundDimension(onAxis, info.axis, info.radius, towards, false);
  }
  if (info.type === 'sphere' && info.centre) {
    const c = faceCentre(m, ref.id);
    const corners = faceCorners(m, ref.id);
    const area = info.area ?? entityInfo(m, ref).area ?? 0;
    const full = area >= 0.9 * 4 * Math.PI * info.radius ** 2;
    const towards = c && dist(c, info.centre) > info.radius * 0.05 ? c : corners[0];
    return towards && roundDimension(info.centre, undefined, info.radius, towards, full);
  }
  return undefined;
}

/** A point standing for an entity: vertex, centre, middle of a straight edge, end of a face's axis, face centre. */
function anchorOf(m: InfoModel, ref: EntityRef, info: EntityInfo): V3 | undefined {
  if (info.position) return info.position;
  if (info.centre) return info.centre;
  if (info.start && info.direction && info.length !== undefined)
    return add(info.start, scale(unit(info.direction), info.length / 2));
  if (ref.kind === 'face') {
    if (info.axis && info.axisPoint) {
      // A hole / shaft: the end of its axis (on the opening), not halfway inside the part.
      const u = unit(info.axis);
      let top = -Infinity;
      for (const p of faceCorners(m, ref.id)) top = Math.max(top, dot(sub(p, info.axisPoint), u));
      return Number.isFinite(top) ? add(info.axisPoint, scale(u, top)) : undefined;
    }
    return faceCentre(m, ref.id);
  }
  return undefined;
}

/**
 * The dimension between two entities, from their measurement `r` (pass the one Info shows, with
 * any exact values swapped in), or undefined when none applies.
 */
export function pairDimension(
  m: InfoModel,
  a: EntityRef,
  b: EntityRef,
  r: Measurement,
): Dimension | undefined {
  const ia = entityInfo(m, a, new Map());
  const ib = entityInfo(m, b, new Map());
  const pa = anchorOf(m, a, ia);
  const pb = anchorOf(m, b, ib);
  const planeA = ia.normal && ia.planePoint ? { o: ia.planePoint, n: ia.normal } : undefined;
  const planeB = ib.normal && ib.planePoint ? { o: ib.planePoint, n: ib.normal } : undefined;
  const lineOf = (i: EntityInfo) =>
    i.direction && i.start
      ? { o: i.start, d: i.direction }
      : i.axis && i.axisPoint
        ? { o: i.axisPoint, d: i.axis }
        : undefined;
  const lineA = lineOf(ia);
  const lineB = lineOf(ib);
  const ok = (d: Dimension): Dimension | undefined =>
    isFiniteV3(d.from) && isFiniteV3(d.to) ? d : undefined;

  if (r.planeDistance !== undefined && r.planeDistance > TOUCH) {
    if (planeA && planeB && pa && pb) {
      const c = mid(pa, pb);
      return ok({
        kind: 'distance',
        value: r.planeDistance,
        exact: true,
        from: footOnPlane(c, planeA.o, planeA.n),
        to: footOnPlane(c, planeB.o, planeB.n),
      });
    }
    const plane = planeA ?? planeB;
    const other = planeA ? pb : pa;
    if (plane && other) {
      const foot = footOnPlane(other, plane.o, plane.n);
      return ok({
        kind: 'distance',
        value: r.planeDistance,
        exact: true,
        from: planeA ? foot : other,
        to: planeA ? other : foot,
      });
    }
  }
  if (r.axisDistance !== undefined && r.axisDistance > TOUCH) {
    // Parallel axes, or an axis and a point: from the other's anchor to its foot on the axis.
    if (lineA && lineB && pa) {
      return ok({
        kind: 'distance',
        value: r.axisDistance,
        exact: true,
        from: pa,
        to: footOnLine(pa, lineB.o, lineB.d),
      });
    }
    if (lineA && pb) {
      return ok({
        kind: 'distance',
        value: r.axisDistance,
        exact: true,
        from: footOnLine(pb, lineA.o, lineA.d),
        to: pb,
      });
    }
    if (lineB && pa) {
      return ok({
        kind: 'distance',
        value: r.axisDistance,
        exact: true,
        from: pa,
        to: footOnLine(pa, lineB.o, lineB.d),
      });
    }
  }
  const closest = meshClosest(m, a, b);
  const gap = r.distance ?? (closest && { value: closest.value, exact: closest.exact });
  if (r.angle !== undefined && closest && gap && gap.value <= TOUCH && r.angle > 0.01) {
    return ok({ kind: 'angle', value: r.angle, exact: true, from: closest.from, to: closest.from });
  }
  if (gap && closest && gap.value > TOUCH) {
    return ok({
      kind: 'distance',
      value: gap.value,
      exact: gap.exact,
      from: closest.from,
      to: closest.to,
    });
  }
  if (r.centreDistance !== undefined && r.centreDistance > TOUCH && pa && pb) {
    return ok({ kind: 'distance', value: r.centreDistance, exact: true, from: pa, to: pb });
  }
  return undefined;
}
