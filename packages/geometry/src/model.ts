/**
 * Result of importing a STEP file: plain typed arrays only, so it can be transferred from the
 * import worker without copying and used by the renderer, picking and the sidecar.
 *
 * Entity ids are indices in OCCT's topology traversal (`getSubShapes` order), never OCCT hashes:
 * the same file always gets the same ids (ADR 001).
 */

/** Tessellation settings. Stored with the result (and later in the sidecar) so meshes are reproducible. */
export interface TessellationSettings {
  /** Maximum chord deviation from the true surface, in mm (absolute). */
  readonly linearDeflection: number;
  /** Maximum angular deviation, in radians. */
  readonly angularDeflection: number;
}

export const DEFAULT_TESSELLATION: TessellationSettings = Object.freeze({
  linearDeflection: 0.1,
  angularDeflection: 0.5,
});

/** Floats per face in {@link StepModel.faceGeometry}. */
export const FACE_GEOMETRY_STRIDE = 8;
/** Floats per edge in {@link StepModel.edgeGeometry}. */
export const EDGE_GEOMETRY_STRIDE = 9;

export interface StepModel {
  readonly tessellation: TessellationSettings;
  /**
   * Set for a mesh file (STL / 3MF): one face per body, no edges or vertices, no entity
   * selection; `tessellation` is then unused (the file's triangles are used as they are).
   */
  readonly meshFormat?: 'stl' | '3mf';

  // --- Triangle mesh (all faces of all bodies in one buffer) ---
  /** XYZ per mesh vertex. */
  readonly positions: Float32Array;
  /** XYZ normal per mesh vertex. */
  readonly normals: Float32Array;
  /** 3 mesh-vertex indices per triangle. */
  readonly indices: Uint32Array;
  /** faceId per triangle. */
  readonly triangleFace: Uint32Array;

  // --- Faces ---
  /** bodyId per face. */
  readonly faceBody: Uint32Array;
  /** OCCT surface type per face (`plane`, `cylinder`, …). */
  readonly faceTypes: readonly string[];
  /**
   * Exact analytic geometry per face, {@link FACE_GEOMETRY_STRIDE} floats: [dx dy dz, px py pz, a, b].
   * NaN where a value does not apply (and everywhere for B-spline and other free-form faces).
   * - plane: d = outward normal, p = a point on the face
   * - cylinder: d = axis, p = point on the axis, a = radius, b = +1 shaft/boss, −1 hole
   * - cone: d = axis (apex → wide end), p = apex, a = half-angle (rad), b = +1 / −1 as cylinder
   * - sphere: p = centre, a = radius, b = +1 ball, −1 hollow
   * - torus: d = axis, p = centre, a = major radius, b = minor radius
   */
  readonly faceGeometry: Float32Array;

  // --- Edges ---
  /** XYZ points of all edge polylines, concatenated. */
  readonly edgePoints: Float32Array;
  /** Per edge: [first point index, point count]. Count 0 = nothing to draw (degenerate edge). */
  readonly edgeRanges: Uint32Array;
  /** bodyId per edge (an edge shared by several solids belongs to the first). */
  readonly edgeBody: Uint32Array;
  /** OCCT curve type per edge (`line`, `circle`, …). */
  readonly edgeTypes: readonly string[];
  /**
   * Exact geometry per edge, {@link EDGE_GEOMETRY_STRIDE} floats:
   * [dx dy dz, px py pz, length, radius, arc angle]. NaN where a value does not apply.
   * - every edge with a curve: length (mm, exact)
   * - line: d = direction (start → end), p = start
   * - circle / arc: d = axis (normal of the circle's plane), p = centre, radius, arc angle (rad, 2π = full)
   */
  readonly edgeGeometry: Float32Array;
  /**
   * Tangent chain id per edge (the smallest edge id in the chain): edges of one body that
   * continue smoothly into each other through shared vertices (`edge-chain.ts`). Double-click
   * on an edge selects its chain.
   */
  readonly edgeChain: Uint32Array;

  // --- Vertices ---
  /** XYZ per B-rep vertex. */
  readonly vertexPositions: Float32Array;
  /** bodyId per B-rep vertex (a vertex shared by several solids belongs to the first). */
  readonly vertexBody: Uint32Array;

  // --- Bodies ---
  /** Number of bodies. Bodies are solid instances; faces/edges in no solid share one extra "loose" body at the end. */
  readonly bodyCount: number;
  /** True if the last body collects faces/edges that belong to no solid (surface models). */
  readonly hasLooseBody: boolean;
  /**
   * Display name per body: the part name from the STEP assembly tree ("M3 screw [2]" when several
   * bodies share a name), else "Body N"; the loose body is "Loose surfaces".
   */
  readonly bodyNames: readonly string[];
  /** Enclosing assemblies per body, outermost first, joined with " › " ("" if none / unknown). */
  readonly bodyPaths: readonly string[];
  /**
   * Named assembly instances from the STEP tree, parents before children (`parent` = -1 at the top).
   * Two copies of the same sub-assembly are two entries. Empty when names are unknown.
   */
  readonly assemblies: readonly { readonly name: string; readonly parent: number }[];
  /** Innermost enclosing assembly per body (index into `assemblies`), -1 = none (e.g. loose body). */
  readonly bodyAssembly: Int32Array;

  readonly stats: ImportStats;
}

export interface ImportStats {
  /** Wall time per stage, ms. */
  readonly timings: Readonly<Record<ImportStage, number>>;
  /** Groups whose OCCT hash matched several entities; resolved by traversal order (see step-import.ts). */
  readonly hashCollisions: number;
  /** Edges without a polyline that are not degenerate — logged, should be 0. */
  readonly unexplainedEdgesWithoutPolyline: readonly number[];
  /** False if the assembly tree didn't line up with the bodies, so placeholder names are used. */
  readonly partNamesMatched: boolean;
}

export type ImportStage = 'read' | 'topology' | 'mesh' | 'edges' | 'info';

/** Stage order and rough share of total time (from the kernel spike measurements), for a progress bar. */
export const IMPORT_STAGES: readonly { stage: ImportStage; label: string; weight: number }[] = [
  { stage: 'read', label: 'Reading STEP', weight: 0.7 },
  { stage: 'topology', label: 'Building topology', weight: 0.03 },
  { stage: 'mesh', label: 'Meshing faces', weight: 0.22 },
  { stage: 'edges', label: 'Tracing edges', weight: 0.02 },
  { stage: 'info', label: 'Reading entity geometry', weight: 0.03 },
];

/** Fraction done (0–1) when `stage` starts. */
export function progressAtStageStart(stage: ImportStage): number {
  let done = 0;
  for (const s of IMPORT_STAGES) {
    if (s.stage === stage) return done;
    done += s.weight;
  }
  return done;
}

/** All typed arrays of a model, for `postMessage` transfer lists. */
export function transferablesOf(model: StepModel): ArrayBuffer[] {
  return [
    model.positions,
    model.normals,
    model.indices,
    model.triangleFace,
    model.faceBody,
    model.faceGeometry,
    model.edgePoints,
    model.edgeRanges,
    model.edgeBody,
    model.edgeGeometry,
    model.edgeChain,
    model.vertexPositions,
    model.vertexBody,
    model.bodyAssembly,
  ].map((a) => a.buffer as ArrayBuffer);
}
