/**
 * Points spread evenly over painted area, per CAD face: what the sidecar keeps so paint can
 * be moved onto a new revision of the model, whatever its tessellation. Pure.
 *
 * Every painted triangle (or painted piece of a cut one) is filled with a lattice about one
 * spacing apart; a grid then keeps one point per cell, so long thin triangles don't crowd. The
 * spacing grows until a marker fits in `max` points. Every painted face keeps at least one point.
 *
 * `clear` points lie on the same face just outside the paint (unpainted pieces of cut triangles,
 * unpainted triangles touching the paint), within two spacings of a painted point: they mark where
 * the paint ends, so a brush stroke keeps its outline when it is rebuilt (each spot takes the
 * paint state of its nearest point) instead of growing on every new version.
 */
import type { PieceTree } from '@third-wheel/core';
import type { StepModel } from './model.js';
import { at3, cross, len, sub, type V3 } from './vec.js';

export type SampleModel = Pick<StepModel, 'positions' | 'indices' | 'triangleFace'>;

/** A painted triangle: whole (`1`) or the painted pieces of a cut one. */
export interface PaintedTriangle {
  readonly t: number;
  readonly tree: PieceTree;
}

/** Points of one face: painted (`samples`) and just outside the paint (`clear`), flat x y z. */
export interface FaceSamples {
  readonly samples: number[];
  readonly clear: number[];
}

/** Most lattice steps along one triangle edge (keeps a huge triangle cheap). */
const MAX_STEPS = 48;
/** `clear` points are kept this many spacings from the nearest painted point at most. */
const CLEAR_BAND = 2;

interface Piece {
  readonly face: number;
  readonly a: V3;
  readonly b: V3;
  readonly c: V3;
}

/** Sample points per face id, at most `max` painted (and `max` clear) points in all. */
export function paintSamples(
  m: SampleModel,
  painted: readonly PaintedTriangle[],
  max: number,
): Map<number, FaceSamples> {
  const pieces: Piece[] = [];
  const clearPieces: Piece[] = [];
  let total = 0;
  const corners = (t: number): [V3, V3, V3] => [
    at3(m.positions, m.indices[t * 3] ?? 0),
    at3(m.positions, m.indices[t * 3 + 1] ?? 0),
    at3(m.positions, m.indices[t * 3 + 2] ?? 0),
  ];
  for (const { t, tree } of painted) {
    const face = m.triangleFace[t] ?? 0;
    const [a, b, c] = corners(t);
    leaves(tree, a, b, c, 1, (p, q, r) => {
      total += len(cross(sub(q, p), sub(r, p))) / 2;
      pieces.push({ face, a: p, b: q, c: r });
    });
    // The unpainted pieces of a cut triangle mark where the paint ends.
    if (tree !== 1)
      leaves(tree, a, b, c, 0, (p, q, r) => clearPieces.push({ face, a: p, b: q, c: r }));
  }
  const out = new Map<number, FaceSamples>();
  if (pieces.length === 0) return out;
  clearPieces.push(...touching(m, painted, corners));

  let spacing = Math.sqrt(Math.max(total, 1e-12) / Math.max(1, max));
  let byFace = spread(pieces, spacing);
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = countOf(byFace);
    if (count <= max) break;
    spacing *= Math.sqrt(count / max) * 1.05;
    byFace = spread(pieces, spacing);
  }
  const count = countOf(byFace);
  const keep = count <= max ? 1 : max / count;
  const clear = nearPaint(spread(clearPieces, spacing), byFace, spacing * CLEAR_BAND);
  const clearCount = countOf(clear);
  const keepClear = clearCount <= max ? 1 : max / clearCount;
  for (const [face, pts] of byFace)
    out.set(face, { samples: thin(pts, keep), clear: thin(clear.get(face) ?? [], keepClear, 0) });
  return out;
}

const countOf = (m: ReadonlyMap<number, readonly number[]>): number =>
  [...m.values()].reduce((s, p) => s + p.length / 3, 0);

/** Unpainted whole triangles of a painted face that share a corner with its paint. */
function touching(
  m: SampleModel,
  painted: readonly PaintedTriangle[],
  corners: (t: number) => [V3, V3, V3],
): Piece[] {
  const key = (p: V3): string => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
  const done = new Set(painted.map((p) => p.t));
  const near = new Map<number, Set<string>>(); // face → corner keys of its paint
  for (const { t } of painted) {
    const face = m.triangleFace[t] ?? 0;
    let set = near.get(face);
    if (!set) near.set(face, (set = new Set()));
    for (const p of corners(t)) set.add(key(p));
  }
  const out: Piece[] = [];
  for (let t = 0; t < m.triangleFace.length; t++) {
    const face = m.triangleFace[t] ?? 0;
    const set = near.get(face);
    if (!set || done.has(t)) continue;
    const [a, b, c] = corners(t);
    if (set.has(key(a)) || set.has(key(b)) || set.has(key(c))) out.push({ face, a, b, c });
  }
  return out;
}

