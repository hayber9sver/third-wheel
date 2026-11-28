/**
 * Camera for a region render, pure: which points the picture must show, from which
 * direction, and how far zoomed (orthographic). The direction is the region's
 * average outward normal; a region that wraps around (hole, pin, whole body) is turned towards an
 * iso corner; edges / vertices without faces are seen from outside their body. "Up" is Z where
 * possible (`standardScreenUp`). Used by `Viewport.renderRegion` (region-render.ts draws it).
 */
import type { StepModel } from '@third-wheel/geometry';
import { cross, dot, length, normalize, standardScreenUp, type Vec3 } from './camera-views.js';
import type { FaceTriangles } from './highlight-buffers.js';
import { colorToHex, shownEntities, type Marker, type ShownEntity } from './markers.js';
import type { MarkerStyle } from './paint-overlay.js';
import type { SelectionItem } from './selection.js';

/** Default / smallest / largest picture size in px (square). */
export const REGION_SIZE = { default: 384, min: 64, max: 768 } as const;
/** Share of the picture the region fills (the rest shows what is around it). */
export const REGION_FILL = 0.6;
/** Below this flatness (|Σ area·n| / area) one direction can't show the region: turn to iso. */
export const WRAP_FLATNESS = 0.5;

export type RegionModel = Pick<
  StepModel,
  | 'positions'
  | 'normals'
  | 'indices'
  | 'triangleFace'
  | 'faceBody'
  | 'edgePoints'
  | 'edgeRanges'
  | 'edgeBody'
  | 'vertexPositions'
  | 'vertexBody'
>;

export interface RegionSamples {
  /** XYZ of every point the picture must show. */
  readonly points: Float32Array;
  /** Σ area · outward unit normal over the region's triangles. */
  readonly normalSum: Vec3;
  /** Total area of the region's triangles (mm²). */
  readonly area: number;
  /** Unit direction from the centre of their bodies to the held edges / vertices; none → undefined. */
  readonly outward: Vec3 | undefined;
  /** Bodies the region lies on (never ghosted in its picture), ascending. */
  readonly bodies: readonly number[];
}

/**
 * Points + normals of painted `triangles` and held `items` (faces, whole bodies, edges, vertices).
 * Triangle normals point the way the vertex normals do (OCCT winding can be reversed).
 * `bodyCenter(b)`: centre of body b (for `outward`).
 */
