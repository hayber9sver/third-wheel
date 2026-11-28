/**
 * STEP → {@link StepModel} with occt-wasm. Runs synchronously; call it inside the import worker
 * (`import-worker.ts`) so the UI stays responsive.
 *
 * Ids are traversal indices from `getSubShapes`. OCCT's hashes are only used to join the mesh /
 * wireframe groups back to those indices *within this load* (ADR 001).
 */
import type { OcctKernel, ShapeHandle, XCAFDocument } from 'occt-wasm';
import { readEdgeGeometry, readFaceGeometry } from './analytic.js';
import { edgeChains, readEdgeEnds } from './edge-chain.js';
import {
  DEFAULT_TESSELLATION,
  EDGE_GEOMETRY_STRIDE,
  FACE_GEOMETRY_STRIDE,
  type ImportStage,
  type StepModel,
  type TessellationSettings,
} from './model.js';
import { KeptShapes } from './exact.js';
import { bodyDisplayNames, readPartInfo } from './part-names.js';

/** Upper bound for `hashCode`; must match the one occt-wasm uses for faceGroups / edgeGroups. */
const HASH_BOUND = 2 ** 31 - 1;
/** Edges shorter than this (mm) count as degenerate. */
const DEGENERATE_LENGTH = 1e-6;

export interface ImportOptions {
  readonly tessellation?: TessellationSettings;
  /** Called when a stage starts. */
  readonly onStage?: (stage: ImportStage) => void;
  /** Progress inside a stage (0–1); only the mesh stage reports it (one step per body). */
  readonly onStageProgress?: (stage: ImportStage, fraction: number) => void;
  /**
   * Keep the B-rep shapes for exact measurements instead of freeing them: called once on
   * success. The caller must `release()` them (before the next import, at the latest).
   */
  readonly keep?: (kept: KeptShapes) => void;
}

/** OpenCascade's WASM heap cannot grow past this (32-bit memory). */
const WASM_HEAP_LIMIT_GB = 4;

const STAGE_VERB: Record<ImportStage, string> = {
  read: 'reading the STEP file',
  topology: 'building the topology',
  mesh: 'meshing',
  edges: 'tracing edges',
  info: 'reading entity geometry',
};

/** True for the errors a full WASM heap (or a failed allocation) produces. */
export function isOutOfMemory(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /memory access out of bounds|out of memory|Cannot enlarge memory|Aborted\(OOM\)|std::bad_alloc|Array buffer allocation failed|Invalid (typed )?array length/i.test(
    text,
  );
}

/** User-facing message for an import that ran out of memory during `stage`. */
export function outOfMemoryMessage(stage: ImportStage): string {
  return (
    `The model is too large: OpenCascade ran out of memory (${String(WASM_HEAP_LIMIT_GB)} GB limit) ` +
    `while ${STAGE_VERB[stage]}. Try exporting only the sub-assembly you need, or leave out ` +
    `repeated hardware such as screws.`
  );
}

/**
 * Maps OCCT hashes → our ids. Several entities can share a 31-bit hash (likely on large
 * assemblies: ~25k edges); then the k-th group with that hash gets the k-th id in traversal
 * order, since occt-wasm emits groups in the same topology order.
 */
class HashIndex {
  private readonly ids = new Map<number, number[]>();
  private readonly cursor = new Map<number, number>();

  constructor(kernel: OcctKernel, shapes: readonly ShapeHandle[]) {
    // Also used per body (mesh stage), with `shapes` = that body's faces.
    shapes.forEach((s, id) => {
      const hash = kernel.hashCode(s, HASH_BOUND);
      const list = this.ids.get(hash);
      if (list) list.push(id);
      else this.ids.set(hash, [id]);
    });
  }

  /** Number of hashes shared by more than one entity. */
  get collisions(): number {
    let n = 0;
    for (const list of this.ids.values()) if (list.length > 1) n++;
    return n;
  }

  candidates(hash: number): readonly number[] {
    return this.ids.get(hash) ?? [];
  }

  /** Next id for a group with this hash (see class comment), or -1 if unknown. */
  take(hash: number): number {
    const list = this.ids.get(hash);
    if (!list) return -1;
    const k = this.cursor.get(hash) ?? 0;
    this.cursor.set(hash, k + 1);
    // More groups than entities with this hash: the order assumption broke — fail loudly
    // instead of silently shifting ids.
    if (k >= list.length)
      throw new Error(`more groups than entities for OCCT hash ${String(hash)}`);
    return list[k] ?? -1;
  }
}