/** Calls `visit` with the corners of every leaf equal to `want` (corner order as `PieceTree`). */
function leaves(
  tree: PieceTree,
  a: V3,
  b: V3,
  c: V3,
  want: 0 | 1,
  visit: (a: V3, b: V3, c: V3) => void,
): void {
  if (tree === 0 || tree === 1) {
    if (tree === want) visit(a, b, c);
    return;
  }
  const ab = half(a, b);
  const bc = half(b, c);
  const ca = half(c, a);
  leaves(tree[0], a, ab, ca, want, visit);
  leaves(tree[1], ab, b, bc, want, visit);
  leaves(tree[2], ca, bc, c, want, visit);
  leaves(tree[3], ab, bc, ca, want, visit);
}

const half = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

const cellKey = (p: V3, h: number): number =>
  (Math.floor(p[0] / h) * 73856093) ^
  (Math.floor(p[1] / h) * 19349663) ^
  (Math.floor(p[2] / h) * 83492791);

/** Lattice points per piece, one per grid cell of `spacing`, grouped by face. */
function spread(pieces: readonly Piece[], spacing: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const taken = new Map<number, Set<number>>();
  for (const { face, a, b, c } of pieces) {
    let pts = out.get(face);
    let cells = taken.get(face);
    if (!pts || !cells) {
      pts = [];
      cells = new Set();
      out.set(face, pts);
      taken.set(face, cells);
    }
    const longest = Math.max(len(sub(b, a)), len(sub(c, b)), len(sub(a, c)));
    const n = Math.min(MAX_STEPS, Math.max(1, Math.ceil(longest / spacing)));
    // Centres of the n² sub-triangles of an n-step lattice.
    for (let i = 0; i < n; i++)
      for (let j = 0; i + j < n; j++)
        for (const [u, v] of [
          [(i + 1 / 3) / n, (j + 1 / 3) / n],
          [(i + 2 / 3) / n, (j + 2 / 3) / n],
        ] as const) {
          if (u + v > 1) continue;
          const p: V3 = [
            a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v,
            a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v,
            a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v,
          ];
          // Hashed cell (a rare collision only drops a point).
          const key = cellKey(p, spacing);
          if (cells.has(key)) continue;
          cells.add(key);
          for (const x of p) pts.push(Math.round(x * 1000) / 1000);
        }
  }
  return out;
}

/** The `clear` points within `band` of a painted point of the same face. */
function nearPaint(
  clear: ReadonlyMap<number, number[]>,
  paint: ReadonlyMap<number, number[]>,
  band: number,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [face, pts] of clear) {
    const own = paint.get(face) ?? [];
    const grid = new Map<number, V3[]>();
    for (let i = 0; i + 2 < own.length; i += 3) {
      const p = at3(own, i / 3);
      const k = cellKey(p, band);
      const list = grid.get(k);
      if (list) list.push(p);
      else grid.set(k, [p]);
    }
    const kept: number[] = [];
    for (let i = 0; i + 2 < pts.length; i += 3) {
      const p = at3(pts, i / 3);
      if (anyWithin(grid, p, band)) kept.push(p[0], p[1], p[2]);
    }
    if (kept.length > 0) out.set(face, kept);
  }
  return out;
}

function anyWithin(grid: ReadonlyMap<number, V3[]>, p: V3, r: number): boolean {
  const base = [Math.floor(p[0] / r), Math.floor(p[1] / r), Math.floor(p[2] / r)] as const;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const k =
          ((base[0] + dx) * 73856093) ^ ((base[1] + dy) * 19349663) ^ ((base[2] + dz) * 83492791);
        for (const q of grid.get(k) ?? []) if (len(sub(p, q)) <= r) return true;
      }
  return false;
}

/** Every k-th point so about `share` of them stay; at least `least` (0 or 1). */
function thin(pts: readonly number[], share: number, least = 1): number[] {
  const n = pts.length / 3;
  if (share >= 1) return [...pts];
  const keep = Math.max(least, Math.floor(n * share));
  const step = n / Math.max(1, keep);
  const out: number[] = [];
  for (let k = 0; k < keep; k++) {
    const i = Math.floor(k * step) * 3;
    out.push(pts[i] ?? 0, pts[i + 1] ?? 0, pts[i + 2] ?? 0);
  }
  return out;
}
