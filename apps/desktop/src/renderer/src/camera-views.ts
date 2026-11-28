/**
 * Camera helper maths (pure, no three.js): preset view directions, view-cube hits, fit distance,
 * per-body bounds and the eased orbit between two camera poses. World is Z-up; "Front" looks from
 * −Y towards +Y, so +X is to the right.
 */

export type Vec3 = readonly [number, number, number];

export type ViewId = 'iso' | 'front' | 'top' | 'right' | 'back' | 'bottom' | 'left';

export interface PresetView {
  readonly id: ViewId;
  readonly label: string;
  /** Keyboard shortcut (FreeCAD numbering). */
  readonly key: string;
  /** Unit direction from the look-at target towards the camera. */
  readonly dir: Vec3;
}

const ISO = 1 / Math.sqrt(3);

export const PRESET_VIEWS: readonly PresetView[] = [
  { id: 'iso', label: 'Iso', key: '0', dir: [ISO, -ISO, ISO] },
  { id: 'front', label: 'Front', key: '1', dir: [0, -1, 0] },
  { id: 'top', label: 'Top', key: '2', dir: [0, 0, 1] },
  { id: 'right', label: 'Right', key: '3', dir: [1, 0, 0] },
  { id: 'back', label: 'Back', key: '4', dir: [0, 1, 0] },
  { id: 'bottom', label: 'Bottom', key: '5', dir: [0, 0, -1] },
  { id: 'left', label: 'Left', key: '6', dir: [-1, 0, 0] },
];

/** Zoom-to-fit shortcut ("zoom all"; F is taken by Smart fill). */
export const FIT_KEY = 'z';

export function viewForKey(key: string): PresetView | undefined {
  return PRESET_VIEWS.find((v) => v.key === key);
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v: Vec3): Vec3 {
  const l = length(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * View-cube click → view direction. `p` is the hit point on a unit cube (coordinates in
 * [−0.5, 0.5]); a coordinate within `band` of a cube face counts, so the middle of a face gives a
 * face view, the band along an edge an edge view and a corner square a corner view (26 views).
 */
export function cubeHitDirection(p: Vec3, band = 0.15): Vec3 {
  const pick = (c: number): number => (Math.abs(c) >= 0.5 - band ? Math.sign(c) : 0);
  const d: Vec3 = [pick(p[0]), pick(p[1]), pick(p[2])];
  // A hit is always on some face, but guard against rounding at the exact centre.
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) return [0, -1, 0];
  return normalize(d);
}

/** Camera distance from a sphere's centre so the whole sphere fits the view (vertical FOV in °). */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const r = Math.max(radius, 1e-3);
  return r / Math.sin(Math.min(vFov, hFov) / 2);
}

/** A left cover clamped to the view: at least one pixel of a `width` px view stays free. */
function clampCover(width: number, coverLeft: number): number {
  return Math.min(Math.max(coverLeft, 0), Math.max(width - 1, 0));
}

/**
 * How far (CSS px) to move the picture to the right so the view's middle — where the orbit
 * target is drawn — lands in the middle of the part a panel covering `coverLeft` px of the
 * left side of a `width` px view leaves free.
 */
export function freeAreaShift(width: number, coverLeft: number): number {
  return clampCover(width, coverLeft) / 2;
}

/**
 * Camera distance so a sphere fits the part of a `width`×`height` view that a panel covering
 * `coverLeft` px of its left side leaves free (vertical FOV in °).
 */
export function fitInFreeArea(
  radius: number,
  fovDeg: number,
  width: number,
  height: number,
  coverLeft: number,
): number {
  const free = Math.max(width - clampCover(width, coverLeft), 1);
  return fitDistance(radius, fovDeg, free / Math.max(height, 1));
}

/**
 * Axis-aligned bounding box per body, from its triangles (index ranges `triStart`) and its edge
 * segments (vertex ranges `edgeStart`) — the latter covers bodies made only of loose edges.
 * Result: 6 floats per body (minX, minY, minZ, maxX, maxY, maxZ); empty bodies get +∞/−∞.
 */
