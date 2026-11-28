import { readFileSync } from 'node:fs';
import { annotationsSchema, toRuns, type Annotations } from '@third-wheel/core';
import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StepModel } from './model.js';
import {
  baseAnnotations,
  checkPair,
  formatReport,
  parseRevisionSet,
  resolveLocator,
  resolveOne,
  type RevisionPair,
  type RevisionSet,
  type TransferResult,
  type TransferStatus,
} from './revision-set.js';
import { importStep } from './step-import.js';
import { transferAnnotations } from './transfer.js';

// The revision test set. The annotation transfer must make every pair "found correctly".
const dir = new URL('../test-data/revisions/', import.meta.url);
const set: RevisionSet = parseRevisionSet(
  JSON.parse(readFileSync(new URL('revisions.json', dir), 'utf8')),
);

let base: StepModel;
let before: Annotations;
const after = new Map<string, StepModel>();

beforeAll(async () => {
  const k = await OcctKernel.init();
  const load = (file: string): StepModel => importStep(k, readFileSync(new URL(file, dir), 'utf8'));
  base = load(set.base);
  before = baseAnnotations(base, set, set.base);
  for (const p of set.pairs) after.set(p.id, load(p.after));
}, 60_000);

const afterOf = (p: RevisionPair): StepModel => {
  const m = after.get(p.id);
  if (!m) throw new Error(`no model for ${p.id}`);
  return m;
};

/** Leaves the annotations as they are and calls everything found: what happens without the transfer. */
function sameIds(): TransferResult {
  return {
    annotations: before,
    status: Object.fromEntries(set.markers.map((m) => [m.id, 'found'])),
  };
}

/** The right answer, built from the key (whole expected faces painted). Checks the checker. */
function fromKey(p: RevisionPair): TransferResult {
  const m = afterOf(p);
  const status: Record<string, TransferStatus> = {};
  const markers = before.markers.map((mk) => {
    const exp = p.expect[mk.id];
    const s = typeof exp?.status === 'string' ? exp.status : (exp?.status[0] ?? 'lost');
    status[mk.id] = s;
    const faces = (exp?.paintOn ?? []).map((l) => resolveOne(m, l));
    return {
      ...mk,
      entities: (exp?.entities ?? []).map((l, seq) => ({
        kind: l.kind,
        id: resolveOne(m, l),
        seq,
      })),
      paint: {
        faces: faces.map((faceId) => {
          const tris: number[] = [];
          for (let t = 0; t < m.triangleFace.length; t++)
            if (m.triangleFace[t] === faceId) tris.push(t);
          return { faceId, triangles: toRuns(tris) };
        }),
      },
    };
  });
  return { annotations: { ...before, markers }, status };
}

describe('revision test set', () => {
  it('has the base part and 8–10 changes (plus an unchanged control)', () => {
    expect(base.bodyNames).toEqual(['Bracket', 'Pin']);
    expect(set.pairs.length).toBeGreaterThanOrEqual(9);
    expect(set.markers.length).toBeGreaterThanOrEqual(6);
  });

  it('finds every marker of the base by its locators, exactly once', () => {
    for (const m of set.markers)
      for (const l of [...m.paint, ...m.entities])
        expect(resolveLocator(base, l), `${m.id} ${JSON.stringify(l)}`).toHaveLength(1);
  });

  it('finds every expected place in each new revision, exactly once', () => {
    for (const p of set.pairs)
      for (const [id, exp] of Object.entries(p.expect))
        for (const l of [...(exp.paintOn ?? []), ...(exp.entities ?? [])])
          expect(resolveLocator(afterOf(p), l), `${p.id} ${id} ${JSON.stringify(l)}`).toHaveLength(
            1,
          );
  });

  it('builds base annotations the app could have saved (paint, samples, fingerprints)', () => {
    const parsed = annotationsSchema.parse(before);
    expect(parsed.markers).toHaveLength(set.markers.length);
    expect(parsed.bodies?.map((b) => b.name)).toEqual(['Bracket', 'Pin']);
    for (const m of parsed.markers) {
      const sm = set.markers.find((x) => x.id === m.id);
      expect(m.paint.faces).toHaveLength(sm?.paint.length ?? -1);
      for (const f of m.paint.faces) {
        expect(f.samples?.length).toBeGreaterThan(0);
        expect(f.fingerprint?.type).toBeTruthy();
      }
      for (const e of m.entities) expect(e.fingerprint?.type).toBeTruthy();
    }
  });

  it('accepts the right answer for every pair (checks the checker)', () => {
    const reports = set.pairs.map((p) => checkPair(afterOf(p), set, p, fromKey(p)));
    expect(formatReport(reports)).not.toContain('✗');
  });

  it('reports what keeping the old ids gets right (the baseline the transfer must beat)', () => {
    const reports = set.pairs.map((p) => checkPair(afterOf(p), set, p, sameIds()));
    // Only the unchanged control passes: every real change breaks some marker.
    expect(reports.filter((r) => r.ok).map((r) => r.pair)).toEqual(['00-unchanged']);
    if (process.env.THIRD_WHEEL_REVISIONS) console.log(formatReport(reports));
  });

  it('the annotation transfer finds every pair correctly', () => {
    const reports = set.pairs.map((p) =>
      checkPair(afterOf(p), set, p, transferAnnotations(before, afterOf(p))),
    );
    if (process.env.THIRD_WHEEL_REVISIONS) console.log(formatReport(reports));
    expect(formatReport(reports)).not.toContain('✗');
    // ~1.3 s on a fast machine; a Windows CI runner needs more than Vitest's 5 s default.
  }, 30_000);
});
