/**
 * Fingerprints saved in the sidecar: what each body and each held entity looked like, so a
 * new revision of the model can match them by geometry after the ids changed. Pure: works on
 * a {@link StepModel} only. Rounded to 0.1 µm / 1e-4 (keeps files short, far below any tolerance).
 */
import {
  MAX_BODY_NAME_LENGTH as MAX_NAME,
  type BodyFingerprint,
  type EntityFingerprint,
} from '@third-wheel/core';
import { entityInfo, type EntityRef, type InfoModel } from './entity-info.js';
import { compact, round, roundV } from './round.js';
import { at3, cross, len, sub, type V3 } from './vec.js';

const D = 4;

/** Area, area-weighted centre and bbox per body, in one pass over the mesh. */
export function bodyFingerprints(m: InfoModel, bodyCount: number): BodyFingerprint[] {
  const area = new Float64Array(bodyCount);
  const sum = new Float64Array(bodyCount * 3);
  const min = new Float64Array(bodyCount * 3).fill(Infinity);
  const max = new Float64Array(bodyCount * 3).fill(-Infinity);
  for (let t = 0; t < m.triangleFace.length; t++) {
    const b = m.faceBody[m.triangleFace[t] ?? 0] ?? -1;
    if (b < 0 || b >= bodyCount) continue;
    const p = [0, 1, 2].map((k) => at3(m.positions, m.indices[t * 3 + k] ?? 0));
    const [p0, p1, p2] = p as [V3, V3, V3];
    const a = len(cross(sub(p1, p0), sub(p2, p0))) / 2;
    area[b] = (area[b] ?? 0) + a;
    for (let i = 0; i < 3; i++) {
      for (const q of p) {
        min[b * 3 + i] = Math.min(min[b * 3 + i] ?? 0, q[i] ?? 0);
        max[b * 3 + i] = Math.max(max[b * 3 + i] ?? 0, q[i] ?? 0);
      }
      sum[b * 3 + i] =
        (sum[b * 3 + i] ?? 0) + (a * ((p0[i] ?? 0) + (p1[i] ?? 0) + (p2[i] ?? 0))) / 3;
    }
  }
  return Array.from({ length: bodyCount }, (_, b) => {
    const lo = at3(min, b);
    const hi = at3(max, b);
    const empty = !lo.every(Number.isFinite);
    const name = (m.bodyNames[b] ?? `Body ${String(b + 1)}`).slice(0, MAX_NAME);
    const path = m.bodyPaths[b]?.slice(0, MAX_NAME);
    return {
      name,
      ...(path ? { path } : {}),
      size: empty ? [0, 0, 0] : (roundV(sub(hi, lo), D) ?? [0, 0, 0]),
      centre: empty
        ? [0, 0, 0]
        : (roundV([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], D) ?? [0, 0, 0]),
      area: round(area[b], D) ?? 0,
    };
  });
}

/** Mesh area and area-weighted centre of the given faces, in one pass. */
export function faceCentres(
  m: InfoModel,
  faces: Iterable<number>,
): Map<number, { area: number; centre: V3; lo: V3; hi: V3 }> {
  const acc = new Map<number, number[]>();
  for (const f of faces)
    acc.set(f, [0, 0, 0, 0, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  if (acc.size > 0) {
    for (let t = 0; t < m.triangleFace.length; t++) {
      const s = acc.get(m.triangleFace[t] ?? -1);
      if (!s) continue;
      const a0 = at3(m.positions, m.indices[t * 3] ?? 0);
      const a1 = at3(m.positions, m.indices[t * 3 + 1] ?? 0);
      const a2 = at3(m.positions, m.indices[t * 3 + 2] ?? 0);
      const a = len(cross(sub(a1, a0), sub(a2, a0))) / 2;
      s[0] = (s[0] ?? 0) + a;
      s[1] = (s[1] ?? 0) + (a * (a0[0] + a1[0] + a2[0])) / 3;
      s[2] = (s[2] ?? 0) + (a * (a0[1] + a1[1] + a2[1])) / 3;
      s[3] = (s[3] ?? 0) + (a * (a0[2] + a1[2] + a2[2])) / 3;
      for (const p of [a0, a1, a2])
        for (let i = 0; i < 3; i++) {
          s[4 + i] = Math.min(s[4 + i] ?? Infinity, p[i] ?? 0);
          s[7 + i] = Math.max(s[7 + i] ?? -Infinity, p[i] ?? 0);
        }
    }
  }
  return new Map(
    [...acc].map(([f, s]) => {
      const a = s[0] ?? 0;
      const v = (i: number): number => s[i] ?? NaN;
      return [
        f,
        {
          area: a,
          centre: a > 0 ? [v(1) / a, v(2) / a, v(3) / a] : [NaN, NaN, NaN],
          lo: [v(4), v(5), v(6)],
          hi: [v(7), v(8), v(9)],
        },
      ];
    }),
  );
}

/** Point halfway along an edge's polyline. */
export function edgeMidpoint(m: InfoModel, edge: number): V3 | undefined {
  const first = m.edgeRanges[edge * 2] ?? 0;
  const count = m.edgeRanges[edge * 2 + 1] ?? 0;
  if (count === 0) return undefined;
  if (count === 1) return at3(m.edgePoints, first);
  let total = 0;
  for (let i = 0; i + 1 < count; i++)
    total += len(sub(at3(m.edgePoints, first + i + 1), at3(m.edgePoints, first + i)));
  let half = total / 2;
  for (let i = 0; i + 1 < count; i++) {
    const a = at3(m.edgePoints, first + i);
    const b = at3(m.edgePoints, first + i + 1);
    const l = len(sub(b, a));
    if (half <= l || i + 2 === count) {
      const s = l > 0 ? Math.min(1, half / l) : 0;
      return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
    }
    half -= l;
  }
  return undefined;
}

/**
 * Fingerprints of several entities (one mesh pass for all faces). Body entities point at their
 * body fingerprint (`body`) and repeat only its size, area and centre.
 */
export function entityFingerprints(
  m: InfoModel,
  refs: readonly EntityRef[],
  bodies?: readonly BodyFingerprint[],
): EntityFingerprint[] {
  const faces = faceCentres(
    m,
    refs.flatMap((r) => (r.kind === 'face' ? [r.id] : [])),
  );
  const areas = new Map([...faces].map(([f, v]) => [f, v.area]));
  return refs.map((ref) => {
    if (ref.kind === 'body') {
      const b = bodies?.[ref.id];
      return compact({
        body: ref.id,
        point: b?.centre,
        size: b?.size,
        area: b?.area,
      });
    }
    const i = entityInfo(m, ref, areas);
    const face = ref.kind === 'face' ? faces.get(ref.id) : undefined;
    const lo = face && face.area > 0 ? roundV(face.lo, D) : undefined;
    const hi = face && face.area > 0 ? roundV(face.hi, D) : undefined;
    const point =
      ref.kind === 'vertex'
        ? i.position
        : ref.kind === 'edge'
          ? edgeMidpoint(m, ref.id)
          : faces.get(ref.id)?.centre;
    return compact({
      body: i.body >= 0 ? i.body : undefined,
      type: i.type,
      point: roundV(point, D),
      length: round(i.length, D),
      area: round(i.area, D),
      radius: round(i.radius, D),
      minorRadius: round(i.minorRadius, D),
      dir: roundV(i.normal ?? i.direction ?? i.axis, D),
      halfAngle: round(i.halfAngle, D),
      form: i.form,
      bounds:
        lo && hi ? ([lo, hi] as [[number, number, number], [number, number, number]]) : undefined,
    });
  });
}
