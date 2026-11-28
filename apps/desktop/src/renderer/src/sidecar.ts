/**
 * Sidecar ↔ app state. Pure: no DOM, no file access (main reads and writes the file).
 *
 * Paint is stored per marker and CAD face: whole triangles as runs, cut triangles as that marker's
 * 0/1 piece tree, plus per face up to `MAX_SAMPLES` (per marker) surface points spread evenly
 * over the paint and the face's fingerprint, for revision transfer. On load,
 * anything that doesn't fit the model (triangle on another face, id out of range) is dropped and
 * counted instead of refusing the whole file.
 */
import {
  parseAnnotationsJson,
  pushRun,
  SCHEMA_VERSION,
  commentThread,
  type Annotations,
  type BodyFingerprint,
  type BodyTreeData,
  type EntityFingerprint,
  type FacePaint,
  type MarkerData,
  type PieceTree,
} from '@third-wheel/core';
import { paintSamples, type StepModel } from '@third-wheel/geometry';
import type { Comment } from './comments.js';
import type { Marker, MarkerEntity } from './markers.js';
import { PaintRecord, type PaintLayer, type PaintState } from './paint.js';

/** Sample points kept per marker (about 40 KB of JSON at most). */
export const MAX_SAMPLES = 2000;

export type SidecarModel = Pick<
  StepModel,
  | 'tessellation'
  | 'meshFormat'
  | 'positions'
  | 'indices'
  | 'triangleFace'
  | 'bodyCount'
  | 'faceBody'
  | 'edgeBody'
  | 'vertexBody'
>;

export interface SidecarInput {
  readonly fileName: string;
  readonly contentHash: string;
  /** Geometry `meshHash` of the model; left out in tests. */
  readonly meshHash?: string | undefined;
  readonly model: SidecarModel;
  readonly markers: readonly Marker[];
  readonly comments: readonly Comment[];
  readonly paint: PaintLayer;
  /** User folders in the body list; undefined = none. */
  readonly bodyTree?: BodyTreeData | undefined;
  /**
   * Fingerprints for revision matching: every body, and a function giving the held
   * entities' fingerprints (one call for all, so faces share one mesh pass). Left out in tests.
   */
  readonly fingerprints?: {
    readonly bodies: readonly BodyFingerprint[];
    readonly entities: (
      refs: readonly Pick<MarkerEntity, 'kind' | 'id'>[],
    ) => readonly EntityFingerprint[];
  };
}

