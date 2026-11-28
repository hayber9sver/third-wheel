import { readFileSync } from 'node:fs';
import {
  fromRuns,
  type Annotations,
  type MarkerData,
  type PieceTree,
  SCHEMA_VERSION,
} from '@third-wheel/core';
import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { bodyFingerprints, entityFingerprints } from './fingerprint.js';
import type { StepModel } from './model.js';
import { paintSamples, type PaintedTriangle } from './paint-samples.js';
import { resolveOne, type Locator } from './revision-set.js';
import { importStep } from './step-import.js';
import { transferAnnotations, type TransferStatus } from './transfer.js';
import { at3, cross, len, sub, type V3 } from './vec.js';

// A real-use sequence: a brush stroke on the plate's top and the end top edge,
// moved base → 01 fillet → 08 rotated → 09 mirrored → 00 back, saved in between as the app does.
// The paint must keep its size (it grew on every version before), and the edge must come back
// once the fillet is gone.
const dir = new URL('../test-data/revisions/', import.meta.url);
const models = new Map<string, StepModel>();
const model = (f: string): StepModel => {
  const m = models.get(f);
  if (!m) throw new Error(f);
  return m;
};

beforeAll(async () => {
  const k = await OcctKernel.init();
  for (const f of ['base', '01-fillet', '08-rotated', '09-mirrored', '00-unchanged'])
    models.set(f, importStep(k, readFileSync(new URL(`${f}.step`, dir), 'utf8')));
}, 60_000);

const corners = (m: StepModel, t: number): [V3, V3, V3] => [
  at3(m.positions, m.indices[t * 3] ?? 0),
  at3(m.positions, m.indices[t * 3 + 1] ?? 0),
  at3(m.positions, m.indices[t * 3 + 2] ?? 0),
];
const area = (a: V3, b: V3, c: V3): number => len(cross(sub(b, a), sub(c, a))) / 2;
const half = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** A brush dab: pieces of the face's triangles whose centre is within `r` of `c` (depth 7). */
function dab(m: StepModel, face: number, c: V3, r: number): PaintedTriangle[] {
  const tree = (a: V3, b: V3, d: V3, depth: number): PieceTree => {
    const cen: V3 = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3];
    const far = Math.max(len(sub(a, cen)), len(sub(b, cen)), len(sub(d, cen)));
    const dc = len(sub(cen, c));
    if (dc - far > r) return 0;
    if (dc + far <= r) return 1;
    if (depth >= 7) return dc <= r ? 1 : 0;
    const ab = half(a, b);
    const bc = half(b, d);
    const ca = half(d, a);
    const k = [
      tree(a, ab, ca, depth + 1),
      tree(ab, b, bc, depth + 1),
      tree(ca, bc, d, depth + 1),
      tree(ab, bc, ca, depth + 1),
    ] as const;
    if (k.every((x) => x === 0)) return 0;
    if (k.every((x) => x === 1)) return 1;
    return k;
  };
  const out: PaintedTriangle[] = [];
  for (let t = 0; t < m.triangleFace.length; t++) {
    if (m.triangleFace[t] !== face) continue;
    const tr = tree(...corners(m, t), 0);
    if (tr !== 0) out.push({ t, tree: tr });
  }
  return out;
}

function shareOf(tree: PieceTree): number {
  if (tree === 0 || tree === 1) return tree;
  return tree.reduce<number>((s, k) => s + shareOf(k), 0) / 4;
}

function paintedOf(mk: MarkerData): PaintedTriangle[] {
  return mk.paint.faces.flatMap((f) => [
    ...[...fromRuns(f.triangles)].map((t) => ({ t, tree: 1 as const })),
    ...(f.pieces ?? []).map((p) => ({ t: p.triangle, tree: p.tree })),
  ]);
}

const paintedArea = (m: StepModel, mk: MarkerData): number =>
  paintedOf(mk).reduce((s, p) => s + area(...corners(m, p.t)) * shareOf(p.tree), 0);

