/**
 * Extra GPU data for ID picking, pure. The pick pass reuses the shown model's position and
 * index buffers and adds one id per vertex: faceId per mesh vertex, B-rep vertex points grouped by
 * body (so hidden bodies are skipped like in body-buffers.ts). Edge ids come from body-buffers.
 */
import type { StepModel } from '@third-wheel/geometry';

export interface FacePickIds {
  /** faceId per pick-mesh vertex (float32 for the GPU; exact up to 2^24). */
  readonly faceIds: Float32Array;
  /**
   * Only when some mesh vertex is used by triangles of different faces: the pick mesh then needs
   * its own vertices. `indices` replaces the draw indices (same length and triangle order, so the
   * same draw groups apply); `sourceVertex` maps each pick vertex to its mesh vertex.
   */
  readonly split?: { readonly indices: Uint32Array; readonly sourceVertex: Uint32Array };
}

/**
 * faceId per mesh vertex. `indices`/`triangleOrder` are the draw-order buffers from
 * `buildBodyBuffers`. OCCT meshes each face separately, so normally no vertex is shared between
 * faces; if one is, the shared corners are duplicated per face (`split`).
 */
export function facePickIds(
  indices: Uint32Array,
  triangleOrder: Uint32Array,
  triangleFace: Uint32Array,
  vertexCount: number,
): FacePickIds {
  const UNSET = 0xffffffff;
  const owner = new Uint32Array(vertexCount).fill(UNSET);
  let shared = false;
  for (let t = 0; t < triangleOrder.length; t++) {
    const face = triangleFace[triangleOrder[t] ?? 0] ?? 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] ?? 0;
      const o = owner[v] ?? UNSET;
      if (o === UNSET) owner[v] = face;
      else if (o !== face) shared = true;
    }
  }
  if (!shared) return { faceIds: Float32Array.from(owner, (f) => (f === UNSET ? 0 : f)) };

  // Rare path: keep each vertex for its first face, add a copy per further face.
  const splitIndices = new Uint32Array(indices.length);
  const sourceVertex: number[] = Array.from({ length: vertexCount }, (_, v) => v);
  const faceIds: number[] = Array.from(owner, (f) => (f === UNSET ? 0 : f));
  const copies = new Map<string, number>();
  for (let t = 0; t < triangleOrder.length; t++) {
    const face = triangleFace[triangleOrder[t] ?? 0] ?? 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] ?? 0;
      let p = v;
      if (owner[v] !== face) {
        const key = `${String(v)}:${String(face)}`;
        p = copies.get(key) ?? -1;
        if (p < 0) {
          p = sourceVertex.length;
          sourceVertex.push(v);
          faceIds.push(face);
          copies.set(key, p);
        }
      }
      splitIndices[t * 3 + k] = p;
    }
  }
  return {
    faceIds: Float32Array.from(faceIds),
    split: { indices: splitIndices, sourceVertex: Uint32Array.from(sourceVertex) },
  };
}

export interface VertexPickBuffers {
  /** XYZ per point, grouped by body. */
  readonly points: Float32Array;
  /** B-rep vertex id per point (float32 for the GPU). */
  readonly ids: Float32Array;
  /** Per body b: points [start[b], start[b+1]). Length bodyCount+1. */
  readonly start: Uint32Array;
}

/** B-rep vertices as points grouped by body (counting sort, stable). */
export function vertexPickBuffers(
  model: Pick<StepModel, 'vertexPositions' | 'vertexBody' | 'bodyCount'>,
): VertexPickBuffers {
  const { bodyCount, vertexBody } = model;
  const n = vertexBody.length;
  const start = new Uint32Array(bodyCount + 1);
  for (let v = 0; v < n; v++) {
    const b = vertexBody[v] ?? 0;
    start[b + 1] = (start[b + 1] ?? 0) + 1;
  }
  for (let b = 0; b < bodyCount; b++) start[b + 1] = (start[b + 1] ?? 0) + (start[b] ?? 0);
  const cursor = start.slice(0, bodyCount);
  const points = new Float32Array(n * 3);
  const ids = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const b = vertexBody[v] ?? 0;
    const slot = cursor[b] ?? 0;
    cursor[b] = slot + 1;
    ids[slot] = v;
    points.set(model.vertexPositions.subarray(v * 3, v * 3 + 3), slot * 3);
  }
  return { points, ids, start };
}
