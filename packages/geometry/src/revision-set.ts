/**
 * The revision test set: a base part, before/after STEP pairs and an answer key
 * (`test-data/revisions/`, made by `scripts/make-revision-set.js`). This file reads the key,
 * builds the base model's annotations (what the app would save) and checks a transfer result
 * against the key, per pair: "found correctly" or why not. The annotation transfer must pass every pair.
 *
 * Markers are located by geometry ({@link Locator}), never by id: ids change between revisions.
 */
import {
  SCHEMA_VERSION,
  toRuns,
  fromRuns,
  type Annotations,
  type MarkerData,
  type PieceTree,
} from '@third-wheel/core';
import { bodyFingerprints, entityFingerprints } from './fingerprint.js';
import type { StepModel } from './model.js';
import { paintSamples } from './paint-samples.js';
import type { TransferResult, TransferStatus } from './transfer.js';
import { at3, cross, dot, len, sub, type V3 } from './vec.js';

export type { TransferResult, TransferStatus } from './transfer.js';

/** A face or edge found by geometry: of `type`, on the body named `body`, passing through `at`. */
export interface Locator {
  readonly kind: 'face' | 'edge';
  readonly body: string;
  readonly type: string;
  readonly at: readonly [number, number, number];
}

/** A marker of the base model: whole faces painted, entities held. */
export interface SetMarker {
  readonly id: string;
  readonly name: string;
  readonly paint: readonly Locator[];
  readonly entities: readonly Locator[];
}

/** The right answer for one marker in one pair (locators in the AFTER model). */
export interface Expectation {
  /** One status, or several that are all right. */
  readonly status: TransferStatus | readonly TransferStatus[];
  /** At least {@link PAINT_ON_SHARE} of the moved paint's area must lie on these faces. */
  readonly paintOn?: readonly Locator[];
  /** Exactly these entities must be held after the transfer. */
  readonly entities?: readonly Locator[];
}

export interface RevisionPair {
  readonly id: string;
  readonly title: string;
  /** STEP file of the new revision (next to the key). */
  readonly after: string;
  /** By marker id; every marker of the set has one. */
  readonly expect: Readonly<Record<string, Expectation>>;
}

export interface RevisionSet {
  readonly version: 1;
  /** STEP file of the base model (the "before" of every pair). */
  readonly base: string;
  readonly markers: readonly SetMarker[];
  readonly pairs: readonly RevisionPair[];
}

export interface MarkerCheck {
  readonly marker: string;
  readonly ok: boolean;
  /** Why it failed (empty when ok). */
  readonly reason: string;
}

export interface PairReport {
  readonly pair: string;
  readonly ok: boolean;
  readonly markers: readonly MarkerCheck[];
}

/**
 * A locator's point must be this close (mm) to its entity's mesh / polyline. Measured on the
 * tessellation: if the default tessellation changes, rerun the generator / check this still fits.
 */
export const LOCATOR_TOLERANCE = 0.2;
/** Share of the moved paint's area that must land on the expected faces. */
export const PAINT_ON_SHARE = 0.9;
/** Same cap as the app's sidecar writer (`MAX_SAMPLES` in the renderer). */
const MAX_SAMPLES = 2000;

/** Checks the key's shape (it is generated, so only a light check). */
export function parseRevisionSet(json: unknown): RevisionSet {
  const s = json as Partial<RevisionSet>;
  if (s.version !== 1 || typeof s.base !== 'string' || !s.markers || !s.pairs)
    throw new Error('not a revision set (version 1)');
  for (const p of s.pairs)
    for (const m of s.markers)
      if (!(m.id in p.expect)) throw new Error(`${p.id}: no expectation for ${m.id}`);
  return s as RevisionSet;
}

