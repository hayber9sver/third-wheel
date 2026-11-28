/**
 * Annotation transfer, matching: old bodies to new ones, lining a body's markers up with the new
 * body (kept, moved, turned, mirrored), and held entities to new ones. Rules: `transfer.ts`.
 */
import type { BodyFingerprint, BodyTreeData, EntityFingerprint } from '@third-wheel/core';
import { len, sub, type V3, dot } from './vec.js';
import {
  apply,
  BodyData,
  boundsGap,
  IDENTITY,
  moveBounds,
  polylineDistance,
  rot,
  SIGNED_PERMS,
  type Transform,
} from './transfer-model.js';
import {
  COS_DIR,
  type EntityItem,
  type PaintGroup,
  PROBE_SAMPLES,
  SIZE_SHARE,
} from './transfer.js';
import { faceFilter } from './transfer-paint.js';

// --- Bodies ------------------------------------------------------------------------------------

/** Old body index → new body index (name, then size, then nearest). */
export function matchBodies(
  old: readonly BodyFingerprint[] | undefined,
  now: readonly BodyFingerprint[],
): Map<number, number> {
  const map = new Map<number, number>();
  // No fingerprints (older sidecar): same index when the count fits.
  if (!old) {
    for (let b = 0; b < now.length; b++) map.set(b, b);
    return map;
  }
  const used = new Set<number>();
  const free = (pred: (n: BodyFingerprint) => boolean): number[] =>
    now.flatMap((n, j) => (!used.has(j) && pred(n) ? [j] : []));
  const nearest = (o: BodyFingerprint, js: readonly number[]): number | undefined => {
    let best: number | undefined;
    let bestD = Infinity;
    for (const j of js) {
      const n = now[j];
      if (!n) continue;
      const d = len(sub(n.centre, o.centre));
      if (d < bestD) [best, bestD] = [j, d];
    }
    return best;
  };
  // Names first for every body (so a renamed body can't take another's place by size).
  const pending: number[] = [];
  old.forEach((o, i) => {
    const named = free((n) => n.name === o.name && (n.path ?? '') === (o.path ?? ''));
    const named2 = named.length > 0 ? named : free((n) => n.name === o.name);
    const pick =
      named2.length <= 1
        ? named2[0]
        : nearest(o, sameSize(o, named2).length ? sameSize(o, named2) : named2);
    if (pick === undefined) pending.push(i);
    else {
      map.set(i, pick);
      used.add(pick);
    }
  });
  for (const i of pending) {
    const o = old[i];
    if (!o) continue;
    const pick = nearest(
      o,
      sameSize(
        o,
        free(() => true),
      ),
    );
    if (pick === undefined) continue;
    map.set(i, pick);
    used.add(pick);
  }
  return map;

  function sameSize(o: BodyFingerprint, js: readonly number[]): number[] {
    const os = [...o.size].sort((a, b) => a - b);
    return js.filter((j) => {
      const n = now[j];
      if (!n) return false;
      const ns = [...n.size].sort((a, b) => a - b);
      return close(n.area, o.area) && ns.every((x, k) => close(x, os[k] ?? 0));
    });
  }
}

const close = (a: number, b: number, share = SIZE_SHARE, abs = 0.01): boolean =>
  Math.abs(a - b) <= Math.max(abs, share * Math.max(Math.abs(a), Math.abs(b)));

export function remapBodyTree(
  tree: BodyTreeData | undefined,
  map: ReadonlyMap<number, number>,
  bodyCount: number,
): BodyTreeData | undefined {
  if (!tree) return undefined;
  const identity = [...map].every(([a, b]) => a === b) && map.size === bodyCount;
  return {
    folders: tree.folders,
    bodies: tree.bodies.flatMap((r) => {
      const b = map.get(r.body);
      return b === undefined ? [] : [{ ...r, body: b }];
    }),
    // Assemblies have no fingerprints: kept only while every body kept its place.
    assemblies: identity ? tree.assemblies : [],
  };
}

// --- Lining a body up --------------------------------------------------------------------------

export interface Alignment {
  readonly body: BodyData;
  readonly t: Transform;
  /** The new body is a mirror image of the old one: its markers are "check". */
  readonly mirrored: boolean;
  /** Old body's bounding box moved by `t` (for "moved with a side of the box"). */
  readonly oldBox: { lo: V3; hi: V3 } | undefined;
}

