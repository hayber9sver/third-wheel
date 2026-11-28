/**
 * Annotation transfer, building blocks: transforms (move / turn / mirror) and the new model per
 * body (its triangles, faces, edges and a grid to find the nearest surface fast).
 */
import { type V3, sub, len, at3, dot } from './vec.js';
import type { EntityFingerprint, BodyFingerprint } from '@third-wheel/core';
import type { EntityRef, InfoModel } from './entity-info.js';
import { entityFingerprints } from './fingerprint.js';
import {
  CHANGED_MM,
  CHANGED_SHARE,
  FOUND_MM,
  FOUND_SHARE,
  type TransferModel,
} from './transfer.js';

// --- Transforms --------------------------------------------------------------------------------

/** p ↦ r · (p − from) + to; `r` row-major 3 × 3 (a signed permutation). */
export interface Transform {
  readonly r: readonly number[];
  readonly from: V3;
  readonly to: V3;
}

export const IDENTITY: Transform = {
  r: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  from: [0, 0, 0],
  to: [0, 0, 0],
};

export const rot = (r: readonly number[], v: V3): V3 => [
  (r[0] ?? 0) * v[0] + (r[1] ?? 0) * v[1] + (r[2] ?? 0) * v[2],
  (r[3] ?? 0) * v[0] + (r[4] ?? 0) * v[1] + (r[5] ?? 0) * v[2],
  (r[6] ?? 0) * v[0] + (r[7] ?? 0) * v[1] + (r[8] ?? 0) * v[2],
];

export function apply(t: Transform, p: V3): V3 {
  const q = rot(t.r, sub(p, t.from));
  return [q[0] + t.to[0], q[1] + t.to[1], q[2] + t.to[2]];
}

/** A fingerprint moved by `t`; `body` = its body's index on the new model (none: left out). */
export function moveFp(
  fp: EntityFingerprint,
  t: Transform,
  body: number | undefined,
): EntityFingerprint {
  const out: EntityFingerprint = { ...fp };
  delete out.body;
  return {
    ...out,
    ...(body !== undefined ? { body } : {}),
    ...(fp.point ? { point: round3(apply(t, fp.point)) } : {}),
    ...(fp.dir ? { dir: round3(rot(t.r, fp.dir)) } : {}),
    ...(fp.bounds ? { bounds: moveBounds(fp.bounds, t) } : {}),
  };
}

/** A box moved by `t` (a signed permutation keeps it axis-aligned). */
export function moveBounds(
  [lo, hi]: readonly [V3, V3],
  t: Transform,
): [[number, number, number], [number, number, number]] {
  const a = apply(t, lo);
  const b = apply(t, hi);
  return [
    round3([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]),
    round3([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]),
  ];
}

/** How far apart two boxes' corners are (sum over both corners). */
export const boundsGap = (a: readonly [V3, V3], b: readonly [V3, V3]): number =>
  len(sub(a[0], b[0])) + len(sub(a[1], b[1]));

export const round3 = (p: V3): [number, number, number] => [
  Math.round(p[0] * 1e4) / 1e4,
  Math.round(p[1] * 1e4) / 1e4,
  Math.round(p[2] * 1e4) / 1e4,
];

/** The 48 signed permutation matrices (24 turns, 24 mirrors), with their determinant. */
export const SIGNED_PERMS: readonly { r: number[]; det: number }[] = (() => {
  const perms = [
    [0, 1, 2, 1],
    [0, 2, 1, -1],
    [1, 0, 2, -1],
    [1, 2, 0, 1],
    [2, 0, 1, 1],
    [2, 1, 0, -1],
  ];
  const out: { r: number[]; det: number }[] = [];
  for (const [p0, p1, p2, ps] of perms)
    for (let s = 0; s < 8; s++) {
      const signs = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
      const r = new Array<number>(9).fill(0);
      [p0, p1, p2].forEach((col, row) => {
        r[row * 3 + (col ?? 0)] = signs[row] ?? 1;
      });
      out.push({ r, det: (ps ?? 1) * (signs[0] ?? 1) * (signs[1] ?? 1) * (signs[2] ?? 1) });
    }
  return out;
})();

// --- The new model, per body -------------------------------------------------------------------

