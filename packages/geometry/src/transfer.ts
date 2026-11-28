/**
 * Annotation transfer: moves a sidecar's markers onto a new revision of the model, after
 * the geometry changed and ids no longer apply. Works from the old sidecar alone (the old model
 * may be gone): body fingerprints, held entities' fingerprints, and per-face paint samples and
 * fingerprints. Pure. Rules and tolerances: below.
 *
 * 1. Bodies: by name, then by size (area + sorted bbox sides within 10 %), the nearest wins.
 * 2. Per body, the old markers are lined up with the new body: kept in place, or moved / turned in
 *    90° steps onto the new bounding box, whichever puts most of them back on the surface. A
 *    mirror that fits better than any turn → the body's markers are "check" (never moved).
 * 3. Held entities: same type within the "found" distance; else one candidate within the
 *    "changed" distance, or the same entity shifted (moved with a side of the bounding box, or the
 *    only one of that type, size and direction) → changed; else lost.
 * 4. Paint: each face's samples go to the nearest surface of the same type and direction; found
 *    when most land within the "found" distance, changed when they land within the "changed" one
 *    or the face shifted as in 3. New triangles near the landed points are painted.
 */
import {
  type Annotations,
  type MarkerData,
  type MarkerEntityData,
  type PaintPieces,
  type MarkerTransfer,
  type EntityFingerprint,
  toRuns,
  type MeshCoverage,
} from '@third-wheel/core';
import type { InfoModel } from './entity-info.js';
import type { StepModel } from './model.js';
import { bodyFingerprints } from './fingerprint.js';
import { type V3, at3, sub, len } from './vec.js';
import {
  align,
  type Alignment,
  every,
  matchBodies,
  matchEntity,
  remapBodyTree,
} from './transfer-match.js';
import {
  apply,
  Context,
  IDENTITY,
  moveFp,
  rot,
  round3,
  SIGNED_PERMS,
  type Transform,
} from './transfer-model.js';
import { movePaint, rebuildPaint, spacing } from './transfer-paint.js';

/** Public: the package exports it from here. */
export { matchBodies } from './transfer-match.js';

/**
 * Per marker: `found` in the same place; `changed`
 * moved or resized (flagged for the user); `lost` gone (kept as a ghost with its comments);
 * `check` not mapped on purpose (a mirrored body).
 */
export type TransferStatus = 'found' | 'changed' | 'lost' | 'check';

/** The annotations for the new model + a status per marker id. */
export interface TransferResult {
  readonly annotations: Annotations;
  readonly status: Readonly<Record<string, TransferStatus>>;
}

export type TransferModel = InfoModel & Pick<StepModel, 'bodyCount'>;

