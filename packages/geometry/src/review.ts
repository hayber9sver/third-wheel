/**
 * Review payload: the compact JSON an AI agent gets for a review (MCP `get_annotations`). Comments first, then only the markers they point at, each with a rounded paint summary
 * (region analysis, @third-wheel/core region.ts) and its held entities with entity info. Never triangles.
 * Long lists are cut, largest first, with a count of what was left out. Target: < 2k tokens for a
 * typical review (a few comments, a few markers). Pure: no kernel calls.
 */
import {
  analyzeRegions,
  commentThread,
  type Annotations,
  type CommentStatus,
  type MarkerData,
  type PartItemData,
  type RegionSummary,
} from '@third-wheel/core';
import { pairDimension, type DimensionKind } from './dimension.js';
import {
  entityInfo,
  faceAreas,
  measure,
  type EntityInfo,
  type EntityRef,
  type InfoModel,
} from './entity-info.js';
import type { StepModel } from './model.js';
import { compact, round, roundV } from './round.js';
import type { V3 } from './vec.js';

/** What the payload needs from a model (a {@link StepModel} has it all). */
export type ReviewModel = InfoModel & Pick<StepModel, 'normals'>;

export interface ReviewOptions {
  /** Comments to include, by status (default: all). Markers follow the comments. */
  readonly statuses?: readonly CommentStatus[];
  /** CAD faces listed per painted marker (default 8). */
  readonly maxFaces?: number;
  /** Separate painted patches listed per marker (default 5). */
  readonly maxPatches?: number;
  /** Held entities listed per marker (default 10). */
  readonly maxEntities?: number;
  /** Latest replies listed per comment (default 10). */
  readonly maxReplies?: number;
}

export interface ReviewComment {
  readonly id: string;
  /** Card number the user sees ("#3": position in the comment list, from 1). */
  readonly n: number;
  readonly text: string;
  readonly status: CommentStatus;
  readonly by: 'human' | 'ai';
  /** Marker ids (see `markers`); empty = a general remark about the model. */
  readonly markers: readonly string[];
  /** Other model files the comment is about, by file name. */
  readonly linkedModels?: readonly string[];
  /**
   * Parts the user asks for (library parts to build with build123d and place), each with its choices
   * and, once the AI has answered, its `result`. Marker ids are in `markers`.
   */
  readonly parts?: readonly PartItemData[];
  /** The thread, oldest first; only the last `maxReplies`. */
  readonly replies?: readonly ReviewReply[];
  /** Earlier replies left out. */
  readonly moreReplies?: number;
  /** When the comment's markers hold exactly two entities: what lies between them. */
  readonly measured?: ReviewMeasured;
}

/**
 * Values between the two entities a comment's markers hold, the numbers the app's Info
 * shows; `main` is the one the app draws as a dimension. mm / degrees, to 0.001.
 */
export interface ReviewMeasured {
  readonly between: readonly [ReviewRef, ReviewRef];
  readonly main?: { readonly kind: DimensionKind; readonly value: number };
  /** Shortest distance; `distanceApprox` = taken from the mesh (curved shapes). */
  readonly distance?: number;
  readonly distanceApprox?: true;
  readonly centreDistance?: number;
  readonly axisDistance?: number;
  readonly planeDistance?: number;
  readonly angle?: number;
  readonly angleBetween?: 'lines' | 'planes' | 'edge-plane' | 'axis-plane';
}
export interface ReviewRef {
  readonly kind: EntityInfo['kind'];
  readonly id: number;
}

export interface ReviewReply {
  readonly by: 'human' | 'ai';
  readonly text: string;
  /** Status the comment was set to with this reply. */
  readonly status?: CommentStatus;
}

/** Entity facts, rounded; fields that don't apply are left out. Lengths mm, angles degrees. */
export interface ReviewEntity {
  readonly kind: EntityInfo['kind'];
  readonly id: number;
  /** Body index; its name is in the payload's `bodies`. */
  readonly body: number;
  readonly type?: string;
  readonly form?: EntityInfo['form'];
  readonly radius?: number;
  readonly minorRadius?: number;
  readonly length?: number;
  /** Circle edges: arc angle, only for partial arcs (missing = full circle). */
  readonly arcAngle?: number;
  readonly halfAngle?: number;
  readonly area?: number;
  /** Vertex position, circle / sphere / torus centre, cone apex, a point on a plane or axis. */
  readonly point?: V3;
  /** Plane normal, line direction, or axis. */
  readonly dir?: V3;
  /** Body: bounding-box size and face count. */
  readonly size?: V3;
  readonly faces?: number;
}

