/**
 * Smart fill, pure (no three.js): which triangles a click fills.
 *
 * `TriangleAdjacency` links triangles that share an edge. CAD faces are meshed separately, so
 * vertices are joined by exact position first (OCCT meshes a shared B-rep edge once, so both
 * faces get bit-identical points); a fill can then cross a smooth join, e.g. fillet → flat face.
 * `smartFill` spreads from the clicked triangle to neighbours whose normals differ by at most the
 * angle (neighbour to neighbour, like PrusaSlicer / OrcaSlicer), so a whole cylinder fills.
 */

/** Smart fill angle in degrees: default and the range `[` / `]` / Alt + scroll step through. */
export const DEFAULT_FILL_ANGLE_DEG = 30;
export const FILL_ANGLE_STEP_DEG = 5;
export const MAX_FILL_ANGLE_DEG = 90;

/** Angle `steps` × 5° up or down from `deg`, kept within 0–90°. */
export function stepFillAngle(deg: number, steps: number): number {
  const snapped = Math.round(deg / FILL_ANGLE_STEP_DEG) * FILL_ANGLE_STEP_DEG;
  return Math.min(
    MAX_FILL_ANGLE_DEG,
    Math.max(0, snapped + Math.trunc(steps) * FILL_ANGLE_STEP_DEG),
  );
}

export class TriangleAdjacency {
  /** Unit facet normal per triangle; (0, 0, 0) for a degenerate (zero-area) one. */
  readonly normals: Float32Array;
  /**
   * Half-edge h = 3t + k (edge from corner k to k+1 of triangle t). `ring[h]` = next half-edge on
   * the same edge (a ring through all triangles sharing it); `h` itself when no other triangle
   * shares it. Handles non-manifold edges (3+ triangles) too.
   */
  private readonly ring: Int32Array;

  private constructor(
    readonly triangleCount: number,
    normals: Float32Array,
    ring: Int32Array,
  ) {
    this.normals = normals;
    this.ring = ring;
  }

  /**
   * `vertexNormals` (optional, the mesh's shading normals): each facet normal is turned to agree
   * with them, so a face meshed with the opposite winding doesn't stop a fill.
   */
  static build(
    positions: Float32Array,
    indices: Uint32Array,
    vertexNormals?: Float32Array,
  ): TriangleAdjacency {
    const triangleCount = Math.floor(indices.length / 3);
    const weld = weldVertices(positions);
    const ring = new Int32Array(triangleCount * 3);
    for (let h = 0; h < ring.length; h++) ring[h] = h;
    // Open-addressing table over undirected edges (welded endpoints); slot = first half-edge + 1.
    const size = pow2AtLeast(ring.length * 2);
    const table = new Int32Array(size);
    const mask = size - 1;
    const end = (h: number, second: boolean): number => {
      const t = Math.floor(h / 3);
      const k = (h - t * 3 + (second ? 1 : 0)) % 3;
      return weld[indices[t * 3 + k] ?? 0] ?? 0;
    };
    for (let h = 0; h < ring.length; h++) {
      const a0 = end(h, false);
      const b0 = end(h, true);
      if (a0 === b0) continue; // collapsed edge: links nothing
      const a = Math.min(a0, b0);
      const b = Math.max(a0, b0);
      let slot = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) & mask;
      for (;;) {
        const stored = table[slot] ?? 0;
        if (stored === 0) {
          table[slot] = h + 1;
          break;
        }
        const g = stored - 1;
        const ga = end(g, false);
        const gb = end(g, true);
        if (Math.min(ga, gb) === a && Math.max(ga, gb) === b) {
          ring[h] = ring[g] ?? g;
          ring[g] = h;
          break;
        }
        slot = (slot + 1) & mask;
      }
    }
    return new TriangleAdjacency(
      triangleCount,
      facetNormals(positions, indices, vertexNormals),
      ring,
    );
  }

  /** Calls `fn` for every triangle sharing an edge with `t` (a triangle may come more than once). */
  forEachNeighbour(t: number, fn: (u: number) => void): void {
    for (let k = 0; k < 3; k++) {
      const h = t * 3 + k;
      for (let g = this.ring[h] ?? h; g !== h; g = this.ring[g] ?? h) fn(Math.floor(g / 3));
    }
  }

  /** Edges used by only one triangle (0 on a closed, well-joined solid). Diagnostics / tests. */
  openEdges(): number {
    let n = 0;
    for (let h = 0; h < this.ring.length; h++) if (this.ring[h] === h) n++;
    return n;
  }
}

/** A filled region: its triangles and a membership flag per triangle of the model. */
export interface FillRegion {
  readonly triangles: Uint32Array;
  readonly contains: Uint8Array;
}

/**
 * Triangles connected to `seed` across edges whose two triangles' normals differ by at most
 * `maxAngleDeg`, and for which `accept` is true (e.g. same body). A degenerate triangle never
 * stops the fill; it passes on the normal of the triangle it was reached from.
 */
