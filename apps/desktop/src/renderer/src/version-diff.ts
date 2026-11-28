/**
 * What changed between two versions of a model (the compare overlay), from their meshes: the
 * previous version's surface and edge pieces that are not in the new one (drawn see-through:
 * material that went away or moved), and the new version's surface not in the old one (tinted:
 * material that is new or moved).
 *
 * A triangle / edge piece is unchanged when all its corners are corners of the other mesh too
 * (within {@link DIFF_TOLERANCE_MM}) — our tessellation gives the same points for an untouched
 * face — or, with `near`, when its corners and centre lie on the other version's surface (a face
 * meshed again only because its outline changed, like the top of a plate that got a fillet at one
 * end). With `near`, a piece partly on the other surface is split (up to {@link MAX_SPLIT_DEPTH}
 * times) and only its parts off that surface are kept, so a big flat triangle reaching into a
 * changed corner doesn't light up whole. Pure (no three.js): `near` is given by the caller.
 */

/** Corner positions closer than this are the same point (rounded to a grid of this size). */
export const DIFF_TOLERANCE_MM = 0.001;

/** Halvings of a triangle / edge piece that is partly on the other surface. */
export const MAX_SPLIT_DEPTH = 6;

export interface DiffMesh {
  /** XYZ per mesh vertex. */
  readonly positions: ArrayLike<number>;
  /** 3 vertex indices per triangle. */
  readonly indices: ArrayLike<number>;
  /** XYZ points of all edge polylines. */
  readonly edgePoints: ArrayLike<number>;
  /** Per edge: [first point index, point count]. */
  readonly edgeRanges: ArrayLike<number>;
}

export interface VersionDiff {
  /** Previous version: XYZ per corner, 3 corners per triangle (piece) not in the new mesh. */
  readonly oldTriangles: Float32Array;
  /** Previous version: XYZ pairs of edge pieces not in the new mesh. */
  readonly oldEdges: Float32Array;
  /** New version: XYZ per corner, 3 corners per triangle (piece) not in the old mesh. */
  readonly newTriangles: Float32Array;
}

/** Whether a point lies on a version's surface (within the caller's tolerance). */
export type NearSurface = (x: number, y: number, z: number) => boolean;

type P = readonly [number, number, number];

function key(p: ArrayLike<number>, i: number): string {
  const s = 1 / DIFF_TOLERANCE_MM;
  return `${String(Math.round((p[i] ?? 0) * s))},${String(Math.round((p[i + 1] ?? 0) * s))},${String(Math.round((p[i + 2] ?? 0) * s))}`;
}

function pointSet(points: ArrayLike<number>): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 2 < points.length; i += 3) set.add(key(points, i));
  return set;
}

function at(p: ArrayLike<number>, i: number): P {
  return [p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0];
}

function mid(a: P, b: P): P {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function centre(ps: readonly P[]): P {
  const n = ps.length;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of ps) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / n, y / n, z / n];
}

/**
 * Adds the parts of a piece (triangle: 3 corners, edge: 2) that are off the other surface to `out`:
 * all corners + centre on it → nothing; none on it, or split often enough → the whole piece; else
 * split it (triangle into 4, edge into 2) and look again.
 */
function keepOff(near: NearSurface, corners: readonly P[], depth: number, out: number[]): void {
  const on = [...corners, centre(corners)].map((p) => near(p[0], p[1], p[2]));
  const count = on.filter(Boolean).length;
  if (count === on.length) return;
  if (count === 0 || depth >= MAX_SPLIT_DEPTH) {
    for (const p of corners) out.push(p[0], p[1], p[2]);
    return;
  }
  if (corners.length === 2) {
    const [a, b] = corners as [P, P];
    const m = mid(a, b);
    keepOff(near, [a, m], depth + 1, out);
    keepOff(near, [m, b], depth + 1, out);
    return;
  }
  const [a, b, c] = corners as [P, P, P];
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  for (const t of [
    [a, ab, ca],
    [ab, b, bc],
    [ca, bc, c],
    [ab, bc, ca],
  ] as const)
    keepOff(near, t, depth + 1, out);
}

/** Triangle pieces of `m` not in `other` (vertex positions) and, with `near`, off its surface. */
function changedTriangles(m: DiffMesh, other: Set<string>, near?: NearSurface): Float32Array {
  const out: number[] = [];
  const n = Math.floor(m.indices.length / 3);
  for (let t = 0; t < n; t++) {
    const idx = [0, 1, 2].map((c) => (m.indices[t * 3 + c] ?? 0) * 3);
    if (idx.every((i) => other.has(key(m.positions, i)))) continue;
    const corners = idx.map((i) => at(m.positions, i));
    if (near) keepOff(near, corners, 0, out);
    else for (const p of corners) out.push(p[0], p[1], p[2]);
  }
  return new Float32Array(out);
}

export function versionDiff(
  oldMesh: DiffMesh,
  newMesh: DiffMesh,
  near?: { readonly old: NearSurface; readonly new: NearSurface },
): VersionDiff {
  const newEdgePts = pointSet(newMesh.edgePoints);
  const edges: number[] = [];
  const p = oldMesh.edgePoints;
  for (let e = 0; e + 1 < oldMesh.edgeRanges.length; e += 2) {
    const first = oldMesh.edgeRanges[e] ?? 0;
    const count = oldMesh.edgeRanges[e + 1] ?? 0;
    for (let i = first; i + 1 < first + count; i++) {
      const a = i * 3;
      const b = a + 3;
      if (newEdgePts.has(key(p, a)) && newEdgePts.has(key(p, b))) continue;
      const ends = [at(p, a), at(p, b)];
      if (near) keepOff(near.new, ends, 0, edges);
      else for (const q of ends) edges.push(q[0], q[1], q[2]);
    }
  }
  return {
    oldTriangles: changedTriangles(oldMesh, pointSet(newMesh.positions), near?.new),
    oldEdges: new Float32Array(edges),
    newTriangles: changedTriangles(newMesh, pointSet(oldMesh.positions), near?.old),
  };
}