/** "Found" distance: max(0.5 mm, 1 % of the body's largest side). */
export const FOUND_MM = 0.5;
export const FOUND_SHARE = 0.01;
/** "Changed" distance: max(5 mm, 5 % of the body's largest side). */
export const CHANGED_MM = 5;
export const CHANGED_SHARE = 0.05;
/** Bodies match by size when area and sorted bbox sides are within this share. */
export const SIZE_SHARE = 0.1;
/** Directions agree within 10°. */
export const COS_DIR = Math.cos((10 * Math.PI) / 180);
/** Paint samples tried per face when lining up a body (keeps it quick). */
export const PROBE_SAMPLES = 48;
/** Moves `old` (a sidecar of an earlier version) onto `m`. Comments are kept as they are. */
export function transferAnnotations(old: Annotations, m: TransferModel): TransferResult {
  const newBodies = bodyFingerprints(m, m.bodyCount);
  const ctx = new Context(m, newBodies);
  const oldBodies = old.bodies;
  const bodyMap = matchBodies(oldBodies, newBodies);
  // Re-placed ghost entities get new `seq`s above every saved one.
  let seq = Math.max(0, ...old.markers.flatMap((mk) => mk.entities.map((e) => e.seq + 1)));

  // Items per old body (to line each body up once, with all its markers).
  const items = old.markers.map((mk) => markerItems(mk));
  const aligns = new Map<number, Alignment>();
  let legacy: Alignment | undefined;
  const alignOf = (oldBody: number | undefined): Alignment | undefined => {
    if (oldBody === undefined)
      return (legacy ??= { body: ctx.body(-1), t: IDENTITY, mirrored: false, oldBox: undefined });
    const nb = bodyMap.get(oldBody);
    if (nb === undefined) return undefined;
    let a = aligns.get(oldBody);
    if (!a) {
      a = align(ctx.body(nb), oldBodies?.[oldBody], items, oldBody);
      aligns.set(oldBody, a);
    }
    return a;
  };
  /** Body index on the new model for a ghost (none when its body has no match). */
  const newBody = (a: Alignment | undefined): number | undefined =>
    a && a.body.index >= 0 ? a.body.index : undefined;

  const status: Record<string, TransferStatus> = {};
  const markers = old.markers.map((mk, i): MarkerData => {
    const it = items[i] ?? { groups: [], entities: [] };
    const statuses: TransferStatus[] = [];
    const entities: MarkerEntityData[] = [];
    const ghostFaces: GhostFace[] = [];
    const ghostEntities: GhostEntity[] = [];
    const wasCheck = mk.transfer?.status === 'check';
    /**
     * Whether an item may be placed with alignment `a`: never across a mirror — except the parts of
     * a "check" marker (left at their mirrored place), which are placed when mirrored back.
     */
    const placeable = (a: Alignment, ghost: boolean): boolean =>
      ghost && wasCheck ? a.mirrored : !a.mirrored;
    const missed = (a: Alignment | undefined, ghost: boolean): TransferStatus =>
      a && !placeable(a, ghost) ? 'check' : 'lost';
    for (const e of it.entities) {
      const a = alignOf(e.body);
      const got = a && placeable(a, e.ghost) ? matchEntity(e, a) : undefined;
      if (got) {
        // Two old entities may land on one new one: the marker holds it once.
        if (!entities.some((x) => x.kind === e.kind && x.id === got.id))
          entities.push({ kind: e.kind, id: got.id, seq: e.ghost ? seq++ : e.seq });
        // Back after being lost / mirrored: the user checks where it landed.
        statuses.push(e.ghost ? 'changed' : got.status);
      } else {
        statuses.push(missed(a, e.ghost));
        if (e.fp) {
          const fp = moveFp(e.fp, a?.t ?? IDENTITY, newBody(a));
          ghostEntities.push({ ...fp, kind: e.kind });
        }
      }
    }
    const paintFaces = new Map<number, { whole: number[]; pieces: PaintPieces[] }>();
    for (const g of it.groups) {
      const a = alignOf(g.body);
      const got = a && placeable(a, g.ghost) ? movePaint(g, a) : undefined;
      if (got) {
        statuses.push(g.ghost ? 'changed' : got.status);
        for (const [face, add] of got.faces) {
          const f = paintFaces.get(face) ?? { whole: [], pieces: [] };
          f.whole.push(...add.whole);
          f.pieces.push(...add.pieces);
          paintFaces.set(face, f);
        }
      } else {
        statuses.push(missed(a, g.ghost));
        const t = a?.t ?? IDENTITY;
        ghostFaces.push(
          compactFace({
            samples: g.samples.flatMap((p) => round3(apply(t, p))),
            clear: g.clear.flatMap((p) => round3(apply(t, p))),
            fingerprint: g.fp && moveFp(g.fp, t, newBody(a)),
          }),
        );
      }
    }
    // Paint saved without any sample points can't be placed: lost, never silently "found".
    if (it.groups.length === 0 && mk.paint.faces.length > 0) statuses.push('lost');
    let s = combine(statuses);
    // Flagged before and not confirmed yet: still for the user to check.
    if (s === 'found' && mk.transfer) s = 'changed';
    status[mk.id] = s;
    const ghost =
      ghostFaces.length + ghostEntities.length > 0
        ? {
            ...(ghostFaces.length > 0 ? { faces: ghostFaces } : {}),
            ...(ghostEntities.length > 0 ? { entities: ghostEntities } : {}),
          }
        : undefined;
    const transfer: MarkerTransfer | undefined =
      s === 'found'
        ? undefined
        : {
            status: s,
            // The version it was last placed by the user on.
            from: mk.transfer?.from ?? old.model.fileName,
            ...(ghost ? { ghost } : {}),
          };
    return {
      id: mk.id,
      name: mk.name,
      color: mk.color,
      visible: mk.visible,
      entities,
      paint: { faces: facePaint(paintFaces) },
      ...(transfer ? { transfer } : {}),
    };
  });

  const bodyTree = remapBodyTree(old.bodyTree, bodyMap, m.bodyCount);
  return {
    annotations: {
      ...old,
      markers,
      ...(bodyTree ? { bodyTree } : {}),
      bodies: newBodies,
    },
    status,
  };
}

