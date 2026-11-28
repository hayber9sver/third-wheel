/**
 * Exact measurements from OpenCascade: face / body area, body bounding box and shortest
 * distance, for the values the Info panel otherwise takes from the mesh ("≈"). Needs the B-rep
 * shapes of a loaded model, so the import worker keeps them ({@link KeptShapes}) when asked to.
 * Only for the selection: kernel area costs ~3 ms per face.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import type { EntityRef } from './entity-info.js';
import type { V3 } from './vec.js';

/** What to measure exactly. Ids are the model's entity ids. */
export interface ExactRequest {
  readonly faceAreas: readonly number[];
  readonly bodyAreas: readonly number[];
  readonly bodyBoxes: readonly number[];
  readonly distances: readonly (readonly [EntityRef, EntityRef])[];
}

/** Results in request order (structured-cloneable, so it can cross the worker boundary). */
export interface ExactResult {
  readonly faceAreas: readonly number[];
  readonly bodyAreas: readonly number[];
  readonly bodyBoxes: readonly { readonly min: V3; readonly max: V3 }[];
  /** NaN where OpenCascade could not compute one. */
  readonly distances: readonly number[];
}

/** True if nothing is asked. */
export function isEmptyExactRequest(r: ExactRequest): boolean {
  return r.faceAreas.length + r.bodyAreas.length + r.bodyBoxes.length + r.distances.length === 0;
}

/** Key of an entity pair, order-independent (cache key for distances). */
export function pairKey(a: EntityRef, b: EntityRef): string {
  const ka = `${a.kind}:${String(a.id)}`;
  const kb = `${b.kind}:${String(b.id)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * B-rep handles of one imported model, by entity id. Holds every kernel handle created since
 * `mark` (the import's intermediates too): {@link release} frees them all at once.
 */
export class KeptShapes {
  private released = false;

  constructor(
    private readonly kernel: OcctKernel,
    private readonly mark: number,
    private readonly solids: readonly ShapeHandle[],
    private readonly faces: readonly ShapeHandle[],
    private readonly edges: readonly ShapeHandle[],
    private readonly vertices: readonly ShapeHandle[],
    /** The extra "loose" body (faces / edges / vertices in no solid), if the model has one. */
    private readonly looseBody: ShapeHandle | undefined,
  ) {}

  shape(ref: EntityRef): ShapeHandle {
    if (this.released) throw new Error('The model’s shapes were already released');
    const list =
      ref.kind === 'face'
        ? this.faces
        : ref.kind === 'edge'
          ? this.edges
          : ref.kind === 'vertex'
            ? this.vertices
            : this.solids;
    const s = ref.kind === 'body' && ref.id === this.solids.length ? this.looseBody : list[ref.id];
    if (s === undefined) throw new Error(`No ${ref.kind} ${String(ref.id)} in this model`);
    return s;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.kernel.releaseSince(this.mark);
  }

  /** Answer an {@link ExactRequest}. Temporary kernel handles are freed afterwards. */
  measure(r: ExactRequest): ExactResult {
    const k = this.kernel;
    const mark = k.checkpoint();
    try {
      const area = (ref: EntityRef): number => k.getSurfaceArea(this.shape(ref));
      return {
        faceAreas: r.faceAreas.map((id) => area({ kind: 'face', id })),
        bodyAreas: r.bodyAreas.map((id) => area({ kind: 'body', id })),
        bodyBoxes: r.bodyBoxes.map((id) => {
          const b = k.getBoundingBox(this.shape({ kind: 'body', id }));
          return { min: [b.xmin, b.ymin, b.zmin] as V3, max: [b.xmax, b.ymax, b.zmax] as V3 };
        }),
        distances: r.distances.map(([a, b]) => {
          try {
            return k.distanceBetween(this.shape(a), this.shape(b));
          } catch {
            return NaN;
          }
        }),
      };
    } finally {
      k.releaseSince(mark);
    }
  }
}