export interface Hit {
  readonly t: number;
  readonly face: number;
  readonly d: number;
  readonly q: V3;
}

export class Context {
  private readonly bodies = new Map<number, BodyData>();
  /** Triangles of each face, in order (counting sort over `triangleFace`). */
  readonly faceTriStart: Uint32Array;
  readonly faceTris: Uint32Array;

  constructor(
    readonly m: TransferModel,
    readonly fingerprints: readonly BodyFingerprint[],
  ) {
    const faces = m.faceBody.length;
    const count = new Uint32Array(faces + 1);
    for (let t = 0; t < m.triangleFace.length; t++) {
      const f = m.triangleFace[t] ?? 0;
      if (f < faces) count[f + 1] = (count[f + 1] ?? 0) + 1;
    }
    for (let f = 0; f < faces; f++) count[f + 1] = (count[f + 1] ?? 0) + (count[f] ?? 0);
    this.faceTriStart = count;
    this.faceTris = new Uint32Array(m.triangleFace.length);
    const at = count.slice();
    for (let t = 0; t < m.triangleFace.length; t++) {
      const f = m.triangleFace[t] ?? 0;
      if (f >= faces) continue;
      const i = at[f] ?? 0;
      this.faceTris[i] = t;
      at[f] = i + 1;
    }
  }

  trisOf(face: number): Uint32Array {
    return this.faceTris.subarray(this.faceTriStart[face] ?? 0, this.faceTriStart[face + 1] ?? 0);
  }

  /** Body `b` of the new model; -1 = the whole model (older sidecars, body unknown). */
  body(b: number): BodyData {
    let d = this.bodies.get(b);
    if (!d) this.bodies.set(b, (d = new BodyData(this, b)));
    return d;
  }
}

export class BodyData {
  readonly faces: number[] = [];
  readonly size: V3;
  readonly centre: V3;
  /** Largest bbox side: tolerances scale with it. */
  readonly extent: number;
  private grid: TriangleGrid | undefined;
  private readonly prints = new Map<string, Map<number, EntityFingerprint>>();

  constructor(
    readonly ctx: Context,
    readonly index: number,
  ) {
    const m = ctx.m;
    for (let f = 0; f < m.faceBody.length; f++)
      if (index < 0 || m.faceBody[f] === index) this.faces.push(f);
    const fp = ctx.fingerprints[index];
    if (fp) {
      this.size = fp.size;
      this.centre = fp.centre;
    } else {
      // The whole model (older sidecars): its bounding box.
      const lo: [number, number, number] = [Infinity, Infinity, Infinity];
      const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.positions.length; i++) {
        const k = i % 3;
        lo[k] = Math.min(lo[k] ?? 0, m.positions[i] ?? 0);
        hi[k] = Math.max(hi[k] ?? 0, m.positions[i] ?? 0);
      }
      const ok = lo.every(Number.isFinite);
      this.size = ok ? [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] : [0, 0, 0];
      this.centre = ok
        ? [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2]
        : [0, 0, 0];
    }
    this.extent = Math.max(...this.size, 0);
  }

  get tolFound(): number {
    return Math.max(FOUND_MM, FOUND_SHARE * this.extent);
  }
  get tolChanged(): number {
    return Math.max(CHANGED_MM, CHANGED_SHARE * this.extent);
  }

  /** Fingerprints of this body's entities of one kind (faces: one mesh pass for all). */
  printsOf(kind: 'face' | 'edge' | 'vertex'): Map<number, EntityFingerprint> {
    let map = this.prints.get(kind);
    if (map) return map;
    const m = this.ctx.m;
    let ids: number[];
    if (kind === 'face') ids = this.faces;
    else {
      const owner = kind === 'edge' ? m.edgeBody : m.vertexBody;
      ids = [];
      for (let i = 0; i < owner.length; i++)
        if (this.index < 0 || owner[i] === this.index) ids.push(i);
    }
    const refs: EntityRef[] = ids.map((id) => ({ kind, id }));
    const fps = entityFingerprints(m, refs);
    map = new Map(ids.map((id, i) => [id, fps[i] ?? {}]));
    this.prints.set(kind, map);
    return map;
  }

  /** Nearest point on this body's mesh within `maxD`, on faces `ok` allows. */
  nearest(p: V3, maxD: number, ok: (face: number) => boolean): Hit | undefined {
    this.grid ??= new TriangleGrid(
      this.ctx,
      this.faces,
      Math.max(this.tolChanged, this.extent / 96),
    );
    return this.grid.nearest(p, maxD, ok);
  }

  /** Distance from `p` to one face's mesh. */
  faceDistance(face: number, p: V3): number {
    let d = Infinity;
    for (const t of this.ctx.trisOf(face))
      d = Math.min(d, len(sub(p, closestOnTriangle(this.ctx.m, t, p))));
    return d;
  }
}