/** Import a STEP file. Throws if the file can't be read or the id maps are inconsistent. */
export function importStep(
  kernel: OcctKernel,
  data: ArrayBuffer | string,
  options: ImportOptions = {},
): StepModel {
  const tessellation = options.tessellation ?? DEFAULT_TESSELLATION;
  const timings: Record<ImportStage, number> = {
    read: 0,
    topology: 0,
    mesh: 0,
    edges: 0,
    info: 0,
  };
  let stageStart = 0;
  let current: ImportStage | undefined;
  const stage = (next: ImportStage): void => {
    const now = performance.now();
    if (current) timings[current] = Math.round(now - stageStart);
    current = next;
    stageStart = now;
    options.onStage?.(next);
  };

  const mark = kernel.checkpoint();
  let kept = false;
  let doc: XCAFDocument | undefined;
  try {
    stage('read');
    // The XCAF reader gives the same shape as `importStep` (checked on the samples: identical
    // solids/faces/edges/vertices in the same order) plus the assembly tree with part names —
    // so the file is parsed only once.
    doc = kernel.importXCAFFromSTEP(
      typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data),
    );
    const roots = doc
      .getRoots()
      .map((r) => doc?.getLabelInfo(r).shapeHandle)
      .filter((s): s is ShapeHandle => s != null);
    const [first] = roots;
    if (first === undefined) throw new Error('STEP file contains no shapes');
    const shape = roots.length === 1 ? first : kernel.makeCompound(roots);

    // --- Topology: ids = traversal index ---
    stage('topology');
    const solids = kernel.getSubShapes(shape, 'solid');
    const faces = kernel.getSubShapes(shape, 'face');
    const edges = kernel.getSubShapes(shape, 'edge');
    const vertices = kernel.getSubShapes(shape, 'vertex');
    const faceIndex = new HashIndex(kernel, faces);
    const edgeIndex = new HashIndex(kernel, edges);
    const vertexIndex = new HashIndex(kernel, vertices);

    const UNSET = 0xffffffff;
    const faceBody = new Uint32Array(faces.length).fill(UNSET);
    const edgeBody = new Uint32Array(edges.length).fill(UNSET);
    const vertexBody = new Uint32Array(vertices.length).fill(UNSET);
    /**
     * Mark every sub-shape of `solid` found in `all` with `bodyId` (first solid wins). Returns
     * the solid's sub-shapes and their ids in `all` (-1 if not found).
     */
    const assign = (
      solid: ShapeHandle,
      kind: 'face' | 'edge' | 'vertex',
      all: readonly ShapeHandle[],
      index: HashIndex,
      out: Uint32Array,
      bodyId: number,
    ): { subs: ShapeHandle[]; ids: number[] } => {
      const subs = kernel.getSubShapes(solid, kind);
      const ids = subs.map((sub) => {
        // Exact match among hash candidates: we hold both handles here.
        for (const id of index.candidates(kernel.hashCode(sub, HASH_BOUND))) {
          const candidate = all[id];
          if (candidate !== undefined && kernel.isSame(candidate, sub)) {
            if (out[id] === UNSET) out[id] = bodyId;
            return id;
          }
        }
        return -1;
      });
      return { subs, ids };
    };
    /** Per solid: its faces and their face ids, for the per-body mesh below. */
    const solidFaces = solids.map((solid, bodyId) => {
      const result = assign(solid, 'face', faces, faceIndex, faceBody, bodyId);
      assign(solid, 'edge', edges, edgeIndex, edgeBody, bodyId);
      assign(solid, 'vertex', vertices, vertexIndex, vertexBody, bodyId);
      return result;
    });
    // Faces/edges/vertices in no solid (surface models, free wires) go to one extra "loose" body.
    const hasLooseBody =
      faceBody.includes(UNSET) || edgeBody.includes(UNSET) || vertexBody.includes(UNSET);
    const bodyCount = solids.length + (hasLooseBody ? 1 : 0);
    for (const arr of [faceBody, edgeBody, vertexBody])
      for (let i = 0; i < arr.length; i++) if (arr[i] === UNSET) arr[i] = solids.length;
    const tree = readPartInfo(kernel, doc, solids);
    const parts = tree?.parts ?? null;
    if (!parts && solids.length > 0)
      console.warn('STEP import: assembly tree does not match the bodies; using "Body N" names');
    const bodyNames = bodyDisplayNames(parts, bodyCount, hasLooseBody);
    const bodyPaths = Array.from({ length: bodyCount }, (_, id) =>
      (parts?.[id]?.path ?? []).join(' › '),
    );
    const assemblies = tree?.assemblies ?? [];
    const bodyAssembly = Int32Array.from(
      { length: bodyCount },
      (_, id) => parts?.[id]?.assembly ?? -1,
    );

    // --- Mesh: one body at a time ---
    // Meshing the whole assembly in one kernel call builds one huge result inside the 4 GB WASM
    // heap and runs out of memory on large assemblies (a 3k-body printer assembly hit 4 GB within
    // seconds); per body, the heap does not grow at all.
    stage('mesh');
    const looseFaceIds: number[] = [];
    faceBody.forEach((body, id) => {
      if (body === solids.length) looseFaceIds.push(id);
    });
    const meshParts: { shape: ShapeHandle; faces: ShapeHandle[]; ids: number[]; body: number }[] =
      solidFaces.map((f, body) => ({
        shape: solids[body] as ShapeHandle,
        faces: f.subs,
        ids: f.ids,
        body,
      }));
    if (looseFaceIds.length > 0) {
      const looseFaces = looseFaceIds.map((id) => faces[id] as ShapeHandle);
      meshParts.push({
        shape: looseFaceIds.length === faces.length ? shape : kernel.makeCompound(looseFaces),
        faces: looseFaces,
        ids: looseFaceIds,
        body: solids.length,
      });
    }
    const chunks: {
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      faces: Uint32Array;
    }[] = [];
    let vertexTotal = 0;
    let triangleTotal = 0;
    meshParts.forEach((part, n) => {
      const mesh = kernel.meshShape(part.shape, {
        linearDeflection: tessellation.linearDeflection,
        angularDeflection: tessellation.angularDeflection,
      });
      const local = new HashIndex(kernel, part.faces);
      const groups = mesh.faceGroups ?? new Int32Array();
      // Triangles of faces this body owns (a face shared with an earlier solid is skipped).
      const keep: number[] = [];
      const keepFace: number[] = [];
      for (let g = 0; g + 2 < groups.length; g += 3) {
        // occt-wasm counts index entries (3 per triangle), not triangles.
        const start = (groups[g] ?? 0) / 3;
        const count = (groups[g + 1] ?? 0) / 3;
        const faceId = part.ids[local.take(groups[g + 2] ?? 0)] ?? -1;
        if (faceId < 0)
          throw new Error(
            `mesh group ${String(g / 3)} of body ${String(part.body)} matches no face`,
          );
        if (faceBody[faceId] !== part.body) continue;
        keep.push(start, count);
        keepFace.push(faceId);
      }
      let grouped = 0;
      for (let g = 1; g < groups.length; g += 3) grouped += (groups[g] ?? 0) / 3;
      if (grouped !== mesh.triangleCount)
        throw new Error(
          `body ${String(part.body)}: ${String(mesh.triangleCount - grouped)} triangles belong to no face`,
        );
      let kept = 0;
      for (let k = 1; k < keep.length; k += 2) kept += keep[k] ?? 0;
      const indices = new Uint32Array(kept * 3);
      const triFaces = new Uint32Array(kept);
      let t = 0;
      for (let k = 0; k < keepFace.length; k++) {
        const start = keep[k * 2] ?? 0;
        const count = keep[k * 2 + 1] ?? 0;
        for (let i = start * 3; i < (start + count) * 3; i++)
          indices[t * 3 + i - start * 3] = (mesh.indices[i] ?? 0) + vertexTotal;
        triFaces.fill(keepFace[k] ?? 0, t, t + count);
        t += count;
      }
      chunks.push({ positions: mesh.positions, normals: mesh.normals, indices, faces: triFaces });
      vertexTotal += mesh.positions.length / 3;
      triangleTotal += kept;
      options.onStageProgress?.('mesh', (n + 1) / meshParts.length);
    });
    const positions = new Float32Array(vertexTotal * 3);
    const normals = new Float32Array(vertexTotal * 3);
    const indices = new Uint32Array(triangleTotal * 3);
    const triangleFace = new Uint32Array(triangleTotal);
    let vOff = 0;
    let tOff = 0;
    for (const c of chunks) {
      positions.set(c.positions, vOff * 3);
      normals.set(c.normals, vOff * 3);
      indices.set(c.indices, tOff * 3);
      triangleFace.set(c.faces, tOff);
      vOff += c.positions.length / 3;
      tOff += c.faces.length;
    }
    chunks.length = 0;

    // --- Edges: polylines from the face triangulation, so they sit exactly on the mesh ---
    stage('edges');
    const wire = kernel.wireframe(shape, { source: 'triangulation' });
    const edgeRanges = new Uint32Array(edges.length * 2);
    const wg = wire.edgeGroups;
    for (let g = 0; g + 2 < wg.length; g += 3) {
      const edgeId = edgeIndex.take(wg[g + 2] ?? 0);
      if (edgeId < 0) throw new Error(`edge polyline ${String(g / 3)} matches no edge`);
      // occt-wasm counts floats; we store point indices.
      edgeRanges[edgeId * 2] = (wg[g] ?? 0) / 3;
      edgeRanges[edgeId * 2 + 1] = (wg[g + 1] ?? 0) / 3;
    }

    // --- Entity info ---
    stage('info');
    const faceTypes = faces.map((f) => kernel.surfaceType(f));
    const edgeTypes = edges.map((e) => kernel.curveType(e));
    const faceGeometry = new Float32Array(faces.length * FACE_GEOMETRY_STRIDE);
    faces.forEach((f, i) => {
      readFaceGeometry(kernel, f, faceTypes[i] ?? '', faceGeometry, i);
    });
    const edgeGeometry = new Float32Array(edges.length * EDGE_GEOMETRY_STRIDE);
    edges.forEach((e, i) => {
      readEdgeGeometry(kernel, e, edgeTypes[i] ?? '', edgeGeometry, i);
    });
    const vertexPositions = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => {
      const p = kernel.vertexPosition(v);
      vertexPositions.set([p.x, p.y, p.z], i * 3);
    });
    const vertexIdOf = (sub: ShapeHandle): number => {
      for (const id of vertexIndex.candidates(kernel.hashCode(sub, HASH_BOUND))) {
        const candidate = vertices[id];
        if (candidate !== undefined && kernel.isSame(candidate, sub)) return id;
      }
      return -1;
    };
    const edgeChain = edgeChains(
      readEdgeEnds(kernel, edges, edgeTypes, vertexPositions, vertexIdOf),
      edgeBody,
    );
    // Degenerate edges have nothing to draw: no curve (sphere poles, cone apexes → type 'other')
    // or zero length (seen: a 3e-13 mm circle in a real assembly).
    const unexplainedEdgesWithoutPolyline: number[] = [];
    edgeTypes.forEach((type, id) => {
      if (edgeRanges[id * 2 + 1] !== 0 || type === 'other') return;
      // NaN (length unreadable) also counts as degenerate.
      if (!((edgeGeometry[id * EDGE_GEOMETRY_STRIDE + 6] ?? NaN) >= DEGENERATE_LENGTH)) return;
      unexplainedEdgesWithoutPolyline.push(id);
    });
    if (unexplainedEdgesWithoutPolyline.length > 0) {
      console.warn(
        'STEP import: non-degenerate edges without polyline:',
        unexplainedEdgesWithoutPolyline.map((id) => ({ id, type: edgeTypes[id] })),
      );
    }
    timings.info = Math.round(performance.now() - stageStart);

    if (options.keep) {
      const loose = (body: Uint32Array, all: readonly ShapeHandle[]): ShapeHandle[] =>
        all.filter((_, id) => body[id] === solids.length);
      const looseBody = hasLooseBody
        ? kernel.makeCompound([
            ...loose(faceBody, faces),
            ...loose(edgeBody, edges),
            ...loose(vertexBody, vertices),
          ])
        : undefined;
      options.keep(new KeptShapes(kernel, mark, solids, faces, edges, vertices, looseBody));
      kept = true;
    }

    return {
      tessellation: { ...tessellation },
      positions,
      normals,
      indices,
      triangleFace,
      faceBody,
      faceTypes,
      faceGeometry,
      edgePoints: wire.points,
      edgeRanges,
      edgeBody,
      edgeTypes,
      edgeGeometry,
      edgeChain,
      vertexPositions,
      vertexBody,
      bodyCount,
      hasLooseBody,
      bodyNames,
      bodyPaths,
      assemblies,
      bodyAssembly,
      stats: {
        timings,
        hashCollisions: faceIndex.collisions + edgeIndex.collisions,
        unexplainedEdgesWithoutPolyline,
        partNamesMatched: parts !== null,
      },
    };
  } catch (err) {
    if (current && isOutOfMemory(err)) {
      // The trap text is generic (a kernel bug can look the same): keep the original visible.
      console.error('STEP import failed with an out-of-memory-like error:', err);
      throw new Error(outOfMemoryMessage(current), { cause: err });
    }
    throw err;
  } finally {
    doc?.close();
    if (!kept) kernel.releaseSince(mark);
  }
}