export function bodyBoxes(
  positions: Float32Array,
  indices: Uint32Array,
  triStart: Uint32Array,
  edgeSegments: Float32Array,
  edgeStart: Uint32Array,
): Float64Array {
  const bodyCount = Math.max(triStart.length - 1, 0);
  const boxes = new Float64Array(bodyCount * 6);
  for (let b = 0; b < bodyCount; b++) {
    const o = b * 6;
    boxes.fill(Infinity, o, o + 3);
    boxes.fill(-Infinity, o + 3, o + 6);
    const grow = (src: Float32Array, v: number): void => {
      for (let k = 0; k < 3; k++) {
        const c = src[v * 3 + k] ?? 0;
        if (c < (boxes[o + k] ?? 0)) boxes[o + k] = c;
        if (c > (boxes[o + 3 + k] ?? 0)) boxes[o + 3 + k] = c;
      }
    };
    for (let i = triStart[b] ?? 0, end = triStart[b + 1] ?? 0; i < end; i++) {
      grow(positions, indices[i] ?? 0);
    }
    for (let v = edgeStart[b] ?? 0, end = edgeStart[b + 1] ?? 0; v < end; v++) {
      grow(edgeSegments, v);
    }
  }
  return boxes;
}

export interface BoundingSphere {
  readonly center: Vec3;
  readonly radius: number;
}

/** Centre of body `b`'s box (`bodyBoxes` layout); origin for an empty body. */
export function boxCenter(boxes: Float64Array, b: number): Vec3 {
  const o = b * 6;
  const c = (k: number): number => {
    const v = ((boxes[o + k] ?? 0) + (boxes[o + 3 + k] ?? 0)) / 2;
    return Number.isFinite(v) ? v : 0;
  };
  return [c(0), c(1), c(2)];
}

/** Sphere around the union box of the given bodies (half the box diagonal); undefined if empty. */
export function sphereOfBodies(
  boxes: Float64Array,
  bodies: Iterable<number>,
): BoundingSphere | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? Infinity, boxes[b * 6 + k] ?? Infinity);
      max[k] = Math.max(max[k] ?? -Infinity, boxes[b * 6 + 3 + k] ?? -Infinity);
    }
  }
  const [x0 = 0, y0 = 0, z0 = 0] = min;
  const [x1 = 0, y1 = 0, z1 = 0] = max;
  if (!(x0 <= x1 && y0 <= y1 && z0 <= z1)) return undefined;
  return {
    center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2,
  };
}

/** Smooth start and stop (cubic ease-in-out), t in [0, 1]. */
export function easeInOut(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

// --- Orientation: screen-up, roll and the orbit axis ---------------------------------------------
//
// The camera orbits like a turntable around `orbitUp` (Z by default). Its picture can be rolled
// so another direction is "up" on screen (`screenUp`, always ⟂ the view direction); rolling a side
// view makes the new screen-up the orbit axis. Keys/Home reset to Z.

export const Z_UP: Vec3 = [0, 0, 1];

const AXES: readonly Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** `v` with its component along unit `n` removed, normalised; undefined if (nearly) parallel. */
function perpendicular(v: Vec3, n: Vec3): Vec3 | undefined {
  const d = dot(v, n);
  const p: Vec3 = [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]];
  return length(p) < 1e-6 ? undefined : normalize(p);
}

/** Standard screen-up for a view direction: Z for side/corner views, +Y on Top, −Y on Bottom. */
export function standardScreenUp(dir: Vec3): Vec3 {
  const d = normalize(dir);
  return perpendicular(Z_UP, d) ?? [0, d[2] > 0 ? 1 : -1, 0];
}