export interface ReviewFace extends ReviewEntity {
  /** Painted share of the face, 0–1. */
  readonly covered: number;
}

export interface ReviewPaint {
  /** Painted area, mm². */
  readonly area: number;
  /** Area-weighted centre of the paint. */
  readonly centre: V3;
  /** Bounding-box size of the paint. */
  readonly size: V3;
  /** Mean surface normal of the paint (unit), and 1 = flat … 0 = facing all ways. */
  readonly normal: V3;
  readonly flatness: number;
  /** Number of separate painted patches. */
  readonly patchCount: number;
  /** The largest patches (only when there is more than one). */
  readonly patches?: readonly { readonly area: number; readonly centre: V3 }[];
  readonly morePatches?: number;
  /** CAD faces under the paint, most painted first. */
  readonly faces: readonly ReviewFace[];
  readonly moreFaces?: number;
}

export interface ReviewMarker {
  readonly id: string;
  readonly name: string;
  readonly paint?: ReviewPaint;
  /** Exact entities the marker holds, in the order they were added. */
  readonly entities?: readonly ReviewEntity[];
  readonly moreEntities?: number;
  /**
   * Set when the marker came over from the previous version and was not found where it was
   *: `changed` (moved / resized, please confirm), `lost` or `check` (mirrored body, not
   * moved). `was` = roughly where it was (lost / check: it holds nothing now).
   */
  readonly transfer?: {
    readonly status: 'changed' | 'lost' | 'check';
    readonly from: string;
    readonly was?: readonly [number, number, number];
  };
}

export interface ReviewPayload {
  readonly model: string;
  /**
   * Full path of the model file on this computer, so the AI can edit it or write the next version
   * beside it. Added by the app (the pure payload builder only knows the file name).
   */
  readonly path?: string;
  readonly units: 'mm';
  /**
   * Set for a mesh file (STL / 3MF): no CAD entities exist, each painted "face" is a whole
   * mesh body (type "mesh"); use the paint's centre / size / normal and patches.
   */
  readonly mesh?: 'stl' | '3mf';
  readonly comments: readonly ReviewComment[];
  readonly markers: readonly ReviewMarker[];
  /** Names of the bodies the listed entities and faces are on, by body index. */
  readonly bodies: Readonly<Record<string, string>>;
}

/** Body names longer than this are cut in the payload (token economy; the sidecar keeps 1000). */
const MAX_PAYLOAD_NAME = 80;
const shortName = (n: string): string =>
  n.length > MAX_PAYLOAD_NAME ? `${n.slice(0, MAX_PAYLOAD_NAME - 1)}…` : n;

/** Positions to 0.01 mm, directions to 1e-3, areas to 0.1 mm². */
const POS = 2;
const DIR = 3;
const AREA = 1;