/** All entities `loc` matches (a valid locator matches exactly one). */
export function resolveLocator(m: StepModel, loc: Locator): number[] {
  const bodies = new Set<number>();
  m.bodyNames.forEach((n, b) => {
    if (n === loc.body) bodies.add(b);
  });
  const p: V3 = [loc.at[0], loc.at[1], loc.at[2]];
  const hits: number[] = [];
  if (loc.kind === 'face') {
    const best = new Map<number, number>();
    for (let t = 0; t < m.triangleFace.length; t++) {
      const f = m.triangleFace[t] ?? 0;
      if (!bodies.has(m.faceBody[f] ?? -1) || m.faceTypes[f] !== loc.type) continue;
      const d = pointTriangle(p, ...triangle(m, t));
      if (d < (best.get(f) ?? Infinity)) best.set(f, d);
    }
    for (const [f, d] of best) if (d <= LOCATOR_TOLERANCE) hits.push(f);
  } else {
    for (let e = 0; e < m.edgeTypes.length; e++) {
      if (!bodies.has(m.edgeBody[e] ?? -1) || m.edgeTypes[e] !== loc.type) continue;
      const first = m.edgeRanges[e * 2] ?? 0;
      const count = m.edgeRanges[e * 2 + 1] ?? 0;
      let d = Infinity;
      for (let i = 0; i + 1 < count; i++)
        d = Math.min(
          d,
          pointSegment(p, at3(m.edgePoints, first + i), at3(m.edgePoints, first + i + 1)),
        );
      if (d <= LOCATOR_TOLERANCE) hits.push(e);
    }
  }
  return hits.sort((a, b) => a - b);
}

/** The one entity `loc` matches; throws (with the locator) if none or several. */
export function resolveOne(m: StepModel, loc: Locator): number {
  const hits = resolveLocator(m, loc);
  if (hits.length !== 1 || hits[0] === undefined)
    throw new Error(`locator ${JSON.stringify(loc)} matches ${String(hits.length)} entities`);
  return hits[0];
}

/**
 * The base model's annotations as the app would save them: whole-face paint with sample points
 * (painted triangles' centres), held entities with fingerprints, body fingerprints, and one open
 * comment per marker.
 */
export function baseAnnotations(m: StepModel, set: RevisionSet, fileName: string): Annotations {
  const bodies = bodyFingerprints(m, m.bodyCount);
  let seq = 0;
  const markers: MarkerData[] = set.markers.map((sm, i) => {
    const faces = sm.paint.map((l) => resolveOne(m, l)).sort((a, b) => a - b);
    const refs = sm.entities.map((l) => ({ kind: l.kind, id: resolveOne(m, l) }));
    const prints = entityFingerprints(m, refs, bodies);
    const painted: number[] = [];
    const facePrints = entityFingerprints(
      m,
      faces.map((id) => ({ kind: 'face' as const, id })),
      bodies,
    );
    const tris = faces.map((faceId) => {
      const list: number[] = [];
      for (let t = 0; t < m.triangleFace.length; t++)
        if (m.triangleFace[t] === faceId) list.push(t);
      painted.push(...list);
      return list;
    });
    const samples = paintSamples(
      m,
      painted.map((t) => ({ t, tree: 1 as const })),
      MAX_SAMPLES,
    );
    const paintFaces = faces.map((faceId, k) => {
      const pts = samples.get(faceId);
      const fp = facePrints[k];
      return {
        faceId,
        triangles: toRuns(tris[k] ?? []),
        ...(pts?.samples.length ? { samples: pts.samples } : {}),
        ...(pts?.clear.length ? { clear: pts.clear } : {}),
        ...(fp ? { fingerprint: fp } : {}),
      };
    });
    return {
      id: sm.id,
      name: sm.name,
      color: PALETTE[i % PALETTE.length] ?? '#ff0000',
      visible: true,
      entities: refs.map((r, k) => ({
        ...r,
        seq: seq++,
        ...(prints[k] ? { fingerprint: prints[k] } : {}),
      })),
      paint: { faces: paintFaces },
    };
  });
  const time = '2026-11-09T00:00:00.000Z';
  return {
    schemaVersion: SCHEMA_VERSION,
    model: { fileName, format: 'step', contentHash: `sha256:${'0'.repeat(64)}` },
    tessellation: { ...m.tessellation },
    markers,
    comments: set.markers.map((sm, i) => ({
      id: `c${String(i + 1)}`,
      text: `About: ${sm.name}`,
      markerIds: [sm.id],
      status: 'open' as const,
      author: 'human' as const,
      createdAt: time,
      updatedAt: time,
    })),
    bodies,
  };
}

