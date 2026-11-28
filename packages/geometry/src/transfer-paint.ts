/**
 * Annotation transfer, paint: each old face's samples onto the nearest new surface of the same
 * type and direction; the new triangles near the landed points are painted. Rules: `transfer.ts`.
 */
import type { EntityFingerprint, PaintPieces, PieceTree } from '@third-wheel/core';
import { type V3, sub, len, at3 } from './vec.js';
import { type Alignment, candidates, dirOk, every, followBox, sameSize } from './transfer-match.js';
import { apply, BodyData, cellKey, type Hit, rot } from './transfer-model.js';
import type { EntityItem, PaintGroup } from './transfer.js';

// --- Paint -------------------------------------------------------------------------------------

/** Faces a paint group may land on: same type and direction as the painted face. */
export function faceFilter(
  a: Alignment,
  fp: EntityFingerprint | undefined,
): (face: number) => boolean {
  if (!fp?.type) return () => true;
  const dir = fp.dir && rot(a.t.r, fp.dir);
  const prints = a.body.printsOf('face');
  return (f) => {
    const n = prints.get(f);
    return n !== undefined && n.type === fp.type && dirOk(fp.type, dir, n.dir);
  };
}

/** Paint of one face group moved onto the new model: whole triangles and cut ones per face. */
type MovedPaint = Map<number, { whole: number[]; pieces: PaintPieces[] }>;
type Root = PaintPieces['tree'];

export function movePaint(
  g: PaintGroup,
  a: Alignment,
): { status: 'found' | 'changed'; faces: MovedPaint } | undefined {
  const ok = faceFilter(a, g.fp);
  const body = a.body;
  let moved = g.samples.map((p) => apply(a.t, p));
  let clear = g.clear.map((p) => apply(a.t, p));
  const land = (pts: readonly V3[], maxD: number, on = ok): Hit[] =>
    pts.flatMap((p) => {
      const h = body.nearest(p, maxD, on);
      return h ? [h] : [];
    });
  const n = moved.length;
  let hits = land(moved, body.tolChanged);
  let status: 'found' | 'changed';
  let reach = body.tolChanged;
  if (n > 0 && hits.filter((h) => h.d <= body.tolFound).length >= 0.8 * n) status = 'found';
  else if (n > 0 && hits.length >= 0.5 * n) status = 'changed';
  else {
    const shift = shiftPaint(g, a, moved);
    if (!shift) return undefined;
    const by = (ps: readonly V3[]): V3[] =>
      ps.map((p) => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]);
    moved = by(moved);
    clear = by(clear);
    reach = body.tolFound * 2;
    hits = land(moved, reach);
    if (hits.length < 0.5 * n) return undefined;
    status = 'changed';
  }
  // Only faces that took a fair share (a rib's side under a few samples takes nothing).
  const perFace = new Map<number, number>();
  for (const h of hits) perFace.set(h.face, (perFace.get(h.face) ?? 0) + 1);
  const keep = new Set([...perFace].filter(([, c]) => c >= 0.1 * hits.length).map(([f]) => f));
  const pos = hits.filter((h) => keep.has(h.face)).map((h) => h.q);
  const neg = land(clear, reach, (f) => keep.has(f)).map((h) => h.q);
  return { status, faces: rebuildPaint(body, keep, pos, neg, spacing(g.samples)) };
}

/** How far the group's samples move when its face shifted as a whole (see `matchEntity`). */
function shiftPaint(g: PaintGroup, a: Alignment, moved: readonly V3[]): V3 | undefined {
  const centre = g.fp?.point ? apply(a.t, g.fp.point) : mean(moved);
  const box = followBox(a, centre);
  if (box) return box;
  if (!g.fp?.point) return undefined;
  const e: EntityItem = { kind: 'face', seq: 0, fp: g.fp, body: g.body, ghost: false };
  const alike = candidates(e, a, undefined, Infinity).filter(
    (c) => g.fp && sameSize(g.fp, c.fp, true),
  );
  const only = alike.length === 1 ? alike[0] : undefined;
  if (!only?.fp.point) return undefined;
  return sub(only.fp.point, centre);
}

const mean = (ps: readonly V3[]): V3 => {
  const s = [0, 0, 0];
  for (const p of ps) for (let i = 0; i < 3; i++) s[i] = (s[i] ?? 0) + (p[i] ?? 0) / ps.length;
  return [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0];
};