/** The doc as the app would save it for `m` (fresh samples, clear points, fingerprints). */
function save(doc: Annotations, m: StepModel, fileName: string): Annotations {
  const bodies = bodyFingerprints(m, m.bodyCount);
  return {
    ...doc,
    model: { fileName, format: 'step', contentHash: `sha256:${'0'.repeat(64)}` },
    bodies,
    markers: doc.markers.map((mk) => {
      const samples = paintSamples(m, paintedOf(mk), 2000);
      const faces = mk.paint.faces.map((f) => f.faceId);
      const facePrints = entityFingerprints(
        m,
        faces.map((id) => ({ kind: 'face' as const, id })),
        bodies,
      );
      const prints = entityFingerprints(m, mk.entities, bodies);
      return {
        ...mk,
        entities: mk.entities.map((e, i) => ({ ...e, fingerprint: prints[i] })),
        paint: {
          faces: mk.paint.faces.map((f, i) => ({
            ...f,
            samples: samples.get(f.faceId)?.samples ?? [],
            clear: samples.get(f.faceId)?.clear ?? [],
            fingerprint: facePrints[i],
          })),
        },
      };
    }),
  };
}

const loc = (
  type: string,
  at: [number, number, number],
  kind: 'face' | 'edge' = 'edge',
): Locator => ({
  kind,
  body: 'Bracket',
  type,
  at,
});