export function regionSamples(
  model: RegionModel,
  faceTris: FaceTriangles,
  items: readonly SelectionItem[],
  triangles: ArrayLike<number>,
  bodyCenter: (body: number) => Vec3,
): RegionSamples {
  const { positions: P, normals: N, indices: I } = model;
  const faceCount = model.faceBody.length;
  const triSeen = new Uint8Array(model.triangleFace.length);
  const vertSeen = new Uint8Array(P.length / 3);
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let area = 0;
  const own = new Set<number>();
  const addTri = (t: number): void => {
    if (t < 0 || t >= triSeen.length || triSeen[t]) return;
    triSeen[t] = 1;
    own.add(model.faceBody[model.triangleFace[t] ?? 0] ?? 0);
    const a = I[t * 3] ?? 0;
    const b = I[t * 3 + 1] ?? 0;
    const c = I[t * 3 + 2] ?? 0;
    vertSeen[a] = 1;
    vertSeen[b] = 1;
    vertSeen[c] = 1;
    const ux = (P[b * 3] ?? 0) - (P[a * 3] ?? 0);
    const uy = (P[b * 3 + 1] ?? 0) - (P[a * 3 + 1] ?? 0);
    const uz = (P[b * 3 + 2] ?? 0) - (P[a * 3 + 2] ?? 0);
    const vx = (P[c * 3] ?? 0) - (P[a * 3] ?? 0);
    const vy = (P[c * 3 + 1] ?? 0) - (P[a * 3 + 1] ?? 0);
    const vz = (P[c * 3 + 2] ?? 0) - (P[a * 3 + 2] ?? 0);
    let cx = uy * vz - uz * vy;
    let cy = uz * vx - ux * vz;
    let cz = ux * vy - uy * vx;
    const twice = Math.hypot(cx, cy, cz);
    if (twice === 0) return; // sliver: its points still count
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const v of [a, b, c]) {
      sx += N[v * 3] ?? 0;
      sy += N[v * 3 + 1] ?? 0;
      sz += N[v * 3 + 2] ?? 0;
    }
    if (cx * sx + cy * sy + cz * sz < 0) {
      cx = -cx;
      cy = -cy;
      cz = -cz;
    }
    // |c| = 2 · area, so c / 2 = area · unit normal.
    nx += cx / 2;
    ny += cy / 2;
    nz += cz / 2;
    area += twice / 2;
  };
  const addFace = (f: number): void => {
    if (f < 0 || f >= faceCount) return;
    for (let i = faceTris.start[f] ?? 0; i < (faceTris.start[f + 1] ?? 0); i++)
      addTri(faceTris.tris[i] ?? 0);
  };

  for (let i = 0; i < triangles.length; i++) addTri(triangles[i] ?? 0);
  const bodies = new Set<number>();
  const extra: number[] = [];
  const extraBodies = new Set<number>();
  for (const { kind, id } of items) {
    if (kind === 'face') addFace(id);
    else if (kind === 'body') bodies.add(id);
    else if (kind === 'edge' && id < model.edgeBody.length) {
      const first = model.edgeRanges[id * 2] ?? 0;
      const n = model.edgeRanges[id * 2 + 1] ?? 0;
      for (let k = first * 3; k < (first + n) * 3; k++) extra.push(model.edgePoints[k] ?? 0);
      extraBodies.add(model.edgeBody[id] ?? 0);
    } else if (kind === 'vertex' && id < model.vertexBody.length) {
      for (let k = id * 3; k < id * 3 + 3; k++) extra.push(model.vertexPositions[k] ?? 0);
      extraBodies.add(model.vertexBody[id] ?? 0);
    }
  }
  if (bodies.size > 0)
    for (let f = 0; f < faceCount; f++) if (bodies.has(model.faceBody[f] ?? -1)) addFace(f);

  let count = 0;
  for (const s of vertSeen) count += s;
  const points = new Float32Array(count * 3 + extra.length);
  let o = 0;
  for (let v = 0; v < vertSeen.length; v++) {
    if (!vertSeen[v]) continue;
    points[o++] = P[v * 3] ?? 0;
    points[o++] = P[v * 3 + 1] ?? 0;
    points[o++] = P[v * 3 + 2] ?? 0;
  }
  points.set(extra, o);

  let outward: Vec3 | undefined;
  if (extra.length > 0) {
    const mid = centroid(Float32Array.from(extra));
    const c: [number, number, number] = [0, 0, 0];
    for (const b of extraBodies) {
      const bc = bodyCenter(b);
      for (let k = 0; k < 3; k++) c[k] = (c[k] ?? 0) + (bc[k] ?? 0) / extraBodies.size;
    }
    const d: Vec3 = [mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]];
    if (length(d) > 1e-9) outward = normalize(d);
  }
  for (const b of [...extraBodies, ...bodies]) own.add(b);
  const ownBodies = [...own].sort((a, b) => a - b);
  return { points, normalSum: [nx, ny, nz], area, outward, bodies: ownBodies };
}

function centroid(points: Float32Array): Vec3 {
  const n = points.length / 3 || 1;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i += 3) {
    x += points[i] ?? 0;
    y += points[i + 1] ?? 0;
    z += points[i + 2] ?? 0;
  }
  return [x / n, y / n, z / n];
}

const ISO_DIR: Vec3 = normalize([1, -1, 1]);

/** The iso corner direction nearest `v` (zero components default to the standard iso corner). */
function isoCorner(v: Vec3): Vec3 {
  const s = (c: number, fallback: number): number => (c > 1e-9 ? 1 : c < -1e-9 ? -1 : fallback);
  return normalize([s(v[0], 1), s(v[1], -1), s(v[2], 1)]);
}

/**
 * Unit direction from the region towards the camera. Flat-ish paint/faces: their average normal.
 * Wrapping regions (flatness < WRAP_FLATNESS) blend towards the nearest iso corner (all the way at
 * flatness 0). Only edges / vertices: `outward`. Nothing to go by: the standard iso view.
 */