export function reviewPayload(
  model: ReviewModel,
  doc: Annotations,
  options: ReviewOptions = {},
): ReviewPayload {
  const { statuses, maxFaces = 8, maxPatches = 5, maxEntities = 10, maxReplies = 10 } = options;
  const number = new Map(doc.comments.map((c, i) => [c.id, i + 1]));
  const comments = doc.comments.filter((c) => !statuses || statuses.includes(c.status));
  const byId = new Map(doc.markers.map((m) => [m.id, m]));
  const wanted: MarkerData[] = [];
  for (const c of comments)
    for (const id of c.markerIds) {
      const m = byId.get(id);
      if (m && !wanted.includes(m)) wanted.push(m);
    }

  const regions = analyzeRegions(model, wanted);
  // One mesh pass for the area of every face listed (painted faces and held faces).
  const faceIds = new Set<number>();
  for (const m of wanted) {
    for (const f of (regions.get(m.id)?.stepFaces ?? []).slice(0, maxFaces)) faceIds.add(f.faceId);
    for (const e of m.entities.slice(0, maxEntities)) if (e.kind === 'face') faceIds.add(e.id);
  }
  const areas = faceAreas(model, faceIds);
  const bodies = new Map<number, string>();
  const describe = (kind: EntityInfo['kind'], id: number): ReviewEntity => {
    const e = describeEntity(entityInfo(model, { kind, id }, areas));
    if (e.body >= 0)
      bodies.set(e.body, shortName(model.bodyNames[e.body] ?? `Body ${String(e.body + 1)}`));
    return e;
  };

  const markers = wanted.map((m): ReviewMarker => {
    const region = regions.get(m.id) ?? null;
    const shown = [...m.entities].sort((a, b) => a.seq - b.seq);
    return compact({
      id: m.id,
      name: m.name,
      paint: region ? paintSummary(region, maxFaces, maxPatches, describe) : undefined,
      entities:
        shown.length > 0
          ? shown.slice(0, maxEntities).map((e) => describe(e.kind, e.id))
          : undefined,
      moreEntities: shown.length > maxEntities ? shown.length - maxEntities : undefined,
      transfer: m.transfer ? transferNote(m.transfer) : undefined,
    });
  });

  return {
    model: doc.model.fileName,
    units: 'mm',
    ...(doc.model.format !== 'step' ? { mesh: doc.model.format } : {}),
    comments: comments.map((c) => {
      const thread = commentThread(c);
      const shown = thread.slice(Math.max(0, thread.length - maxReplies));
      return compact({
        id: c.id,
        n: number.get(c.id) ?? 0,
        text: c.text,
        status: c.status,
        by: c.author,
        markers: c.markerIds.filter((id) => byId.has(id)),
        linkedModels: c.linkedModels?.length ? c.linkedModels : undefined,
        parts: c.parts?.length ? c.parts : undefined,
        replies:
          shown.length > 0
            ? shown.map((r) => compact({ by: r.author, text: r.text, status: r.status }))
            : undefined,
        moreReplies: thread.length > shown.length ? thread.length - shown.length : undefined,
        measured: doc.model.format === 'step' ? measuredFor(model, c.markerIds, byId) : undefined,
      });
    }),
    markers,
    bodies: Object.fromEntries(
      [...bodies].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]),
    ),
  };
}

/** Decimals for measured values (0.001 mm / degree). */
const MEASURED = 3;