/** Checks one pair's transfer result against the key ("found correctly" per marker). */
export function checkPair(
  after: StepModel,
  set: RevisionSet,
  pair: RevisionPair,
  result: TransferResult,
): PairReport {
  const markers = set.markers.map((sm): MarkerCheck => {
    const exp = pair.expect[sm.id];
    if (!exp) return { marker: sm.id, ok: false, reason: 'no expectation in the key' };
    const fail = (reason: string): MarkerCheck => ({ marker: sm.id, ok: false, reason });
    const allowed: readonly TransferStatus[] =
      typeof exp.status === 'string' ? [exp.status] : exp.status;
    const got = result.status[sm.id];
    if (!got || !allowed.includes(got))
      return fail(`status ${got ?? 'missing'}, expected ${allowed.join(' or ')}`);
    // Lost / "needs check" markers stay (ghosts) with their comments: never deleted.
    const moved = result.annotations.markers.find((x) => x.id === sm.id);
    if (!moved) return fail('marker missing from the transferred annotations');
    if (!result.annotations.comments.some((c) => c.markerIds.includes(sm.id)))
      return fail('its comment no longer points at it');
    if (got === 'lost' || got === 'check') return { marker: sm.id, ok: true, reason: '' };

    {
      // A marker that held nothing must not pick up entities.
      const want = (exp.entities ?? [])
        .map((l) => `${l.kind}:${String(resolveOne(after, l))}`)
        .sort();
      const have = moved.entities.map((e) => `${e.kind}:${String(e.id)}`).sort();
      if (want.join() !== have.join())
        return fail(`holds [${have.join(', ')}], expected [${want.join(', ')}]`);
    }
    if (exp.paintOn) {
      const on = new Set(exp.paintOn.map((l) => resolveOne(after, l)));
      const { total, onFaces } = paintedArea(after, moved, on);
      if (total <= 0) return fail('no paint after the transfer');
      const share = onFaces / total;
      if (share < PAINT_ON_SHARE)
        return fail(`${(share * 100).toFixed(0)} % of the paint on the expected faces`);
    }
    return { marker: sm.id, ok: true, reason: '' };
  });
  return { pair: pair.id, ok: markers.every((x) => x.ok), markers };
}

/** One line per pair: ✓ / ✗, markers right, and the failures. */
export function formatReport(reports: readonly PairReport[]): string {
  return reports
    .map((r) => {
      const good = r.markers.filter((x) => x.ok).length;
      const bad = r.markers
        .filter((x) => !x.ok)
        .map((x) => `${x.marker}: ${x.reason}`)
        .join('; ');
      return `${r.ok ? '✓' : '✗'} ${r.pair.padEnd(22)} ${String(good)}/${String(r.markers.length)}${bad ? `  ${bad}` : ''}`;
    })
    .join('\n');
}

// --- Helpers -----------------------------------------------------------------------------------

const PALETTE = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#9a6324',
];

function triangle(m: StepModel, t: number): [V3, V3, V3] {
  return [0, 1, 2].map((k) => at3(m.positions, m.indices[t * 3 + k] ?? 0)) as [V3, V3, V3];
}

const triArea = (a: V3, b: V3, c: V3): number => len(cross(sub(b, a), sub(c, a))) / 2;

/** Painted share of a cut triangle (1 = whole). */
function pieceShare(tree: PieceTree): number {
  if (tree === 0 || tree === 1) return tree;
  return tree.reduce<number>((s, c) => s + pieceShare(c), 0) / 4;
}

function paintedArea(
  m: StepModel,
  marker: MarkerData,
  on: ReadonlySet<number>,
): { total: number; onFaces: number } {
  let total = 0;
  let onFaces = 0;
  const add = (t: number, share: number): void => {
    if (t < 0 || t >= m.triangleFace.length) return;
    const a = triArea(...triangle(m, t)) * share;
    total += a;
    if (on.has(m.triangleFace[t] ?? -1)) onFaces += a;
  };
  for (const f of marker.paint.faces) {
    for (const t of fromRuns(f.triangles)) add(t, 1);
    for (const p of f.pieces ?? []) add(p.triangle, pieceShare(p.tree));
  }
  return { total, onFaces };
}

function pointSegment(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const s = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
  return len(sub(p, [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s]));
}

/** Distance from `p` to triangle abc (closest-point regions, Ericson's "Real-Time Collision Detection"). */
function pointTriangle(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return pointSegment(p, a, b);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return pointSegment(p, a, c);
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return pointSegment(p, b, c);
  const n = cross(ab, ac);
  const nl = len(n);
  return nl > 0 ? Math.abs(dot(ap, n)) / nl : len(ap);
}
