/**
 * Region analysis: numbers that describe one marker's paint, so the AI gets a summary
 * instead of raw triangles and a render can aim at it.
 *
 * Works on the sidecar form of paint (triangle runs + per-triangle piece trees), so it runs on a
 * saved file as well as on the live app state. Paint only: held entities are described separately:
 * a marker with no paint has no region, and faces the marker holds as entities are not
 * repeated in `stepFaces`.
 *
 * Units are the model's (mm). Numbers are not rounded here; the review payload does that.
 */
import type { MarkerData, PieceTree } from './schema.js';

export type Vec3 = [number, number, number];

export interface Bbox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** The parts of our tessellation the analysis needs (same layout as `StepModel`). */
export interface RegionMesh {
  /** XYZ per mesh vertex. */
  readonly positions: ArrayLike<number>;
  /** XYZ normal per mesh vertex; used to orient triangle normals outward (optional). */
  readonly normals?: ArrayLike<number> | undefined;
  /** 3 mesh-vertex indices per triangle. */
  readonly indices: ArrayLike<number>;
  /** faceId per triangle. */
  readonly triangleFace: ArrayLike<number>;
}

/** One separate painted patch. */
export interface RegionComponent {
  readonly area: number;
  readonly centroid: Vec3;
  readonly bbox: Bbox;
}

export interface StepFaceCoverage {
  readonly faceId: number;
  /** Painted share of the face's area, 0–1. */
  readonly coverage: number;
}

export interface RegionSummary {
  /** Painted area (mm²); cut triangles count only their painted pieces. */
  readonly area: number;
  /** Area-weighted centre of the paint (may lie off the surface on curved paint). */
  readonly centroid: Vec3;
  readonly bbox: Bbox;
  /** Area-weighted mean surface normal, unit length ([0, 0, 0] if the normals cancel out). */
  readonly avgNormal: Vec3;
  /**
   * Length of the area-weighted normal sum ÷ area: 1 = flat, near 0 = the paint faces all ways
   * (e.g. all around a pin). Tells `render_region` whether one camera direction can show the region.
   */
  readonly flatness: number;
  /**
   * Separate patches, largest first. Triangles touching at a corner point join a patch (also across
   * CAD faces). A cut triangle counts as touching its neighbours even if its paint is only inside.
   */
  readonly components: readonly RegionComponent[];
  /** CAD faces the paint is on, most painted area first; faces held as entities are left out. */
  readonly stepFaces: readonly StepFaceCoverage[];
}

type MarkerInput = Pick<MarkerData, 'paint' | 'entities'>;

/**
 * Region summaries for several markers, keyed by marker id (`null` = no paint). Face areas for
 * `coverage` are computed in one pass over the mesh for all markers.
 */
export function analyzeRegions(
  mesh: RegionMesh,
  markers: readonly (MarkerInput & { readonly id: string })[],
): Map<string, RegionSummary | null> {
  const faces = new Set<number>();
  for (const m of markers) for (const f of m.paint.faces) faces.add(f.faceId);
  const areas = faceAreas(mesh, faces);
  return new Map(markers.map((m) => [m.id, analyzeRegion(mesh, m, areas)]));
}

/**
 * Region summary of one marker's paint, or `null` when it has none. `areas` (faceId → mesh area)
 * may be passed in to skip the pass over the mesh; missing faces are computed.
 */