/** Values between the two entities the given markers hold together, else undefined. */
function measuredFor(
  model: ReviewModel,
  markerIds: readonly string[],
  byId: ReadonlyMap<string, MarkerData>,
): ReviewMeasured | undefined {
  const refs: EntityRef[] = [];
  const seen = new Set<string>();
  for (const id of markerIds)
    for (const e of byId.get(id)?.entities ?? []) {
      const key = `${e.kind}:${String(e.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ kind: e.kind, id: e.id });
    }
  const [a, b] = refs;
  if (!a || !b || refs.length !== 2) return undefined;
  const r = measure(model, a, b);
  const d = pairDimension(model, a, b, r);
  const v = (x: number | undefined) => round(x, MEASURED);
  return compact({
    between: [
      { kind: a.kind, id: a.id },
      { kind: b.kind, id: b.id },
    ] as const,
    main: d && { kind: d.kind, value: v(d.value) ?? 0 },
    distance: v(r.distance?.value),
    distanceApprox: r.distance && !r.distance.exact ? (true as const) : undefined,
    centreDistance: v(r.centreDistance),
    axisDistance: v(r.axisDistance),
    planeDistance: v(r.planeDistance),
    angle: v(r.angle),
    angleBetween: r.angleBetween,
  });
}

function paintSummary(
  r: RegionSummary,
  maxFaces: number,
  maxPatches: number,
  describe: (kind: 'face', id: number) => ReviewEntity,
): ReviewPaint {
  const size: V3 = [
    r.bbox.max[0] - r.bbox.min[0],
    r.bbox.max[1] - r.bbox.min[1],
    r.bbox.max[2] - r.bbox.min[2],
  ];
  return compact({
    area: round(r.area, AREA) ?? 0,
    centre: roundV(r.centroid, POS) ?? [0, 0, 0],
    size: roundV(size, POS) ?? [0, 0, 0],
    normal: roundV(r.avgNormal, DIR) ?? [0, 0, 0],
    flatness: round(r.flatness, 2) ?? 0,
    patchCount: r.components.length,
    morePatches:
      r.components.length > 1 && r.components.length > maxPatches
        ? r.components.length - maxPatches
        : undefined,
    patches:
      r.components.length > 1
        ? r.components.slice(0, maxPatches).map((c) => ({
            area: round(c.area, AREA) ?? 0,
            centre: roundV(c.centroid, POS) ?? [0, 0, 0],
          }))
        : undefined,
    faces: r.stepFaces.slice(0, maxFaces).map((f) => ({
      ...describe('face', f.faceId),
      covered: round(f.coverage, 2) ?? 0,
    })),
    moreFaces: r.stepFaces.length > maxFaces ? r.stepFaces.length - maxFaces : undefined,
  });
}

/** Entity info → payload entry: rounded, one point and one direction, nothing that doesn't apply. */
export function describeEntity(i: EntityInfo): ReviewEntity {
  const size =
    i.bboxMin && i.bboxMax
      ? ([
          i.bboxMax[0] - i.bboxMin[0],
          i.bboxMax[1] - i.bboxMin[1],
          i.bboxMax[2] - i.bboxMin[2],
        ] as V3)
      : undefined;
  return compact({
    kind: i.kind,
    id: i.id,
    body: i.body,
    type: i.type,
    form: i.form,
    radius: round(i.radius, POS),
    minorRadius: round(i.minorRadius, POS),
    length: round(i.length, POS),
    arcAngle:
      i.arcAngle !== undefined && Math.abs(i.arcAngle - 360) > 0.01
        ? round(i.arcAngle, 1)
        : undefined,
    halfAngle: round(i.halfAngle, 2),
    area: round(i.area, AREA),
    point: roundV(i.position ?? i.centre ?? i.apex ?? i.axisPoint ?? i.planePoint ?? i.start, POS),
    dir: roundV(i.normal ?? i.direction ?? i.axis, DIR),
    size: roundV(size, POS),
    faces: i.faceCount,
  });
}

/**
 * The payload of `reviewPayload(…, { statuses })` cut from one made with every status (a
 * model no longer shown keeps its payload, the app has no mesh for it any more). Markers follow
 * the kept comments in first-mention order; bodies follow the kept markers.
 */
export function filterReviewPayload(
  full: ReviewPayload,
  statuses: readonly CommentStatus[],
): ReviewPayload {
  return keepComments(full, (c) => statuses.includes(c.status));
}

/** One comment of a payload with its markers and bodies (a thread reply sent to the agent). */
export function commentPayload(full: ReviewPayload, commentId: string): ReviewPayload {
  return keepComments(full, (c) => c.id === commentId);
}

function keepComments(full: ReviewPayload, keep: (c: ReviewComment) => boolean): ReviewPayload {
  const comments = full.comments.filter(keep);
  const byId = new Map(full.markers.map((m) => [m.id, m]));
  const markers: ReviewMarker[] = [];
  for (const c of comments)
    for (const id of c.markers) {
      const m = byId.get(id);
      if (m && !markers.includes(m)) markers.push(m);
    }
  const used = new Set<string>();
  for (const m of markers) {
    for (const f of m.paint?.faces ?? []) used.add(String(f.body));
    for (const e of m.entities ?? []) used.add(String(e.body));
  }
  const bodies = Object.fromEntries(Object.entries(full.bodies).filter(([k]) => used.has(k)));
  return { ...full, comments, markers, bodies };
}

/** A marker's transfer status for the AI: status, previous file, and the middle of its old place. */
function transferNote(t: NonNullable<MarkerData['transfer']>): ReviewMarker['transfer'] {
  const pts = [
    ...(t.ghost?.faces ?? []).flatMap((f) => f.samples),
    ...(t.ghost?.entities ?? []).flatMap((e) => e.point ?? []),
  ];
  const n = Math.floor(pts.length / 3);
  const sum = [0, 0, 0];
  for (let i = 0; i < n * 3; i++) sum[i % 3] = (sum[i % 3] ?? 0) + (pts[i] ?? 0);
  const was =
    n > 0 ? roundV([(sum[0] ?? 0) / n, (sum[1] ?? 0) / n, (sum[2] ?? 0) / n], POS) : undefined;
  return compact({ status: t.status, from: t.from, was });
}

/** The payload as sent: compact JSON (no indentation; the AI reads it fine). */
export function reviewPayloadText(p: ReviewPayload): string {
  return JSON.stringify(p);
}

/**
 * Rough token count of a payload text: ~3 characters per token for number-heavy JSON (on the safe
 * side of the usual ~4 for prose).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