/** What `placeGhost` put on the model, and what it still couldn't place. */
export interface PlacedGhost {
  readonly entities: readonly { readonly kind: MarkerEntityData['kind']; readonly id: number }[];
  /** New paint only (the marker's own paint is left to the caller). */
  readonly paint: MarkerData['paint']['faces'];
  /** Parts still not placed (undefined: everything was). */
  readonly ghost: MarkerTransfer['ghost'];
}

/**
 * "✓ Place here" on a "? Check" marker: its ghost — already moved to
 * where the mirrored body puts it, as drawn — is placed on the model as it is (no turn, no mirror
 * rule): paint rebuilt from its points, entities matched by fingerprint, as in the transfer.
 */
export function placeGhost(
  ghost: NonNullable<MarkerTransfer['ghost']>,
  m: TransferModel,
): PlacedGhost {
  const ctx = new Context(m, bodyFingerprints(m, m.bodyCount));
  const at = (body: number | undefined): Alignment => ({
    body: ctx.body(body !== undefined && body >= 0 && body < m.bodyCount ? body : -1),
    t: IDENTITY,
    mirrored: false,
    oldBox: undefined,
  });
  const it = markerItems({
    id: '',
    name: '',
    color: '',
    visible: true,
    entities: [],
    paint: { faces: [] },
    transfer: { status: 'check', from: '', ghost },
  });
  const entities: { kind: MarkerEntityData['kind']; id: number }[] = [];
  const ghostEntities: GhostEntity[] = [];
  for (const e of it.entities) {
    const got = matchEntity(e, at(e.body));
    if (got) {
      if (!entities.some((x) => x.kind === e.kind && x.id === got.id))
        entities.push({ kind: e.kind, id: got.id });
    } else if (e.fp) ghostEntities.push({ ...e.fp, kind: e.kind });
  }
  const paintFaces = new Map<number, { whole: number[]; pieces: PaintPieces[] }>();
  const ghostFaces: GhostFace[] = [];
  for (const g of it.groups) {
    const got = movePaint(g, at(g.body));
    if (!got) {
      ghostFaces.push(
        compactFace({
          samples: g.samples.flatMap((p) => round3(p)),
          clear: g.clear.flatMap((p) => round3(p)),
          fingerprint: g.fp,
        }),
      );
      continue;
    }
    for (const [face, add] of got.faces) {
      const f = paintFaces.get(face) ?? { whole: [], pieces: [] };
      f.whole.push(...add.whole);
      f.pieces.push(...add.pieces);
      paintFaces.set(face, f);
    }
  }
  const left =
    ghostFaces.length + ghostEntities.length > 0
      ? {
          ...(ghostFaces.length > 0 ? { faces: ghostFaces } : {}),
          ...(ghostEntities.length > 0 ? { entities: ghostEntities } : {}),
        }
      : undefined;
  return { entities, paint: facePaint(paintFaces), ghost: left };
}

type GhostFace = NonNullable<NonNullable<MarkerTransfer['ghost']>['faces']>[number];
type GhostEntity = NonNullable<NonNullable<MarkerTransfer['ghost']>['entities']>[number];

function compactFace(f: {
  samples: number[];
  clear: number[];
  fingerprint: EntityFingerprint | undefined;
}): GhostFace {
  return {
    samples: f.samples,
    ...(f.clear.length > 0 ? { clear: f.clear } : {}),
    ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
  };
}