export function analyzeRegion(
  mesh: RegionMesh,
  marker: MarkerInput,
  areas?: ReadonlyMap<number, number>,
): RegionSummary | null {
  const triCount = Math.floor(mesh.indices.length / 3);
  const acc = new Accumulator();
  /** Per painted triangle: its accumulator slot (for components). */
  const painted: number[] = [];
  const parts: Accumulator[] = [];
  const faceArea = new Map<number, number>();

  const add = (t: number, tree: PieceTree | readonly PieceTree[]): void => {
    if (t >= triCount) return;
    const [a, b, c] = corners(mesh, t);
    const n = orientedNormal(mesh, t, a, b, c);
    const part = new Accumulator();
    if (tree === 1) part.addTriangle(a, b, c, n);
    else if (Array.isArray(tree)) walkPieces(tree as readonly PieceTree[], a, b, c, n, part);
    // Zero-area slivers (two corners on one point) carry no paint worth reporting.
    if (part.count === 0 || part.area === 0) return;
    painted.push(t);
    parts.push(part);
    acc.merge(part);
    const f = mesh.triangleFace[t] ?? 0;
    faceArea.set(f, (faceArea.get(f) ?? 0) + part.area);
  };

  for (const face of marker.paint.faces) {
    for (const [first, count] of face.triangles)
      for (let t = first; t < first + count; t++) add(t, 1);
    for (const p of face.pieces ?? []) add(p.triangle, p.tree);
  }
  if (acc.count === 0) return null;

  const held = new Set(marker.entities.filter((e) => e.kind === 'face').map((e) => e.id));
  const missing = [...faceArea.keys()].filter((f) => !held.has(f) && !areas?.has(f));
  const totals = missing.length > 0 ? faceAreas(mesh, missing) : new Map<number, number>();
  const stepFaces = [...faceArea]
    .filter(([f]) => !held.has(f))
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .map(([faceId, a]) => {
      const total = areas?.get(faceId) ?? totals.get(faceId) ?? 0;
      return { faceId, coverage: total > 0 ? Math.min(1, a / total) : 0 };
    });

  const n = acc.normal;
  const len = Math.hypot(n[0], n[1], n[2]);
  return {
    area: acc.area,
    centroid: acc.centroid(),
    bbox: acc.bbox(),
    avgNormal: len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 0, 0],
    flatness: acc.area > 0 ? Math.min(1, len / acc.area) : 0,
    components: components(mesh, painted, parts),
    stepFaces,
  };
}

/** Mesh area per face, for the given faces, in one pass over the triangles. */
export function faceAreas(mesh: RegionMesh, faces: Iterable<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of faces) out.set(f, 0);
  if (out.size === 0) return out;
  const triCount = Math.floor(mesh.indices.length / 3);
  for (let t = 0; t < triCount; t++) {
    const f = mesh.triangleFace[t] ?? 0;
    const sum = out.get(f);
    if (sum === undefined) continue;
    const [a, b, c] = corners(mesh, t);
    out.set(f, sum + length(cross(sub(b, a), sub(c, a))) / 2);
  }
  return out;
}

/** Sums area, area-weighted centre and normal, and the bounding box of painted (sub)triangles. */
class Accumulator {
  area = 0;
  count = 0;
  readonly normal: Vec3 = [0, 0, 0];
  private readonly sum: Vec3 = [0, 0, 0];
  private readonly min: Vec3 = [Infinity, Infinity, Infinity];
  private readonly max: Vec3 = [-Infinity, -Infinity, -Infinity];

  /** `n` = the whole triangle's unit normal (pieces are coplanar with it). */
  addTriangle(a: Vec3, b: Vec3, c: Vec3, n: Vec3): void {
    const area = length(cross(sub(b, a), sub(c, a))) / 2;
    this.area += area;
    this.count++;
    for (let i = 0; i < 3; i++) {
      this.sum[i] = (this.sum[i] ?? 0) + (area * ((a[i] ?? 0) + (b[i] ?? 0) + (c[i] ?? 0))) / 3;
      this.normal[i] = (this.normal[i] ?? 0) + area * (n[i] ?? 0);
      this.min[i] = Math.min(this.min[i] ?? 0, a[i] ?? 0, b[i] ?? 0, c[i] ?? 0);
      this.max[i] = Math.max(this.max[i] ?? 0, a[i] ?? 0, b[i] ?? 0, c[i] ?? 0);
    }
  }