/** Typical distance between neighbouring samples (median nearest neighbour). */
export function spacing(samples: readonly V3[]): number {
  if (samples.length < 2) return 1;
  const pts = every(samples, 400);
  const d = pts
    .map((p, i) => {
      let best = Infinity;
      pts.forEach((q, j) => {
        if (j !== i) best = Math.min(best, len(sub(p, q)));
      });
      return best;
    })
    .sort((x, y) => x - y);
  // Thinned samples (every k-th) are further apart than the real ones: the median still fits.
  return d[Math.floor(d.length / 2)] ?? 1;
}

/** Deepest cut when rebuilding paint (the brush allows 14; pieces stay ≥ half a spacing). */
const MAX_REBUILD_DEPTH = 12;
/** Nearest points that vote on a spot's paint. */
const VOTES = 5;

/**
 * Paint on faces `keep` from landed painted points `pos` and landed clear points `neg` (where the
 * paint ended): each spot takes the state most of its 5 nearest points (within 2 spacings) have, so an outline
 * comes back where it was instead of growing. Triangles are cut into pieces (as the brush does)
 * down to half a spacing, only where the paint's edge runs through them.
 */
export function rebuildPaint(
  body: BodyData,
  keep: ReadonlySet<number>,
  pos: readonly V3[],
  neg: readonly V3[],
  gap: number,
): MovedPaint {
  const r = Math.max(gap * 2, 1e-3);
  const minEdge = Math.max(gap / 2, 1e-4);
  const grid = new Map<number, { p: V3; on: boolean }[]>();
  const add = (p: V3, on: boolean): void => {
    const k = cellKey(Math.floor(p[0] / r), Math.floor(p[1] / r), Math.floor(p[2] / r));
    const list = grid.get(k);
    if (list) list.push({ p, on });
    else grid.set(k, [{ p, on }]);
  };
  for (const p of pos) add(p, true);
  for (const p of neg) add(p, false);
  const all = [...pos.map((p) => ({ p, on: true })), ...neg.map((p) => ({ p, on: false }))];
  type Pt = { p: V3; on: boolean };
  const box = (a: V3, b: V3, c: V3): { lo: V3; hi: V3 } => ({
    lo: [
      Math.min(a[0], b[0], c[0]) - r,
      Math.min(a[1], b[1], c[1]) - r,
      Math.min(a[2], b[2], c[2]) - r,
    ],
    hi: [
      Math.max(a[0], b[0], c[0]) + r,
      Math.max(a[1], b[1], c[1]) + r,
      Math.max(a[2], b[2], c[2]) + r,
    ],
  });
  const inside = (q: V3, bx: { lo: V3; hi: V3 }): boolean =>
    q[0] >= bx.lo[0] &&
    q[0] <= bx.hi[0] &&
    q[1] >= bx.lo[1] &&
    q[1] <= bx.hi[1] &&
    q[2] >= bx.lo[2] &&
    q[2] <= bx.hi[2];
  /** Points within `r` of the box around a triangle: from the grid for small ones, else all. */
  const fetch = (a: V3, b: V3, c: V3): Pt[] => {
    const bx = box(a, b, c);
    const lo = bx.lo.map((x) => Math.floor(x / r));
    const hi = bx.hi.map((x) => Math.floor(x / r));
    const cells =
      ((hi[0] ?? 0) - (lo[0] ?? 0) + 1) *
      ((hi[1] ?? 0) - (lo[1] ?? 0) + 1) *
      ((hi[2] ?? 0) - (lo[2] ?? 0) + 1);
    if (cells > all.length) return all.filter((q) => inside(q.p, bx));
    const out: Pt[] = [];
    const seen = new Set<number>();
    for (let x = lo[0] ?? 0; x <= (hi[0] ?? 0); x++)
      for (let y = lo[1] ?? 0; y <= (hi[1] ?? 0); y++)
        for (let z = lo[2] ?? 0; z <= (hi[2] ?? 0); z++) {
          const k = cellKey(x, y, z);
          if (seen.has(k)) continue;
          seen.add(k);
          for (const q of grid.get(k) ?? []) if (inside(q.p, bx)) out.push(q);
        }
    return out;
  };
  /**
   * Painted at `p`: most of its nearest points (up to {@link VOTES}, within r) are painted ones —
   * a majority, so a stray speck doesn't come back larger on every version.
   */
  const stateAt = (p: V3, near: readonly Pt[]): boolean => {
    const ds: number[] = [];
    const on: boolean[] = [];
    const r2 = r * r;
    for (const q of near) {
      const dx = q.p[0] - p[0];
      const dy = q.p[1] - p[1];
      const dz = q.p[2] - p[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) continue;
      // Keep the VOTES nearest, sorted.
      let k = ds.length;
      if (k === VOTES && d >= (ds[k - 1] ?? Infinity)) continue;
      if (k === VOTES) {
        ds.pop();
        on.pop();
        k--;
      }
      while (k > 0 && (ds[k - 1] ?? 0) > d) k--;
      ds.splice(k, 0, d);
      on.splice(k, 0, q.on);
    }
    const yes = on.filter(Boolean).length;
    return yes * 2 === on.length ? (on[0] ?? false) : yes * 2 > on.length;
  };
  const classify = (a: V3, b: V3, c: V3, depth: number, from: readonly Pt[]): PieceTree => {
    let near = from;
    if (depth > 0) {
      const lx = Math.min(a[0], b[0], c[0]) - r;
      const ly = Math.min(a[1], b[1], c[1]) - r;
      const lz = Math.min(a[2], b[2], c[2]) - r;
      const hx = Math.max(a[0], b[0], c[0]) + r;
      const hy = Math.max(a[1], b[1], c[1]) + r;
      const hz = Math.max(a[2], b[2], c[2]) + r;
      const kept: Pt[] = [];
      for (const q of from) {
        const [x, y, z] = q.p;
        if (x >= lx && x <= hx && y >= ly && y <= hy && z >= lz && z <= hz) kept.push(q);
      }
      near = kept;
    }
    const cen: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    // The whole piece is on one side when, for every point in it, the nearest painted point is
    // clearly nearer (and within r) than any clear point — or the other way round.
    const rho = Math.max(len(sub(a, cen)), len(sub(b, cen)), len(sub(c, cen)));
    let dPos = Infinity;
    let dNeg = Infinity;
    for (const q of near) {
      const dx = q.p[0] - cen[0];
      const dy = q.p[1] - cen[1];
      const dz = q.p[2] - cen[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (q.on) {
        if (d < dPos) dPos = d;
      } else if (d < dNeg) dNeg = d;
    }
    if (dPos === Infinity) return 0;
    dPos = Math.sqrt(dPos);
    dNeg = Math.sqrt(dNeg);
    // Uniform when every point of the piece has a painted point within r and no clear one (or
    // the other way round): then all its votes agree.
    if (dPos + rho <= r && dNeg - rho > r) return 1;
    if (dPos - rho > r) return 0;
    const longest = Math.max(len(sub(b, a)), len(sub(c, b)), len(sub(a, c)));
    if (depth >= MAX_REBUILD_DEPTH || longest <= minEdge) return stateAt(cen, near) ? 1 : 0;
    const ab = halfway(a, b);
    const bc = halfway(b, c);
    const ca = halfway(c, a);
    const kids: [PieceTree, PieceTree, PieceTree, PieceTree] = [
      classify(a, ab, ca, depth + 1, near),
      classify(ab, b, bc, depth + 1, near),
      classify(ca, bc, c, depth + 1, near),
      classify(ab, bc, ca, depth + 1, near),
    ];
    if (kids.every((k) => k === 0)) return 0;
    if (kids.every((k) => k === 1)) return 1;
    return kids;
  };
  const m = body.ctx.m;
  const out: MovedPaint = new Map();
  for (const f of keep) {
    const whole: number[] = [];
    const pieces: PaintPieces[] = [];
    for (const t of body.ctx.trisOf(f)) {
      const a = at3(m.positions, m.indices[t * 3] ?? 0);
      const b = at3(m.positions, m.indices[t * 3 + 1] ?? 0);
      const c = at3(m.positions, m.indices[t * 3 + 2] ?? 0);
      const tree = classify(a, b, c, 0, fetch(a, b, c));
      if (tree === 1) whole.push(t);
      else if (tree !== 0) pieces.push({ triangle: t, tree: [...tree] as Root });
    }
    if (whole.length + pieces.length > 0) out.set(f, { whole, pieces });
  }
  return out;
}

const halfway = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