/** Uniform grid of triangles for nearest-surface queries. */
class TriangleGrid {
  private readonly cells = new Map<number, number[]>();

  constructor(
    private readonly ctx: Context,
    faces: readonly number[],
    private readonly h: number,
  ) {
    const m = ctx.m;
    for (const f of faces)
      for (const t of ctx.trisOf(f)) {
        const ps = [0, 1, 2].map((k) => at3(m.positions, m.indices[t * 3 + k] ?? 0));
        const lo = [0, 1, 2].map((i) => Math.floor(Math.min(...ps.map((q) => q[i] ?? 0)) / h));
        const hi = [0, 1, 2].map((i) => Math.floor(Math.max(...ps.map((q) => q[i] ?? 0)) / h));
        for (let x = lo[0] ?? 0; x <= (hi[0] ?? 0); x++)
          for (let y = lo[1] ?? 0; y <= (hi[1] ?? 0); y++)
            for (let z = lo[2] ?? 0; z <= (hi[2] ?? 0); z++) {
              const key = cellKey(x, y, z);
              const list = this.cells.get(key);
              if (list) list.push(t);
              else this.cells.set(key, [t]);
            }
      }
  }

  nearest(p: V3, maxD: number, ok: (face: number) => boolean): Hit | undefined {
    const m = this.ctx.m;
    const h = this.h;
    const lo = p.map((x) => Math.floor((x - maxD) / h));
    const hi = p.map((x) => Math.floor((x + maxD) / h));
    let best: Hit | undefined;
    const seen = new Set<number>();
    for (let x = lo[0] ?? 0; x <= (hi[0] ?? 0); x++)
      for (let y = lo[1] ?? 0; y <= (hi[1] ?? 0); y++)
        for (let z = lo[2] ?? 0; z <= (hi[2] ?? 0); z++)
          for (const t of this.cells.get(cellKey(x, y, z)) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            const face = m.triangleFace[t] ?? 0;
            if (!ok(face)) continue;
            const q = closestOnTriangle(m, t, p);
            const d = len(sub(p, q));
            if (d <= maxD && (!best || d < best.d)) best = { t, face, d, q };
          }
    return best;
  }
}

export const cellKey = (x: number, y: number, z: number): number =>
  ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;

/** Closest point on triangle `t` to `p` (Ericson, "Real-Time Collision Detection" 5.1.5). */
function closestOnTriangle(m: InfoModel, t: number, p: V3): V3 {
  const a = at3(m.positions, m.indices[t * 3] ?? 0);
  const b = at3(m.positions, m.indices[t * 3 + 1] ?? 0);
  const c = at3(m.positions, m.indices[t * 3 + 2] ?? 0);
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
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = va + vb + vc;
  if (denom === 0) return a;
  const v = vb / denom;
  const w = vc / denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

const along = (a: V3, d: V3, s: number): V3 => [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s];

export function polylineDistance(m: InfoModel, edge: number, p: V3): number {
  const first = m.edgeRanges[edge * 2] ?? 0;
  const count = m.edgeRanges[edge * 2 + 1] ?? 0;
  if (count === 1) return len(sub(p, at3(m.edgePoints, first)));
  let d = Infinity;
  for (let i = 0; i + 1 < count; i++) {
    const a = at3(m.edgePoints, first + i);
    const ab = sub(at3(m.edgePoints, first + i + 1), a);
    const l2 = dot(ab, ab);
    const s = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
    d = Math.min(d, len(sub(p, along(a, ab, s))));
  }
  return d;
}