  merge(o: Accumulator): void {
    this.area += o.area;
    this.count += o.count;
    for (let i = 0; i < 3; i++) {
      this.sum[i] = (this.sum[i] ?? 0) + (o.sum[i] ?? 0);
      this.normal[i] = (this.normal[i] ?? 0) + (o.normal[i] ?? 0);
      this.min[i] = Math.min(this.min[i] ?? 0, o.min[i] ?? 0);
      this.max[i] = Math.max(this.max[i] ?? 0, o.max[i] ?? 0);
    }
  }

  /** Area-weighted centre; the bbox centre if all area is zero (degenerate triangles). */
  centroid(): Vec3 {
    if (this.area > 0)
      return [this.sum[0] / this.area, this.sum[1] / this.area, this.sum[2] / this.area];
    return [
      (this.min[0] + this.max[0]) / 2,
      (this.min[1] + this.max[1]) / 2,
      (this.min[2] + this.max[2]) / 2,
    ];
  }

  bbox(): Bbox {
    return { min: [...this.min], max: [...this.max] };
  }
}

/**
 * Painted leaves of a cut triangle's tree. Children: 0 (a, ab, ca), 1 (ab, b, bc), 2 (ca, bc, c),
 * 3 (ab, bc, ca) — the order in the schema / `PaintNode`.
 */
function walkPieces(
  tree: readonly PieceTree[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  n: Vec3,
  out: Accumulator,
): void {
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  const kids: [Vec3, Vec3, Vec3][] = [
    [a, ab, ca],
    [ab, b, bc],
    [ca, bc, c],
    [ab, bc, ca],
  ];
  for (let i = 0; i < 4; i++) {
    const node = tree[i];
    const [p, q, r] = kids[i] as [Vec3, Vec3, Vec3];
    if (node === 1) out.addTriangle(p, q, r, n);
    else if (Array.isArray(node)) walkPieces(node as readonly PieceTree[], p, q, r, n, out);
  }
}

/**
 * Patches of painted triangles that share a corner point. Mesh vertices are not shared between
 * CAD faces, so corners are matched by position (rounded to 1 µm).
 */
function components(
  mesh: RegionMesh,
  painted: readonly number[],
  parts: readonly Accumulator[],
): RegionComponent[] {
  const parent = painted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      const p = parent[parent[i] ?? i] ?? i;
      parent[i] = p;
      i = p;
    }
    return i;
  };
  const owner = new Map<string, number>();
  const p = mesh.positions;
  painted.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const v = (mesh.indices[t * 3 + k] ?? 0) * 3;
      const key = [p[v], p[v + 1], p[v + 2]].map((x) => Math.round((x ?? 0) * 1000)).join(',');
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
      }
    }
  });
  const groups = new Map<number, Accumulator>();
  parts.forEach((part, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = new Accumulator();
      groups.set(r, g);
    }
    g.merge(part);
  });
  return [...groups.values()]
    .sort((x, y) => y.area - x.area)
    .map((g) => ({ area: g.area, centroid: g.centroid(), bbox: g.bbox() }));
}

function corners(mesh: RegionMesh, t: number): [Vec3, Vec3, Vec3] {
  const p = mesh.positions;
  const v = (k: number): Vec3 => {
    const i = (mesh.indices[t * 3 + k] ?? 0) * 3;
    return [p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0];
  };
  return [v(0), v(1), v(2)];
}

/** Unit normal of triangle t, flipped to agree with its vertex normals when the mesh has them. */
function orientedNormal(mesh: RegionMesh, t: number, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const n = cross(sub(b, a), sub(c, a));
  const len = length(n);
  if (len === 0) return [0, 0, 0];
  let sign = 1;
  const vn = mesh.normals;
  if (vn) {
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const i = (mesh.indices[t * 3 + k] ?? 0) * 3;
      d += n[0] * (vn[i] ?? 0) + n[1] * (vn[i + 1] ?? 0) + n[2] * (vn[i + 2] ?? 0);
    }
    if (d < 0) sign = -1;
  }
  return [(sign * n[0]) / len, (sign * n[1]) / len, (sign * n[2]) / len];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function mid(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}