export function align(
  body: BodyData,
  oldFp: BodyFingerprint | undefined,
  markers: readonly { groups: PaintGroup[]; entities: EntityItem[] }[],
  oldBody: number,
): Alignment {
  const make = (t: Transform, mirrored: boolean): Alignment => ({
    body,
    t,
    mirrored,
    oldBox: oldFp && boxOf(oldFp, t),
  });
  if (!oldFp) return make(IDENTITY, false);
  const groups = markers.flatMap((mk) => mk.groups.filter((g) => g.body === oldBody));
  const entities = markers.flatMap((mk) => mk.entities.filter((e) => e.body === oldBody));
  const tol = body.tolFound;
  const fit = (t: Transform): number => {
    const a = make(t, false);
    let n = 0;
    for (const g of groups)
      for (const p of every(g.samples, PROBE_SAMPLES)) {
        const hit = body.nearest(apply(t, p), tol, faceFilter(a, g.fp));
        if (hit) n++;
      }
    for (const e of entities) {
      if (e.kind === 'body' || !e.fp) continue;
      const best = candidates(e, a)[0];
      if (best && best.d <= tol) n++;
    }
    return n;
  };
  const tolSize = (a: number, b: number): boolean =>
    Math.abs(a - b) <= Math.max(tol, SIZE_SHARE * Math.max(a, b));
  const sizeFits = (r: readonly number[]): boolean =>
    rot(r, oldFp.size)
      .map(Math.abs)
      .every((s, i) => tolSize(s, body.size[i] ?? 0));
  // On equal fit (few marks, e.g. one stroke on a flat top fits a turned part both ways): the
  // candidate whose box lands on the new box wins, then turns before mirrors (a mirror image of a
  // symmetric part is the same part: a mirrored file has to fit better, not just land its faces'
  // centres closer — a face the new version changed moves its centre, and on a part whose two
  // sides are near mirror images the other side's centre can land closer), then keeping it in
  // place.
  const inPlace = sizeFits(IDENTITY.r) && len(sub(oldFp.centre, body.centre)) <= body.tolChanged;
  /**
   * How far each marked face's and entity's centre lands from the nearest alike new one: tells
   * turns apart that put every sample on the surface (a stroke on a flat top fits several), as a
   * face's centre moves with its holes and cut-outs.
   */
  const dists = (t: Transform): number[] => {
    const a = make(t, false);
    const ds: number[] = [];
    const probe = (item: EntityItem): void => {
      if (!item.fp?.point || item.kind === 'body') return;
      ds.push(
        Math.min(
          candidates(item, a, undefined, body.tolChanged)[0]?.d ?? body.tolChanged,
          body.tolChanged,
        ),
      );
    };
    // Painted faces: centre to the nearest alike face's centre (a plane's centre, not its surface).
    const faces = body.printsOf('face');
    for (const g of groups) {
      const fp = g.fp;
      if (!fp?.point) continue;
      const p = apply(t, fp.point);
      const dir = fp.dir && rot(t.r, fp.dir);
      let d = body.tolChanged;
      for (const n of faces.values())
        if (n.point && n.type === fp.type && dirOk(fp.type, dir, n.dir))
          d = Math.min(d, len(sub(n.point, p)));
      ds.push(d);
    }
    for (const it of entities) probe(it);
    return ds;
  };
  /**
   * How far the marked faces' outline boxes land from the nearest alike new face's box (summed):
   * robust to a rib or hole inside the face, unlike its centre.
   */
  const boundsErr = (t: Transform): number => {
    const faces = body.printsOf('face');
    let e = 0;
    const faceFps = [
      ...groups.map((g) => g.fp),
      ...entities.filter((it) => it.kind === 'face').map((it) => it.fp),
    ];
    for (const fp of faceFps) {
      if (!fp?.bounds) continue;
      const moved = moveBounds(fp.bounds, t);
      const dir = fp.dir && rot(t.r, fp.dir);
      let d = body.tolChanged;
      for (const n of faces.values())
        if (n.bounds && n.type === fp.type && dirOk(fp.type, dir, n.dir))
          d = Math.min(d, boundsGap(moved, n.bounds));
      e += d;
    }
    return e;
  };
  // Centres are exact mesh numbers: a few hundredths of a mm tell a hole's side apart (last resort:
  // a rib or cut-out added inside the face shifts its centre too).
  const errTol = Math.max(0.02, 1e-4 * body.extent);
  const scoreOf = (t: Transform, box: boolean, det: number) => {
    const ds = dists(t);
    return {
      t,
      score: fit(t),
      bounds: boundsErr(t),
      // How many marks land exactly, then how far they are off in all: one face the new version
      // changed (a cut-out removed) must not let another turn win that lands nothing exactly.
      exact: ds.filter((d) => d <= errTol).length,
      err: ds.reduce((sum, d) => sum + d, 0),
      box,
      det,
    };
  };
  let best = scoreOf(IDENTITY, inPlace, 1);
  const better = (c: typeof best): boolean =>
    c.score !== best.score
      ? c.score > best.score
      : Math.abs(c.bounds - best.bounds) > tol
        ? c.bounds < best.bounds
        : c.box !== best.box
          ? c.box
          : c.det !== best.det
            ? c.det > best.det
            : c.exact !== best.exact
              ? c.exact > best.exact
              : Math.abs(c.err - best.err) > errTol
                ? c.err < best.err
                : false;
  for (const { r, det } of SIGNED_PERMS) {
    if (!sizeFits(r)) continue;
    const t: Transform = { r, from: oldFp.centre, to: body.centre };
    const c = scoreOf(t, true, det);
    if (better(c)) best = c;
  }
  return make(best.t, best.det < 0);
}

