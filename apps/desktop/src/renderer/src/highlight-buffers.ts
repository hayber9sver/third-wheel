/**
 * Geometry for highlighted entities (hover + selection), pure. Faces become a list of
 * indices into the model's vertex buffer (highlighter.ts copies those vertices into its own mesh),
 * edges become line segment pairs, vertices become points. Entities of hidden bodies are left out.
 */
import type { StepModel } from '@third-wheel/geometry';
import type { BoundingSphere } from './camera-views.js';
import type { SelectionItem } from './selection.js';

export type HighlightModel = Pick<
  StepModel,
  | 'positions'
  | 'indices'
  | 'triangleFace'
  | 'faceBody'
  | 'edgePoints'
  | 'edgeRanges'
  | 'edgeBody'
  | 'vertexPositions'
  | 'vertexBody'
>;

/** Triangles grouped by face: face f owns `tris[start[f] .. start[f+1])` (original triangle ids). */
export interface FaceTriangles {
  readonly start: Uint32Array;
  readonly tris: Uint32Array;
}

/** Counting sort of triangles by face (built once per model). */
export function faceTriangles(triangleFace: Uint32Array, faceCount: number): FaceTriangles {
  const start = new Uint32Array(faceCount + 1);
  for (const f of triangleFace) start[f + 1] = (start[f + 1] ?? 0) + 1;
  for (let f = 0; f < faceCount; f++) start[f + 1] = (start[f + 1] ?? 0) + (start[f] ?? 0);
  const cursor = start.slice(0, faceCount);
  const tris = new Uint32Array(triangleFace.length);
  for (let t = 0; t < triangleFace.length; t++) {
    const f = triangleFace[t] ?? 0;
    const slot = cursor[f] ?? 0;
    cursor[f] = slot + 1;
    tris[slot] = t;
  }
  return { start, tris };
}

export interface HighlightBuffers {
  /** Triangle indices into `model.positions` (faces of highlighted faces and bodies). */
  readonly indices: Uint32Array;
  /** XYZ pairs, one pair per line segment of highlighted edges. */
  readonly edgeSegments: Float32Array;
  /** XYZ per highlighted B-rep vertex. */
  readonly points: Float32Array;
  /** XYZ pairs: B-rep edges of highlighted bodies (outline for the see-through "ghost"). */
  readonly outlineSegments: Float32Array;
}

/**
 * Buffers for `items`. A body highlights all its faces. `visible[b] === false` hides body b's
 * entities (missing = visible). Duplicates (a face selected on its own and via its body) appear once.
 */
export function highlightBuffers(
  items: readonly SelectionItem[],
  model: HighlightModel,
  faceTris: FaceTriangles,
  visible: readonly boolean[] = [],
): HighlightBuffers {
  const shown = (body: number | undefined): boolean => visible[body ?? 0] ?? true;
  const faceCount = model.faceBody.length;
  const faceMarked = new Uint8Array(faceCount);
  const faces: number[] = [];
  const addFace = (f: number): void => {
    if (f < 0 || f >= faceCount || faceMarked[f]) return;
    faceMarked[f] = 1;
    faces.push(f);
  };
  const bodies = new Set<number>();
  const edges = new Set<number>();
  const vertices = new Set<number>();
  for (const { kind, id } of items) {
    if (kind === 'body') {
      if (shown(id)) bodies.add(id);
    } else if (kind === 'face') {
      if (id < faceCount && shown(model.faceBody[id])) addFace(id);
    } else if (kind === 'edge') {
      if (id < model.edgeBody.length && shown(model.edgeBody[id])) edges.add(id);
    } else if (id < model.vertexBody.length && shown(model.vertexBody[id])) {
      vertices.add(id);
    }
  }
  if (bodies.size > 0)
    for (let f = 0; f < faceCount; f++) if (bodies.has(model.faceBody[f] ?? -1)) addFace(f);

  let triCount = 0;
  for (const f of faces) triCount += (faceTris.start[f + 1] ?? 0) - (faceTris.start[f] ?? 0);
  const indices = new Uint32Array(triCount * 3);
  let o = 0;
  for (const f of faces) {
    for (let i = faceTris.start[f] ?? 0; i < (faceTris.start[f + 1] ?? 0); i++) {
      const t = faceTris.tris[i] ?? 0;
      indices.set(model.indices.subarray(t * 3, t * 3 + 3), o);
      o += 3;
    }
  }

  const edgeSegments = segmentsOf(edges, model);
  const outlineEdges: number[] = [];
  if (bodies.size > 0)
    for (let e = 0; e < model.edgeBody.length; e++)
      if (bodies.has(model.edgeBody[e] ?? -1)) outlineEdges.push(e);
  const outlineSegments = segmentsOf(outlineEdges, model);

  const points = new Float32Array(vertices.size * 3);
  let p = 0;
  for (const v of vertices) {
    points.set(model.vertexPositions.subarray(v * 3, v * 3 + 3), p);
    p += 3;
  }
  return { indices, edgeSegments, points, outlineSegments };
}

/** Edge polylines → XYZ segment pairs. */
function segmentsOf(edges: Iterable<number>, model: HighlightModel): Float32Array {
  let segCount = 0;
  for (const e of edges) segCount += Math.max(0, (model.edgeRanges[e * 2 + 1] ?? 0) - 1);
  const out = new Float32Array(segCount * 6);
  let s = 0;
  for (const e of edges) {
    const first = model.edgeRanges[e * 2] ?? 0;
    const n = model.edgeRanges[e * 2 + 1] ?? 0;
    for (let i = 0; i + 1 < n; i++) {
      out.set(model.edgePoints.subarray((first + i) * 3, (first + i + 2) * 3), s);
      s += 6;
    }
  }
  return out;
}

/** Vertex indices of import `triangles` (3 per triangle), e.g. painted triangles to frame. */
export function triangleVertexIndices(
  triangles: ArrayLike<number>,
  indices: ArrayLike<number>,
): Uint32Array {
  const out = new Uint32Array(triangles.length * 3);
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i] ?? 0;
    out[i * 3] = indices[t * 3] ?? 0;
    out[i * 3 + 1] = indices[t * 3 + 1] ?? 0;
    out[i * 3 + 2] = indices[t * 3 + 2] ?? 0;
  }
  return out;
}

/**
 * Bounding sphere (of the axis-aligned box) around highlight buffers — for zoom-to-selection.
 * Undefined when they are empty. A single point gives radius 0; the caller sets a minimum.
 */
export function highlightSphere(
  buffers: HighlightBuffers,
  positions: Float32Array,
): BoundingSphere | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const { indices, edgeSegments, points } = buffers;
  if (indices.length + edgeSegments.length + points.length === 0) return undefined;
  const add = (arr: Float32Array, i: number): void => {
    for (let k = 0; k < 3; k++) {
      const c = arr[i * 3 + k] ?? 0;
      if (c < (min[k] ?? 0)) min[k] = c;
      if (c > (max[k] ?? 0)) max[k] = c;
    }
  };
  for (const v of indices) add(positions, v);
  for (let i = 0; i < edgeSegments.length / 3; i++) add(edgeSegments, i);
  for (let i = 0; i < points.length / 3; i++) add(points, i);
  const center: [number, number, number] = [0, 0, 0];
  let r2 = 0;
  for (let k = 0; k < 3; k++) {
    const lo = min[k] ?? 0;
    const hi = max[k] ?? 0;
    center[k] = (lo + hi) / 2;
    r2 += ((hi - lo) / 2) ** 2;
  }
  return { center, radius: Math.sqrt(r2) };
}