/** The app state as a sidecar document (the schema in @third-wheel/core). */
export function toAnnotations(input: SidecarInput): Annotations {
  const { model, paint } = input;
  const ids = new Set(input.markers.map((m) => m.id));
  /** Per marker: faceId → paint; triangles to take sample points from (cut ones with their tree). */
  const faces = new Map<string, Map<number, OutFace>>();
  const sampled = new Map<string, { t: number; tree: PieceTree }[]>();
  for (const id of ids) {
    faces.set(id, new Map());
    sampled.set(id, []);
  }
  const faceOf = (markerId: string, faceId: number): OutFace => {
    const byFace = faces.get(markerId) ?? new Map<number, OutFace>();
    let f = byFace.get(faceId);
    if (!f) {
      f = { faceId, triangles: [] };
      byFace.set(faceId, f);
    }
    return f;
  };

  const owner = paint.owner;
  for (let t = 0; t < owner.length; t++) {
    if ((owner[t] ?? 0) === 0) continue;
    const faceId = model.triangleFace[t] ?? 0;
    const whole = paint.markerAt(t);
    if (whole !== undefined) {
      if (!ids.has(whole)) continue;
      pushRun(faceOf(whole, faceId).triangles, t);
      sampled.get(whole)?.push({ t, tree: 1 });
      continue;
    }
    const state = paint.stateAt(t);
    for (const id of markersIn(state)) {
      if (!ids.has(id)) continue;
      const tree = project(state, id);
      if (!Array.isArray(tree)) continue; // never: a cut triangle has mixed pieces
      const f = faceOf(id, faceId);
      (f.pieces ??= []).push({ triangle: t, tree: [...tree] as PieceTreeRoot });
      sampled.get(id)?.push({ t, tree });
    }
  }

  const allEntities = input.markers.flatMap((m) => m.entities);
  // Painted faces get fingerprints too, in the same call (one mesh pass).
  const paintedFaces = [
    ...new Set([...faces.values()].flatMap((byFace) => [...byFace.keys()])),
  ].sort((a, b) => a - b);
  const prints =
    input.fingerprints?.entities([
      ...allEntities,
      ...paintedFaces.map((id) => ({ kind: 'face' as const, id })),
    ]) ?? [];
  const printOf = new Map(allEntities.map((e, i) => [e, prints[i]]));
  const facePrint = new Map(paintedFaces.map((f, i) => [f, prints[allEntities.length + i]]));

  const markers: MarkerData[] = input.markers.map((m) => {
    const samples = paintSamples(model, sampled.get(m.id) ?? [], MAX_SAMPLES);
    const paintFaces = [...(faces.get(m.id)?.values() ?? [])]
      .sort((a, b) => a.faceId - b.faceId)
      .map((f) => {
        const pts = samples.get(f.faceId);
        const fingerprint = facePrint.get(f.faceId);
        return {
          ...f,
          ...(pts?.samples.length ? { samples: pts.samples } : {}),
          ...(pts?.clear.length ? { clear: pts.clear } : {}),
          ...(fingerprint ? { fingerprint } : {}),
        };
      });
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      visible: m.visible,
      entities: m.entities.map((e) => {
        const fingerprint = printOf.get(e);
        return { kind: e.kind, id: e.id, seq: e.seq, ...(fingerprint ? { fingerprint } : {}) };
      }),
      paint: { faces: paintFaces },
      ...(m.transfer ? { transfer: m.transfer } : {}),
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    model: {
      fileName: input.fileName,
      format: model.meshFormat ?? 'step',
      contentHash: input.contentHash,
      ...(input.meshHash ? { meshHash: input.meshHash } : {}),
    },
    // A mesh file's triangles are used as they are: no tessellation settings.
    ...(model.meshFormat ? {} : { tessellation: { ...model.tessellation } }),
    markers,
    comments: input.comments.map((c) => ({
      id: c.id,
      text: c.text,
      // A deleted marker's id stays in the comment for undo; the file only names live ones.
      markerIds: c.markerIds.filter((id) => ids.has(id)),
      status: c.status,
      author: c.author,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      ...(c.linkedModels?.length ? { linkedModels: [...c.linkedModels] } : {}),
      ...(c.replies?.length ? { replies: c.replies.map((r) => ({ ...r })) } : {}),
      ...(c.awaitingConfirm && c.status !== 'open' ? { awaitingConfirm: true as const } : {}),
      // A part aimed at a deleted marker keeps its other markers (the file needs them among the comment's).
      ...(c.parts?.length
        ? {
            parts: c.parts.map((p) => ({
              ...p,
              ...(p.target
                ? {
                    target: {
                      ...p.target,
                      markerIds: p.target.markerIds.filter((id) => ids.has(id)),
                    },
                  }
                : {}),
            })),
          }
        : {}),
    })),
    ...(input.bodyTree ? { bodyTree: input.bodyTree } : {}),
    ...(input.fingerprints ? { bodies: [...input.fingerprints.bodies] } : {}),
  };
}

type OutFace = FacePaint & { triangles: [number, number][] };
type PieceTreeRoot = [PieceTree, PieceTree, PieceTree, PieceTree];

/** Why a sidecar can't be used for this model (it is then backed up and the model starts empty). */
export type SidecarCheck =
  | {
      readonly ok: true;
      readonly doc: Annotations;
      /** Fields this version doesn't know (lost on the next save), as `markers.0.label` paths. */
      readonly droppedFields: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unreadable';
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'other-version';
      readonly detail: string;
      /** The annotations of the other version (carried over or kept for the revision transfer). */
      readonly doc: Annotations;
      readonly droppedFields: readonly string[];
    };

/** Parse a sidecar and check it belongs to exactly this file (hash) and our tessellation. */
export function checkSidecar(text: string, contentHash: string, model: SidecarModel): SidecarCheck {
  const parsed = parseAnnotationsJson(text);
  if (!parsed.ok) {
    return { ok: false, reason: 'unreadable', detail: parsed.errors.slice(0, 3).join('; ') };
  }
  const doc = parsed.data;
  const format = model.meshFormat ?? 'step';
  if (doc.model.format !== format) {
    return { ok: false, reason: 'unreadable', detail: `made for a ${doc.model.format} file` };
  }
  if (doc.model.contentHash !== contentHash) {
    return {
      ok: false,
      reason: 'other-version',
      detail: 'the model file changed',
      doc,
      droppedFields: parsed.droppedFields,
    };
  }
  const tess = doc.tessellation;
  if (model.meshFormat) return { ok: true, doc, droppedFields: parsed.droppedFields };
  if (
    !tess ||
    tess.linearDeflection !== model.tessellation.linearDeflection ||
    tess.angularDeflection !== model.tessellation.angularDeflection
  ) {
    return {
      ok: false,
      reason: 'other-version',
      detail: 'other mesh settings',
      doc,
      droppedFields: parsed.droppedFields,
    };
  }
  return { ok: true, doc, droppedFields: parsed.droppedFields };
}

export interface LoadedAnnotations {
  readonly markers: Marker[];
  readonly comments: Comment[];
  /** Paint per triangle (marker ids; pieces as nested 4-tuples). */
  readonly paint: Map<number, PaintState>;
  /** Triangles, piece trees and entities that didn't fit the model and were left out. */
  readonly dropped: number;
}

/** A checked sidecar document as app state. Items that don't fit the model are dropped (counted). */
export function fromAnnotations(doc: Annotations, model: SidecarModel): LoadedAnnotations {
  const triangleCount = model.triangleFace.length;
  const limits: Record<MarkerEntity['kind'], number> = {
    body: model.bodyCount,
    face: model.faceBody.length,
    edge: model.edgeBody.length,
    vertex: model.vertexBody.length,
  };
  let dropped = 0;
  const paint = new Map<number, PaintState>();
  const onFace = (t: number, faceId: number): boolean =>
    t < triangleCount && model.triangleFace[t] === faceId;

  const markers: Marker[] = doc.markers.map((m) => {
    for (const f of m.paint.faces) {
      for (const [first, count] of f.triangles) {
        // Never walk past the model: a broken count can't loop for long.
        const end = Math.min(first + count, triangleCount);
        dropped += Math.max(0, first + count - Math.max(end, first));
        for (let t = first; t < end; t++) {
          if (onFace(t, f.faceId)) paint.set(t, m.id);
          else dropped++;
        }
      }
      for (const p of f.pieces ?? []) {
        if (!onFace(p.triangle, f.faceId)) {
          dropped++;
          continue;
        }
        paint.set(p.triangle, merge(paint.get(p.triangle), p.tree, m.id));
      }
    }
    // Fingerprints are for revision matching only; the app keeps kind / id / seq.
    const entities = m.entities
      .filter((e) => e.id < limits[e.kind])
      .map((e) => ({ kind: e.kind, id: e.id, seq: e.seq }));
    dropped += m.entities.length - entities.length;
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      visible: m.visible,
      entities,
      ...(m.transfer ? { transfer: m.transfer } : {}),
    };
  });

  const comments: Comment[] = doc.comments.map((c) => {
    // An old single `note` (before threads) becomes the thread's first (AI) reply.
    const replies = commentThread(c);
    return {
      id: c.id,
      text: c.text,
      markerIds: [...c.markerIds],
      status: c.status,
      author: c.author,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      // A hand-edited file may repeat a name.
      ...(c.linkedModels?.length ? { linkedModels: [...new Set(c.linkedModels)] } : {}),
      ...(replies.length > 0 ? { replies } : {}),
      // Only a closed comment can wait for a confirm (a hand-edited file may say otherwise).
      ...(c.awaitingConfirm && c.status !== 'open' ? { awaitingConfirm: true as const } : {}),
      ...(c.parts?.length ? { parts: c.parts } : {}),
    };
  });
  return { markers, comments, paint, dropped };
}

