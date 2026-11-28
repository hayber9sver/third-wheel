/**
 * Tangent edge chains: edges that continue smoothly into each other through a shared B-rep
 * vertex (like the boundary of a fillet run). Double-clicking an edge selects its chain, as in
 * Fusion 360. Computed once at import from each edge's end vertices and exact end tangents.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm';

/** Two edge ends count as smooth when their directions differ by at most this angle. */
export const CHAIN_ANGLE_DEG = 1;

/**
 * One edge's ends: vertex ids (-1 = unknown) and the curve's unit tangent at each end, both
 * pointing in the curve's own direction (NaN = unknown: the edge joins nothing).
 */
export interface EdgeEnds {
  readonly vertices: Int32Array; // 2 per edge: [start, end]
  readonly tangents: Float32Array; // 6 per edge: start xyz, end xyz
}

/**
 * Reads each edge's end vertices (exact ids via `vertexIdOf`) and end tangents from the kernel.
 * Degenerate edges (`type` 'other') are left unknown.
 */
export function readEdgeEnds(
  kernel: OcctKernel,
  edges: readonly ShapeHandle[],
  edgeTypes: readonly string[],
  vertexPositions: Float32Array,
  vertexIdOf: (vertex: ShapeHandle) => number,
): EdgeEnds {
  const vertices = new Int32Array(edges.length * 2).fill(-1);
  const tangents = new Float32Array(edges.length * 6).fill(NaN);
  const dist2 = (v: number, p: { x: number; y: number; z: number }): number => {
    const dx = (vertexPositions[v * 3] ?? NaN) - p.x;
    const dy = (vertexPositions[v * 3 + 1] ?? NaN) - p.y;
    const dz = (vertexPositions[v * 3 + 2] ?? NaN) - p.z;
    return dx * dx + dy * dy + dz * dz;
  };
  edges.forEach((edge, e) => {
    if (edgeTypes[e] === 'other') return;
    // The vertex handles below are temporary: free them per edge (they would otherwise stay
    // while the import's shapes are kept for exact measurements).
    const mark = kernel.checkpoint();
    try {
      const ids = kernel
        .getSubShapes(edge, 'vertex')
        .map(vertexIdOf)
        .filter((id) => id >= 0);
      const [a, b = a] = ids;
      if (a === undefined || b === undefined) return;
      const { first, last } = kernel.curveParameters(edge);
      const start = kernel.curvePointAtParam(edge, first);
      // The edge's vertex list need not follow the curve direction: match by position.
      const [v0, v1] = dist2(a, start) <= dist2(b, start) ? [a, b] : [b, a];
      vertices[e * 2] = v0;
      vertices[e * 2 + 1] = v1;
      const t0 = kernel.curveTangent(edge, first);
      const t1 = kernel.curveTangent(edge, last);
      tangents.set([...unit(t0), ...unit(t1)], e * 6);
    } catch {
      // Unknown ends: the edge stays a chain of its own.
    } finally {
      kernel.releaseSince(mark);
    }
  });
  return { vertices, tangents };
}

function unit(v: { x: number; y: number; z: number }): [number, number, number] {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 0 ? [v.x / l, v.y / l, v.z / l] : [NaN, NaN, NaN];
}

/**
 * Chain id per edge (the smallest edge id in its chain). Two edges of the same body join at a
 * shared vertex when one leaves it in the direction the other arrives (within
 * {@link CHAIN_ANGLE_DEG}); chains may branch where several edges meet smoothly.
 */
export function edgeChains(ends: EdgeEnds, edgeBody: Uint32Array): Uint32Array {
  const n = edgeBody.length;
  const parent = new Uint32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    while (parent[i] !== r) {
      const next = parent[i] ?? r;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra < rb) parent[rb] = ra;
    else if (rb < ra) parent[ra] = rb;
  };

  // Edge ends per vertex, with the direction pointing away from the vertex along the edge.
  const atVertex = new Map<number, { edge: number; dir: [number, number, number] }[]>();
  for (let e = 0; e < n; e++) {
    for (const end of [0, 1] as const) {
      const v = ends.vertices[e * 2 + end] ?? -1;
      if (v < 0) continue;
      const o = e * 6 + end * 3;
      const s = end === 0 ? 1 : -1; // at the end vertex the edge leaves backwards
      const dir: [number, number, number] = [
        s * (ends.tangents[o] ?? NaN),
        s * (ends.tangents[o + 1] ?? NaN),
        s * (ends.tangents[o + 2] ?? NaN),
      ];
      if (dir.some(Number.isNaN)) continue;
      const list = atVertex.get(v);
      if (list) list.push({ edge: e, dir });
      else atVertex.set(v, [{ edge: e, dir }]);
    }
  }
  // Smooth: the two edges leave the vertex in opposite directions.
  const limit = -Math.cos((CHAIN_ANGLE_DEG * Math.PI) / 180);
  for (const list of atVertex.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (!a || !b || a.edge === b.edge || edgeBody[a.edge] !== edgeBody[b.edge]) continue;
        const dot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
        if (dot <= limit) union(a.edge, b.edge);
      }
    }
  }
  const chain = new Uint32Array(n);
  for (let i = 0; i < n; i++) chain[i] = find(i);
  return chain;
}

/** Every edge in the chain of `edge` (`edgeChain` from {@link edgeChains}), in id order. */
export function edgesInChain(edgeChain: Uint32Array, edge: number): number[] {
  const id = edgeChain[edge];
  if (id === undefined) return [];
  const out: number[] = [];
  for (let e = 0; e < edgeChain.length; e++) if (edgeChain[e] === id) out.push(e);
  return out;
}