export function smartFill(
  adj: TriangleAdjacency,
  seed: number,
  maxAngleDeg: number,
  accept: (t: number) => boolean = () => true,
): FillRegion {
  const contains = new Uint8Array(adj.triangleCount);
  if (seed < 0 || seed >= adj.triangleCount) return { triangles: new Uint32Array(), contains };
  const N = adj.normals;
  const minDot = Math.cos((Math.min(180, Math.max(0, maxAngleDeg)) * Math.PI) / 180) - 1e-6;
  const degenerate = (t: number): boolean =>
    N[t * 3] === 0 && N[t * 3 + 1] === 0 && N[t * 3 + 2] === 0;
  /** Degenerate triangle → triangle whose normal it carries (-1 = none: anything goes). */
  const carried = new Map<number, number>();
  const queue: number[] = [seed];
  contains[seed] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const t = queue[qi] ?? 0;
    const ref = degenerate(t) ? (carried.get(t) ?? -1) : t;
    adj.forEachNeighbour(t, (u) => {
      if (contains[u] || !accept(u)) return;
      if (degenerate(u)) carried.set(u, ref);
      else if (ref >= 0) {
        const dot =
          (N[ref * 3] ?? 0) * (N[u * 3] ?? 0) +
          (N[ref * 3 + 1] ?? 0) * (N[u * 3 + 1] ?? 0) +
          (N[ref * 3 + 2] ?? 0) * (N[u * 3 + 2] ?? 0);
        if (dot < minDot) return;
      }
      contains[u] = 1;
      queue.push(u);
    });
  }
  return { triangles: Uint32Array.from(queue), contains };
}

/**
 * Brush patch (slicer rule): of the triangles inside the brush ball (`inBall`), those
 * connected to `seed` (the triangle under the stamp) through other triangles of the ball that
 * face the camera (`facing`). Keeps the back of a thin wall, a parallel wall behind a gap and a
 * nearby separate part clean. The seed is always kept (it was hit, so it is seen).
 */
export function brushPatch(
  adj: TriangleAdjacency,
  seed: number,
  inBall: ReadonlySet<number>,
  facing: (t: number) => boolean,
): number[] {
  if (!inBall.has(seed)) return [];
  const seen = new Set<number>([seed]);
  const queue = [seed];
  for (let qi = 0; qi < queue.length; qi++) {
    adj.forEachNeighbour(queue[qi] ?? 0, (u) => {
      if (seen.has(u) || !inBall.has(u) || !facing(u)) return;
      seen.add(u);
      queue.push(u);
    });
  }
  return queue;
}

/** All triangles of B-rep face `face` ("Whole CAD face" mode). */
export function faceRegion(triangleFace: Uint32Array, face: number): FillRegion {
  const contains = new Uint8Array(triangleFace.length);
  const out: number[] = [];
  for (let t = 0; t < triangleFace.length; t++) {
    if (triangleFace[t] === face) {
      contains[t] = 1;
      out.push(t);
    }
  }
  return { triangles: Uint32Array.from(out), contains };
}

/** Vertex → representative vertex with the bit-identical position (−0 counts as 0). */
function weldVertices(positions: Float32Array): Uint32Array {
  const count = Math.floor(positions.length / 3);
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, count * 3);
  const key = (v: number, a: number): number => {
    const b = bits[v * 3 + a] ?? 0;
    return b === 0x80000000 ? 0 : b;
  };
  const weld = new Uint32Array(count);
  const size = pow2AtLeast(count * 2);
  const table = new Int32Array(size); // vertex + 1
  const mask = size - 1;
  for (let v = 0; v < count; v++) {
    const x = key(v, 0);
    const y = key(v, 1);
    const z = key(v, 2);
    let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const stored = table[slot] ?? 0;
      if (stored === 0) {
        table[slot] = v + 1;
        weld[v] = v;
        break;
      }
      const w = stored - 1;
      if (key(w, 0) === x && key(w, 1) === y && key(w, 2) === z) {
        weld[v] = w;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }
  return weld;
}

function facetNormals(
  positions: Float32Array,
  indices: Uint32Array,
  vertexNormals: Float32Array | undefined,
): Float32Array {
  const count = Math.floor(indices.length / 3);
  const out = new Float32Array(count * 3);
  const P = positions;
  for (let t = 0; t < count; t++) {
    const i0 = (indices[t * 3] ?? 0) * 3;
    const i1 = (indices[t * 3 + 1] ?? 0) * 3;
    const i2 = (indices[t * 3 + 2] ?? 0) * 3;
    const ux = (P[i1] ?? 0) - (P[i0] ?? 0);
    const uy = (P[i1 + 1] ?? 0) - (P[i0 + 1] ?? 0);
    const uz = (P[i1 + 2] ?? 0) - (P[i0 + 2] ?? 0);
    const vx = (P[i2] ?? 0) - (P[i0] ?? 0);
    const vy = (P[i2 + 1] ?? 0) - (P[i0 + 1] ?? 0);
    const vz = (P[i2 + 2] ?? 0) - (P[i0 + 2] ?? 0);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    let len = Math.hypot(nx, ny, nz);
    if (len <= 1e-12) continue; // degenerate: stays (0, 0, 0)
    if (vertexNormals) {
      const V = vertexNormals;
      const s =
        nx * ((V[i0] ?? 0) + (V[i1] ?? 0) + (V[i2] ?? 0)) +
        ny * ((V[i0 + 1] ?? 0) + (V[i1 + 1] ?? 0) + (V[i2 + 1] ?? 0)) +
        nz * ((V[i0 + 2] ?? 0) + (V[i1 + 2] ?? 0) + (V[i2 + 2] ?? 0));
      if (s < 0) len = -len;
    }
    out[t * 3] = nx / len;
    out[t * 3 + 1] = ny / len;
    out[t * 3 + 2] = nz / len;
  }
  return out;
}

function pow2AtLeast(n: number): number {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}