/** Paint per face for the sidecar: whole triangles as runs, cut ones as pieces. */
function facePaint(
  faces: ReadonlyMap<number, { whole: number[]; pieces: PaintPieces[] }>,
): MarkerData['paint']['faces'] {
  return [...faces]
    .sort((a, b) => a[0] - b[0])
    .map(([faceId, f]) => {
      const whole = [...new Set(f.whole)].sort((a, b) => a - b);
      const taken = new Set(whole);
      const pieces = f.pieces.filter((p) => !taken.has(p.triangle) && taken.add(p.triangle));
      return {
        faceId,
        triangles: toRuns(whole),
        ...(pieces.length > 0 ? { pieces: pieces.sort((a, b) => a.triangle - b.triangle) } : {}),
      };
    });
}

// --- Marker items ------------------------------------------------------------------------------

export interface EntityItem {
  readonly kind: MarkerEntityData['kind'];
  readonly seq: number;
  readonly fp: EntityFingerprint | undefined;
  /** Old body index (fingerprint `body`); undefined = unknown. */
  readonly body: number | undefined;
  /** From the marker's ghost (not placed on the previous version). */
  readonly ghost: boolean;
}

export interface PaintGroup {
  readonly samples: readonly V3[];
  /** Points just outside the paint (none in older sidecars). */
  readonly clear: readonly V3[];
  readonly fp: EntityFingerprint | undefined;
  readonly body: number | undefined;
  readonly ghost: boolean;
}

function markerItems(mk: MarkerData): { groups: PaintGroup[]; entities: EntityItem[] } {
  const entities = mk.entities.map((e): EntityItem => ({
    kind: e.kind,
    seq: e.seq,
    fp: e.fingerprint,
    body: e.kind === 'body' ? (e.fingerprint?.body ?? e.id) : e.fingerprint?.body,
    ghost: false,
  }));
  const groups: PaintGroup[] = [];
  for (const f of mk.paint.faces) {
    if (!f.samples?.length) continue;
    groups.push({
      samples: points(f.samples),
      clear: points(f.clear ?? []),
      fp: f.fingerprint,
      body: f.fingerprint?.body,
      ghost: false,
    });
  }
  // Older sidecars: one list of triangle centres for the whole marker, no face or body.
  if (groups.length === 0 && mk.paint.samples?.length)
    groups.push({
      samples: points(mk.paint.samples),
      clear: [],
      fp: undefined,
      body: undefined,
      ghost: false,
    });
  // What could not be placed on the previous version is tried again.
  for (const e of mk.transfer?.ghost?.entities ?? [])
    entities.push({
      kind: e.kind,
      seq: 0,
      fp: e,
      body: e.kind === 'body' ? e.body : e.body,
      ghost: true,
    });
  for (const f of mk.transfer?.ghost?.faces ?? [])
    groups.push({
      samples: points(f.samples),
      clear: points(f.clear ?? []),
      fp: f.fingerprint,
      body: f.fingerprint?.body,
      ghost: true,
    });
  return { groups, entities };
}

const points = (flat: readonly number[]): V3[] => {
  const out: V3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push(at3(flat, i / 3));
  return out;
};

function combine(s: readonly TransferStatus[]): TransferStatus {
  if (s.length === 0 || s.every((x) => x === 'found')) return 'found';
  if (s.includes('check')) return 'check';
  if (s.every((x) => x === 'lost')) return 'lost';
  return 'changed';
}

// --- Mesh → STEP ------------------------------------------------------------------------

export interface MeshTransferResult extends TransferResult {
  readonly coverage: MeshCoverage;
}

/** Mesh surface points tried per turn when lining the files up. */
const MESH_PROBES = 1500;
/** A mirror must fit this share of the probes better than the best turn. */
const MIRROR_MARGIN = 0.02;

/**
 * Moves the annotations of a mesh file (STL / 3MF, mesh-only mode) onto a STEP model of the
 * same part. The two files may lie differently (an STL is often turned Y-up and moved), so
 * the whole mesh is lined up with the whole STEP model first: each of the 24 turns in 90° steps
 * that fits the bounding box (mirrors only when clearly better) is scored by how many mesh points
 * land on the STEP surface, then the position is nudged until the surfaces sit on each other. One
 * transform for the file (parts moved apart on a slicer plate are not lined up one by one).
 * Then each painted sample goes to the nearest STEP triangle, on any face (a stroke may cross
 * many CAD faces), and the paint is rebuilt from the landed points as in `transferAnnotations`.
 * Per marker: found when ≥ 80 % of its points land within the "found" distance, changed when
 * ≥ 50 % land within the "changed" distance, else lost (a ghost where the mesh put it).
 *
 * `mesh` = the mesh file's own triangles (a better fit); without it the paint points and the
 * sidecar's body boxes are all there is.
 */