function boxOf(fp: BodyFingerprint, t: Transform): { lo: V3; hi: V3 } {
  const c = apply(t, fp.centre);
  const s = rot(t.r, fp.size);
  const h = (i: 0 | 1 | 2): number => Math.abs(s[i]) / 2;
  return {
    lo: [c[0] - h(0), c[1] - h(1), c[2] - h(2)],
    hi: [c[0] + h(0), c[1] + h(1), c[2] + h(2)],
  };
}

/** Up to `n` items spread over the list. */
export function every<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const step = list.length / n;
  return Array.from({ length: n }, (_, k) => list[Math.floor(k * step)] as T);
}

/** The old point moved with whichever sides of the body's box it lay on (zero if none moved). */
export function followBox(a: Alignment, p: V3): V3 | undefined {
  const box = a.oldBox;
  if (!box) return undefined;
  const tol = a.body.tolFound;
  const { centre, size } = a.body;
  const shift: [number, number, number] = [0, 0, 0];
  for (const i of [0, 1, 2] as const) {
    const lo = centre[i] - size[i] / 2;
    const hi = centre[i] + size[i] / 2;
    if (Math.abs(p[i] - box.hi[i]) <= tol) shift[i] = hi - box.hi[i];
    else if (Math.abs(p[i] - box.lo[i]) <= tol) shift[i] = lo - box.lo[i];
  }
  return shift.every((s) => Math.abs(s) <= tol) ? undefined : shift;
}

// --- Entities ----------------------------------------------------------------------------------

/** Same-type entities of the body with the right direction, nearest first (within "changed"). */
export function candidates(
  e: EntityItem,
  a: Alignment,
  at?: V3,
  maxD = a.body.tolChanged,
): { id: number; d: number; fp: EntityFingerprint }[] {
  const fp = e.fp;
  if (!fp?.point || e.kind === 'body') return [];
  const p = at ?? apply(a.t, fp.point);
  const dir = fp.dir && rot(a.t.r, fp.dir);
  const m = a.body.ctx.m;
  const out: { id: number; d: number; fp: EntityFingerprint }[] = [];
  for (const [id, nfp] of a.body.printsOf(e.kind)) {
    if (e.kind !== 'vertex' && nfp.type !== fp.type) continue;
    if (!dirOk(fp.type, dir, nfp.dir)) continue;
    let d: number;
    if (!nfp.point) continue;
    // Quick reject by the centre / midpoint before the exact distance.
    if (e.kind === 'face' && fp.type === 'plane') {
      d = a.body.faceDistance(id, p);
    } else if (e.kind === 'edge') {
      d = polylineDistance(m, id, p);
    } else d = len(sub(nfp.point, p));
    if (d <= maxD) out.push({ id, d, fp: nfp });
  }
  return out.sort((x, y) => x.d - y.d);
}

export function dirOk(
  type: string | undefined,
  a: V3 | undefined,
  b: readonly number[] | undefined,
): boolean {
  if (!a || !b) return true;
  const c =
    dot(a, [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0]) /
    (len(a) * Math.hypot(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0) || 1);
  // A plane's normal keeps its side; an axis or line may point either way.
  return type === 'plane' ? c >= COS_DIR : Math.abs(c) >= COS_DIR;
}

export function sameSize(a: EntityFingerprint, b: EntityFingerprint, strict = false): boolean {
  const eq = (x: number | undefined, y: number | undefined, abs: number, share: number): boolean =>
    x === undefined || y === undefined || Math.abs(x - y) <= Math.max(abs, share * Math.max(x, y));
  return (
    eq(a.radius, b.radius, 0.01, 0.01) &&
    eq(a.minorRadius, b.minorRadius, 0.01, 0.01) &&
    eq(a.halfAngle, b.halfAngle, 0.5, 0) &&
    eq(a.length, b.length, 0.05, 0.01) &&
    (!strict || eq(a.area, b.area, 0.05, 0.02))
  );
}

export function matchEntity(
  e: EntityItem,
  a: Alignment,
): { id: number; status: 'found' | 'changed' } | undefined {
  if (e.kind === 'body') {
    return a.body.index >= 0 ? { id: a.body.index, status: 'found' } : undefined;
  }
  const fp = e.fp;
  if (!fp?.point) return undefined;
  const near = candidates(e, a);
  const first = near[0];
  const tol = a.body.tolFound;
  if (first && first.d <= tol)
    return { id: first.id, status: sameSize(fp, first.fp) ? 'found' : 'changed' };
  // One clear candidate a little further away (a moved wall, a resized hole).
  const second = near[1];
  if (first && (!second || second.d > first.d * 1.5 + tol))
    return { id: first.id, status: 'changed' };
  if (first) return undefined; // several equally near (an edge split by a fillet): can't tell
  // Shifted: moved with a side of the box (a longer plate's end), or the only one of its kind.
  const shift = followBox(a, apply(a.t, fp.point));
  if (shift) {
    const p = apply(a.t, fp.point);
    const moved = candidates(e, a, [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]], tol)[0];
    if (moved && sameSize(fp, moved.fp)) return { id: moved.id, status: 'changed' };
  }
  const alike = candidates(e, a, undefined, Infinity).filter((c) => sameSize(fp, c.fp, true));
  if (alike.length === 1 && alike[0]) return { id: alike[0].id, status: 'changed' };
  return undefined;
}