/** Rotate `v` by the smallest rotation taking unit `from` to unit `to` (Rodrigues). */
export function rotateShortestArc(v: Vec3, from: Vec3, to: Vec3, fallbackAxis: Vec3): Vec3 {
  const c = Math.min(Math.max(dot(from, to), -1), 1);
  let axis = cross(from, to);
  if (length(axis) < 1e-9) {
    if (c > 0) return v; // same direction
    // Opposite directions: half-turn around the fallback (e.g. the screen-up: turn around).
    axis = perpendicular(fallbackAxis, from) ?? perpendicular([0, 0, 1], from) ?? [1, 0, 0];
  }
  const k = normalize(axis);
  const angle = Math.acos(c);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const kxv = cross(k, v);
  const kdv = dot(k, v) * (1 - cos);
  return [
    v[0] * cos + kxv[0] * sin + k[0] * kdv,
    v[1] * cos + kxv[1] * sin + k[1] * kdv,
    v[2] * cos + kxv[2] * sin + k[2] * kdv,
  ];
}

/**
 * Screen-up after turning from `fromDir` to `toDir` the "nearest" way (like Fusion's view cube):
 * carry the current screen-up along the shortest turn, then snap to the closest axis as seen
 * from `toDir`. Ties (e.g. Iso → Top) go to the standard orientation.
 */
export function nearestScreenUp(fromDir: Vec3, fromUp: Vec3, toDir: Vec3): Vec3 {
  const to = normalize(toDir);
  const carried = rotateShortestArc(fromUp, normalize(fromDir), to, fromUp);
  const standard = standardScreenUp(to);
  let best: Vec3 = standard;
  let bestScore = -Infinity;
  for (const axis of AXES) {
    if (Math.abs(dot(axis, to)) > 0.99) continue;
    const proj = perpendicular(axis, to);
    if (!proj) continue;
    const score = dot(proj, carried) + 1e-6 * dot(proj, standard);
    if (score > bestScore) {
      bestScore = score;
      best = proj;
    }
  }
  return best;
}

/** Screen-up after rolling the picture 90° clockwise (`cw`) or counter-clockwise on screen. */
export function rollScreenUp(dir: Vec3, screenUp: Vec3, cw: boolean): Vec3 {
  // Clockwise: what was on the left of the screen comes up; left = up × forward = dir × up.
  return normalize(cw ? cross(dir, screenUp) : cross(screenUp, dir));
}

export interface OrbitSetup {
  /** Turntable axis for the orbit controls (camera.up). */
  readonly orbitUp: Vec3;
  /** Direction to place the camera along (target → camera); `dir` or a hair off it. */
  readonly cameraDir: Vec3;
}

/**
 * Orbit axis and camera direction that show `dir` with `screenUp` up on screen. An orbit camera
 * always shows its axis' projection as up, so: keep `orbitUp` if it already gives `screenUp`;
 * when looking along the axis (Top/Bottom with Z), tilt `dir` a hair (visually exact) so the
 * picture turns the right way; otherwise the axis becomes the world axis seen as `screenUp`.
 */
export function orbitSetup(dir: Vec3, screenUp: Vec3, orbitUp: Vec3): OrbitSetup {
  const d = normalize(dir);
  const s = dot(d, orbitUp);
  if (Math.abs(s) > 0.9999) {
    // Start from the exact axis: `dir` may itself carry an earlier tilt.
    const sign = Math.sign(s);
    const e = 1e-4 * sign;
    return {
      orbitUp,
      cameraDir: normalize([
        sign * orbitUp[0] - e * screenUp[0],
        sign * orbitUp[1] - e * screenUp[1],
        sign * orbitUp[2] - e * screenUp[2],
      ]),
    };
  }
  const shown = perpendicular(orbitUp, d);
  if (shown && dot(shown, screenUp) > 0.9999) return { orbitUp, cameraDir: d };
  const axis = AXES.find((a) => {
    const p = perpendicular(a, d);
    return p !== undefined && dot(p, screenUp) > 0.9999;
  });
  return { orbitUp: axis ?? normalize(screenUp), cameraDir: d };
}