export function transferMeshAnnotations(
  old: Annotations,
  m: TransferModel,
  mesh?: { readonly positions: ArrayLike<number>; readonly indices: ArrayLike<number> },
): MeshTransferResult {
  const newBodies = bodyFingerprints(m, m.bodyCount);
  const ctx = new Context(m, newBodies);
  const whole = ctx.body(-1);
  const tol = whole.tolFound;
  const items = old.markers.map((mk) => markerItems(mk));
  const paintPoints = items.flatMap((it) => it.groups.flatMap((g) => [...g.samples, ...g.clear]));

  // The mesh file's box and the points used to line it up.
  let box: { lo: V3; hi: V3 } | undefined;
  let probes: V3[];
  if (mesh && mesh.indices.length >= 3) {
    box = boundsOf(mesh.positions);
    const n = Math.floor(mesh.indices.length / 3);
    const step = Math.max(1, Math.floor(n / MESH_PROBES));
    probes = [];
    for (let t = 0; t < n; t += step) {
      const a = at3(mesh.positions, mesh.indices[t * 3] ?? 0);
      const b = at3(mesh.positions, mesh.indices[t * 3 + 1] ?? 0);
      const c = at3(mesh.positions, mesh.indices[t * 3 + 2] ?? 0);
      probes.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
    }
  } else {
    // The box around the sidecar's body boxes.
    const corners: number[] = [];
    for (const b of old.bodies ?? [])
      for (const s of [-0.5, 0.5])
        corners.push(...b.centre.map((c, i) => c + s * (b.size[i] ?? 0)));
    box = boundsOf(corners);
    probes = every(paintPoints, MESH_PROBES);
  }

  const any = (): boolean => true;
  const fitOf = (t: Transform): number => {
    let n = 0;
    for (const p of probes) if (whole.nearest(apply(t, p), tol, any)) n++;
    return n;
  };
  let t: Transform | undefined;
  let mirrored = false;
  if (box && probes.length > 0) {
    const size: V3 = sub(box.hi, box.lo);
    const from: V3 = [
      (box.lo[0] + box.hi[0]) / 2,
      (box.lo[1] + box.hi[1]) / 2,
      (box.lo[2] + box.hi[2]) / 2,
    ];
    const fits = (r: readonly number[]): boolean =>
      rot(r, size)
        .map(Math.abs)
        .every((s, i) => {
          const n = whole.size[i] ?? 0;
          return Math.abs(s - n) <= Math.max(tol, SIZE_SHARE * Math.max(s, n));
        });
    let turn: { t: Transform; fit: number } | undefined;
    let mirror: { t: Transform; fit: number } | undefined;
    for (const { r, det } of SIGNED_PERMS) {
      if (!fits(r)) continue;
      const c = { t: { r, from, to: whole.centre }, fit: 0 };
      c.fit = fitOf(c.t);
      if (det > 0) {
        if (!turn || c.fit > turn.fit) turn = c;
      } else if (!mirror || c.fit > mirror.fit) mirror = c;
    }
    const margin = MIRROR_MARGIN * probes.length;
    if (mirror && (!turn || mirror.fit > turn.fit + margin)) {
      t = mirror.t;
      mirrored = true;
    } else t = turn?.t;
    // Nudge: the mean offset of probes to their nearest STEP point (boxes differ a little when
    // the mesh was exported with another chord error or the part changed slightly).
    let fitNow = t ? fitOf(t) : 0;
    for (let k = 0; t && k < 4; k++) {
      const cur: Transform = t;
      const off = [0, 0, 0];
      let n = 0;
      for (const p of probes) {
        const q = apply(cur, p);
        const h = whole.nearest(q, whole.tolChanged, any);
        if (!h) continue;
        for (let i = 0; i < 3; i++) off[i] = (off[i] ?? 0) + ((h.q[i] ?? 0) - (q[i] ?? 0));
        n++;
      }
      if (n === 0) break;
      const d: V3 = [(off[0] ?? 0) / n, (off[1] ?? 0) / n, (off[2] ?? 0) / n];
      if (len(d) < 1e-4) break;
      const moved: Transform = {
        ...cur,
        to: [cur.to[0] + d[0], cur.to[1] + d[1], cur.to[2] + d[2]],
      };
      const fitMoved = fitOf(moved);
      if (fitMoved < fitNow) break;
      t = moved;
      fitNow = fitMoved;
    }
  }
  const surface = t && probes.length > 0 ? fitOf(t) / probes.length : 0;

  let points = 0;
  let matched = 0;
  const status: Record<string, TransferStatus> = {};
  const markers = old.markers.map((mk, i): MarkerData => {
    const it = items[i] ?? { groups: [], entities: [] };
    const samples = it.groups.flatMap((g) => g.samples.map((p) => (t ? apply(t, p) : p)));
    const clear = it.groups.flatMap((g) => g.clear.map((p) => (t ? apply(t, p) : p)));
    const gap = spacing(it.groups.flatMap((g) => g.samples));
    points += samples.length;
    let s: TransferStatus;
    let faces = new Map<number, { whole: number[]; pieces: PaintPieces[] }>();
    if (samples.length === 0) s = mk.paint.faces.length > 0 ? 'lost' : 'found';
    else if (!t) s = 'lost';
    else {
      const hits = samples.flatMap((p) => {
        const h = whole.nearest(p, whole.tolChanged, any);
        return h ? [h] : [];
      });
      const near = hits.filter((h) => h.d <= tol).length;
      if (!mirrored) matched += near; // a mirror paints nothing
      s =
        near >= 0.8 * samples.length
          ? 'found'
          : hits.length >= 0.5 * samples.length
            ? 'changed'
            : 'lost';
      if (mirrored) s = 'check';
      else if (s !== 'lost') {
        const keep = new Set(hits.map((h) => h.face));
        // A mesh's clear points may lie past a CAD edge (the mesh is one face): only those
        // whose nearest STEP face took paint mark where it ends.
        const neg = clear.flatMap((p) => {
          const h = whole.nearest(p, whole.tolChanged, any);
          return h && keep.has(h.face) ? [h.q] : [];
        });
        faces = rebuildPaint(
          whole,
          keep,
          hits.map((h) => h.q),
          neg,
          gap,
        );
      }
    }
    status[mk.id] = s;
    const ghostFaces =
      s === 'lost' || s === 'check'
        ? it.groups.map((g) =>
            compactFace({
              samples: g.samples.flatMap((p) => round3(t ? apply(t, p) : p)),
              clear: g.clear.flatMap((p) => round3(t ? apply(t, p) : p)),
              fingerprint: undefined,
            }),
          )
        : [];
    const transfer: MarkerTransfer | undefined =
      s === 'found'
        ? undefined
        : {
            status: s,
            from: mk.transfer?.from ?? old.model.fileName,
            ...(ghostFaces.length > 0 ? { ghost: { faces: ghostFaces } } : {}),
          };
    return {
      id: mk.id,
      name: mk.name,
      color: mk.color,
      visible: mk.visible,
      // A mesh holds no entities (mesh-only mode).
      entities: [],
      paint: { faces: facePaint(faces) },
      ...(transfer ? { transfer } : {}),
    };
  });
  // The mesh's body list (one row per mesh body) doesn't fit the STEP's: the STEP's own is used.
  const annotations: Annotations = { ...old, markers, bodies: newBodies };
  delete annotations.bodyTree;
  return {
    annotations,
    status,
    coverage: {
      points,
      matched,
      surface,
      toleranceMm: Math.round(tol * 1000) / 1000,
      mirrored,
      meshRead: mesh !== undefined && mesh.indices.length >= 3,
    },
  };
}

function boundsOf(pos: ArrayLike<number>): { lo: V3; hi: V3 } | undefined {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    const k = i % 3;
    const v = pos[i] ?? 0;
    if (v < (lo[k] ?? 0)) lo[k] = v;
    if (v > (hi[k] ?? 0)) hi[k] = v;
  }
  return lo.every(Number.isFinite) ? { lo, hi } : undefined;
}