describe('moving a brush stroke and an edge through several versions', () => {
  it(
    'keeps the stroke’s size and brings the edge back after the fillet',
    { timeout: 60_000 },
    () => {
      const base = model('base');
      const top = resolveOne(base, loc('plane', [45, 10, 6], 'face'));
      const edge = resolveOne(base, loc('line', [80, 20, 6]));
      const stroke = dab(base, top, [45, 28, 6], 6);
      const strokeMarker: MarkerData = {
        id: 'm1',
        name: 'Stroke',
        color: '#ff0000',
        visible: true,
        entities: [],
        paint: {
          faces: [
            {
              faceId: top,
              triangles: stroke
                .filter((p) => p.tree === 1)
                .map((p) => [p.t, 1] as [number, number]),
              pieces: stroke
                .filter((p) => p.tree !== 1)
                .map((p) => ({
                  triangle: p.t,
                  tree: p.tree as [PieceTree, PieceTree, PieceTree, PieceTree],
                })),
            },
          ],
        },
      };
      let doc = save(
        {
          schemaVersion: SCHEMA_VERSION,
          model: { fileName: 'base.step', format: 'step', contentHash: `sha256:${'0'.repeat(64)}` },
          tessellation: { ...base.tessellation },
          markers: [
            strokeMarker,
            {
              id: 'm2',
              name: 'Edge',
              color: '#00ff00',
              visible: true,
              entities: [{ kind: 'edge', id: edge, seq: 0 }],
              paint: { faces: [] },
            },
          ],
          comments: [],
        },
        base,
        'base.step',
      );
      const area0 = paintedArea(base, doc.markers[0] as MarkerData);
      expect(area0).toBeCloseTo(Math.PI * 36, -1); // a 6 mm dab

      const steps: [string, Record<string, TransferStatus[]>, Locator | undefined][] = [
        ['01-fillet', { m1: ['found'], m2: ['lost'] }, undefined],
        // The fillet is gone again: the edge comes back, flagged for the user to check.
        ['08-rotated', { m1: ['found'], m2: ['changed'] }, loc('line', [40, 60, 6])],
        ['09-mirrored', { m1: ['check', 'found'], m2: ['check', 'changed'] }, undefined],
        // 08 has a rib that shifts the top's centre more than the off-centre hole does, so 08 → 09
        // may read as a turn; 09 → 00 (no rib on either) then reads as the mirror it is.
        [
          '00-unchanged',
          { m1: ['found', 'changed', 'check'], m2: ['changed', 'check'] },
          undefined,
        ],
      ];
      const areas: number[] = [];
      for (const [file, want, edgeAt] of steps) {
        const m = model(file);
        const r = transferAnnotations(doc, m);
        for (const [id, ok] of Object.entries(want))
          expect(ok, `${file} ${id}`).toContain(r.status[id]);
        const stroked = r.annotations.markers[0] as MarkerData;
        if (r.status.m1 !== 'check') {
          const a = paintedArea(m, stroked);
          areas.push(a);
          // Never grows or shrinks by more than a few percent per version.
          expect(a / area0, `${file} stroke area`).toBeGreaterThan(0.95);
          expect(a / area0, `${file} stroke area`).toBeLessThan(1.05);
        }
        if (edgeAt)
          expect(
            r.annotations.markers[1]?.entities.map((e) => e.id),
            file,
          ).toEqual([resolveOne(m, edgeAt)]);
        doc = save(r.annotations, m, `${file}.step`);
      }
      expect(areas.length).toBeGreaterThanOrEqual(3);
    },
  );

  it('turns a lone stroke with its part (one flat face fits a turned part both ways)', () => {
    const base = model('base');
    const top = resolveOne(base, loc('plane', [45, 10, 6], 'face'));
    const stroke = dab(base, top, [30, 30, 6], 5);
    const area0 = stroke.reduce((t, p) => t + area(...corners(base, p.t)) * shareOf(p.tree), 0);
    const doc = save(
      {
        schemaVersion: SCHEMA_VERSION,
        model: { fileName: 'base.step', format: 'step', contentHash: `sha256:${'0'.repeat(64)}` },
        tessellation: { ...base.tessellation },
        markers: [
          {
            id: 'm1',
            name: 'Stroke',
            color: '#ff0000',
            visible: true,
            entities: [],
            paint: {
              faces: [
                {
                  faceId: top,
                  triangles: stroke
                    .filter((p) => p.tree === 1)
                    .map((p) => [p.t, 1] as [number, number]),
                  pieces: stroke
                    .filter((p) => p.tree !== 1)
                    .map((p) => ({
                      triangle: p.t,
                      tree: p.tree as [PieceTree, PieceTree, PieceTree, PieceTree],
                    })),
                },
              ],
            },
          },
        ],
        comments: [],
      },
      base,
      'base.step',
    );
    const m = model('08-rotated');
    const r = transferAnnotations(doc, m);
    const moved = r.annotations.markers[0] as MarkerData;
    // Area-weighted centre of the moved paint: (30, 30) turned 90° about (40, 20) → (30, 10).
    let sx = 0;
    let sy = 0;
    let sa = 0;
    const visit = (tree: PieceTree, a: V3, b: V3, c: V3): void => {
      if (tree === 0) return;
      if (tree === 1) {
        const w = area(a, b, c);
        sx += (w * (a[0] + b[0] + c[0])) / 3;
        sy += (w * (a[1] + b[1] + c[1])) / 3;
        sa += w;
        return;
      }
      const [ab, bc, ca] = [half(a, b), half(b, c), half(c, a)];
      visit(tree[0], a, ab, ca);
      visit(tree[1], ab, b, bc);
      visit(tree[2], ca, bc, c);
      visit(tree[3], ab, bc, ca);
    };
    for (const p of paintedOf(moved)) visit(p.tree, ...corners(m, p.t));
    expect(r.status.m1).toBe('found');
    expect(sx / sa).toBeCloseTo(30, 0);
    expect(sy / sa).toBeCloseTo(10, 0);
    // On to the mirrored part: its face centre gives the mirror away (the hole is off-centre).
    const r9 = transferAnnotations(save(r.annotations, m, '08.step'), model('09-mirrored'));
    expect(r9.status.m1).toBe('check');
    // And back to the original: placed again where it started, flagged for the user.
    const m0 = model('00-unchanged');
    const r0 = transferAnnotations(save(r9.annotations, model('09-mirrored'), '09.step'), m0);
    expect(r0.status.m1).toBe('changed');
    sx = 0;
    sy = 0;
    sa = 0;
    for (const p of paintedOf(r0.annotations.markers[0] as MarkerData))
      visit(p.tree, ...corners(m0, p.t));
    expect(sx / sa).toBeCloseTo(30, 0);
    expect(sy / sa).toBeCloseTo(30, 0);
    expect(sa / area0).toBeGreaterThan(0.95);
    expect(sa / area0).toBeLessThan(1.05);
  });
});