export function regionViewDir(s: RegionSamples): Vec3 {
  if (s.area > 0) {
    const nLen = length(s.normalSum);
    const flatness = Math.min(nLen / s.area, 1);
    const base = nLen > 1e-9 * s.area ? normalize(s.normalSum) : undefined;
    if (base && flatness >= WRAP_FLATNESS) return base;
    const corner = isoCorner(base ?? s.outward ?? ISO_DIR);
    if (!base) return corner;
    const w = flatness / WRAP_FLATNESS;
    const d: Vec3 = [
      w * base[0] + (1 - w) * corner[0],
      w * base[1] + (1 - w) * corner[1],
      w * base[2] + (1 - w) * corner[2],
    ];
    return length(d) > 1e-6 ? normalize(d) : corner;
  }
  return s.outward ?? ISO_DIR;
}

/** An orthographic camera for the picture (all lengths in mm). */
export interface RegionView {
  /** Unit direction from `target` towards the camera (the camera looks along −dir). */
  readonly dir: Vec3;
  /** Unit screen-up (⟂ dir). */
  readonly up: Vec3;
  /** Centre of the picture. */
  readonly target: Vec3;
  /** Half the picture's width (= height) in mm. */
  readonly halfSize: number;
  /** Camera distance from `target`, outside the whole model. */
  readonly distance: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Camera that shows all `points` (region fills REGION_FILL of the square picture) looking along
 * −`dir`. `model`: the whole model's sphere (camera placed outside it; tiny regions get a picture at
 * least 2 % of the model's diameter wide, at least 1 mm).
 */
export function regionView(
  points: Float32Array,
  dir: Vec3,
  model: { readonly center: Vec3; readonly radius: number },
): RegionView {
  const d = normalize(dir);
  const up = standardScreenUp(d);
  const right = cross(up, d);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  let w0 = Infinity;
  let w1 = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const p: Vec3 = [points[i] ?? 0, points[i + 1] ?? 0, points[i + 2] ?? 0];
    const u = dot(p, right);
    const v = dot(p, up);
    const w = dot(p, d);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
    w0 = Math.min(w0, w);
    w1 = Math.max(w1, w);
  }
  if (!(u0 <= u1)) {
    // No points: the whole model.
    u0 = u1 = dot(model.center, right);
    v0 = v1 = dot(model.center, up);
    w0 = w1 = dot(model.center, d);
    const r = model.radius * REGION_FILL;
    u0 -= r;
    u1 += r;
    v0 -= r;
    v1 += r;
  }
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  const wc = (w0 + w1) / 2;
  const target: Vec3 = [
    uc * right[0] + vc * up[0] + wc * d[0],
    uc * right[1] + vc * up[1] + wc * d[1],
    uc * right[2] + vc * up[2] + wc * d[2],
  ];
  const minHalf = Math.max(model.radius * 0.02, 0.5);
  const halfSize = Math.max(Math.max(u1 - u0, v1 - v0) / 2 / REGION_FILL, minHalf);
  const toCenter = length([
    target[0] - model.center[0],
    target[1] - model.center[1],
    target[2] - model.center[2],
  ]);
  const distance = toCenter + model.radius + Math.max(model.radius * 0.1, 1);
  return {
    dir: d,
    up,
    target,
    halfSize,
    distance,
    near: distance * 1e-3,
    far: distance + toCenter + model.radius + 1,
  };
}

/** Size asked for → whole px in [min, max] (default when not given). */
export function regionSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return REGION_SIZE.default;
  return Math.min(Math.max(Math.round(size), REGION_SIZE.min), REGION_SIZE.max);
}

/** What to draw for `markerIds`: their paint styles and held entities, shown even when hidden. */
export interface RegionRequest {
  readonly markerIds: readonly string[];
  readonly styles: readonly MarkerStyle[];
  readonly entities: readonly ShownEntity[];
}

/** Request for `markerIds` (unknown ids are left out; order kept as in the marker list). */
export function regionRequest(
  markers: readonly Marker[],
  markerIds: readonly string[],
): RegionRequest {
  const want = new Set(markerIds);
  const chosen = markers.filter((m) => want.has(m.id)).map((m) => ({ ...m, visible: true }));
  return {
    markerIds: chosen.map((m) => m.id),
    styles: chosen.map((m) => ({ id: m.id, color: colorToHex(m.color), visible: true })),
    entities: shownEntities(chosen),
  };
}