/** Puts loaded paint into a fresh layer (markers must be loaded first: hidden ones stay locked). */
export function applyPaint(layer: PaintLayer, paint: ReadonlyMap<number, PaintState>): void {
  if (paint.size === 0) return;
  const record = new PaintRecord();
  for (const [t, state] of paint) record.note(t, undefined, state);
  layer.restore(record, 'after');
}

/** Marker ids in a paint state. */
function markersIn(state: PaintState, out = new Set<string>()): Set<string> {
  if (typeof state === 'string') out.add(state);
  else if (state !== undefined) for (const s of state) markersIn(s, out);
  return out;
}

/** One marker's share of a cut triangle as a 0/1 tree (alike children merged). */
function project(state: PaintState, id: string): PieceTree {
  if (state === undefined || typeof state === 'string') return state === id ? 1 : 0;
  const kids = [
    project(state[0], id),
    project(state[1], id),
    project(state[2], id),
    project(state[3], id),
  ] as const;
  const [a, b, c, d] = kids;
  if (typeof a === 'number' && a === b && a === c && a === d) return a;
  return kids;
}

/** Adds one marker's piece tree to a triangle's paint (where the tree has 1, the marker wins). */
/** `tree`'s painted parts given to marker `id`, the rest of `state` kept. */
export function merge(state: PaintState, tree: PieceTree, id: string): PaintState {
  if (tree === 0) return state;
  if (tree === 1) return id;
  const kids =
    state === undefined || typeof state === 'string' ? [state, state, state, state] : state;
  return [
    merge(kids[0], tree[0], id),
    merge(kids[1], tree[1], id),
    merge(kids[2], tree[2], id),
    merge(kids[3], tree[3], id),
  ];
}
