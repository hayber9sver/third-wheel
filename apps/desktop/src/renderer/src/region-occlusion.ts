/**
 * Parts in front of a region, pure. Rays go from points of the
 * region towards the camera; a ray that meets nothing = that point is seen. When too little of the
 * region is seen from its preferred direction, the 6 axis views and 8 iso corners are tried too
 * and the clearest wins (slightly favouring the preferred one). Other bodies still in front are
 * then ghosted in the picture (region-render.ts); the region's own bodies never are.
 */
import { dot, normalize, type Vec3 } from './camera-views.js';

/** Bodies met by the ray from `origin` along unit `dir` (any order; duplicates allowed). */
export type CastBodies = (origin: Vec3, dir: Vec3) => readonly number[];

/** At most this many region points are tested per direction (evenly spread). */
export const MAX_RAYS = 400;
/** The preferred direction is kept when at least this share of the region is seen clear. */
export const CLEAR_ENOUGH = 0.75;
/** A point hidden only by other bodies counts this much (it is seen through a ghost). */
const GHOSTED_WEIGHT = 0.5;
/** Bonus × cos(angle to the preferred direction): keeps the view near the region's normal. */
const PREFERRED_WEIGHT = 0.1;
/** A body is ghosted when it hides at least this share of the tested points (and ≥ 1 point). */
const GHOST_MIN_SHARE = 0.02;

export interface Occlusion {
  /** Share of tested points with nothing in front. */
  readonly clear: number;
  /** Share hidden only by other bodies (seen once those are ghosted). */
  readonly ghostable: number;
  /** Other bodies in front of a point (not counting points the region's own bodies hide). */
  readonly blockers: ReadonlyMap<number, number>;
  /** Number of points tested. */
  readonly rays: number;
}

/**
 * How much of `points` (XYZ) is seen from unit direction `dir` (towards the camera). `own`: the
 * region's bodies — a ray meeting one of them is hidden for good. `eps`: rays start this far off
 * the surface (mm), so they don't meet the point's own triangle.
 */
export function occlusion(
  points: Float32Array,
  dir: Vec3,
  own: ReadonlySet<number>,
  cast: CastBodies,
  eps: number,
): Occlusion {
  const n = points.length / 3;
  const step = Math.max(1, n / MAX_RAYS);
  let rays = 0;
  let clear = 0;
  let ghostable = 0;
  const blockers = new Map<number, number>();
  for (let f = 0; f < n; f += step) {
    const i = Math.floor(f) * 3;
    const origin: Vec3 = [
      (points[i] ?? 0) + dir[0] * eps,
      (points[i + 1] ?? 0) + dir[1] * eps,
      (points[i + 2] ?? 0) + dir[2] * eps,
    ];
    rays++;
    const hit = new Set(cast(origin, dir));
    if (hit.size === 0) {
      clear++;
      continue;
    }
    if ([...hit].some((b) => own.has(b))) continue;
    ghostable++;
    for (const b of hit) blockers.set(b, (blockers.get(b) ?? 0) + 1);
  }
  const share = (k: number): number => (rays > 0 ? k / rays : 0);
  return { clear: share(clear), ghostable: share(ghostable), blockers, rays };
}

/** `preferred` first, then the 6 axis directions and 8 iso corners (near-duplicates left out). */
export function candidateDirs(preferred: Vec3): Vec3[] {
  const out: Vec3[] = [normalize(preferred)];
  const add = (d: Vec3): void => {
    const u = normalize(d);
    if (out.every((o) => dot(o, u) < 0.999)) out.push(u);
  };
  for (const a of [0, 1, 2])
    for (const s of [1, -1]) add([a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0]);
  for (const x of [1, -1]) for (const y of [1, -1]) for (const z of [1, -1]) add([x, y, z]);
  return out;
}

export interface RegionDirChoice {
  /** Unit direction towards the camera. */
  readonly dir: Vec3;
  /** Bodies to ghost (in front of the region from `dir`), ascending. */
  readonly ghost: readonly number[];
  /** Share of the region seen clear / through ghosts from `dir`. */
  readonly clear: number;
  readonly ghostable: number;
}

/**
 * Direction for the region picture: `preferred` when ≥ CLEAR_ENOUGH of it is seen clear, else the
 * best of `candidateDirs` by clear + ½ ghostable + 0.1 · cos(angle to preferred). No points →
 * `preferred`, nothing ghosted.
 */
export function chooseRegionDir(
  points: Float32Array,
  preferred: Vec3,
  own: ReadonlySet<number>,
  cast: CastBodies,
  eps: number,
): RegionDirChoice {
  const pref = normalize(preferred);
  if (points.length === 0) return { dir: pref, ghost: [], clear: 1, ghostable: 0 };
  const score = (d: Vec3, o: Occlusion): number =>
    o.clear + GHOSTED_WEIGHT * o.ghostable + PREFERRED_WEIGHT * dot(d, pref);
  let bestDir = pref;
  let best = occlusion(points, pref, own, cast, eps);
  if (best.clear < CLEAR_ENOUGH) {
    let bestScore = score(pref, best);
    for (const d of candidateDirs(pref).slice(1)) {
      const o = occlusion(points, d, own, cast, eps);
      const s = score(d, o);
      if (s > bestScore + 1e-9) {
        bestScore = s;
        best = o;
        bestDir = d;
      }
    }
  }
  const min = Math.max(1, GHOST_MIN_SHARE * best.rays);
  const ghost = [...best.blockers]
    .filter(([, k]) => k >= min)
    .map(([b]) => b)
    .sort((a, b) => a - b);
  return { dir: bestDir, ghost, clear: best.clear, ghostable: best.ghostable };
}
