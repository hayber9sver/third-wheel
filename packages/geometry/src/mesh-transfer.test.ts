import { readFileSync } from 'node:fs';
import {
  annotationsSchema,
  fromRuns,
  SCHEMA_VERSION,
  type Annotations,
  type MarkerData,
  type PieceTree,
} from '@third-wheel/core';
import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { bodyFingerprints } from './fingerprint.js';
import { meshModel } from './mesh-import.js';
import type { StepModel } from './model.js';
import { paintSamples } from './paint-samples.js';
import { parseRevisionSet, resolveOne } from './revision-set.js';
import { importStep } from './step-import.js';
import { transferMeshAnnotations } from './transfer.js';
import { at3, cross, len, sub, type V3 } from './vec.js';

// A mesh (STL) export of the test bracket, turned Y-up and moved as many exporters do,
// painted in mesh-only mode; its paint must land on the STEP's faces.
const dir = new URL('../test-data/revisions/', import.meta.url);
const set = parseRevisionSet(JSON.parse(readFileSync(new URL('revisions.json', dir), 'utf8')));
let step: StepModel;

beforeAll(async () => {
  const k = await OcctKernel.init();
  step = importStep(k, readFileSync(new URL(set.base, dir), 'utf8'));
}, 60_000);

type Move = (p: V3) => V3;
/** Y-up (a proper turn: x, y, z → x, z, −y) and moved. */
const yUp: Move = (p) => [p[0] + 100, p[2] - 40, -p[1] + 7];
/** A mirror image (x → −x). */
const mirror: Move = (p) => [-p[0], p[1], p[2]];

/** The STEP's triangles as an STL mesh, moved; `faceOf[t]` = the STEP face of mesh triangle t. */
function stlOf(move: Move): StepModel {
  const n = step.triangleFace.length;
  const tris = new Float32Array(n * 9);
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 3; k++) {
      const p = move(at3(step.positions, step.indices[t * 3 + k] ?? 0));
      tris.set(p, t * 9 + k * 3);
    }
  return meshModel([{ name: 'bracket', triangles: tris }], 'stl');
}

/** STEP faces of the test set's markers (by locator). */
const facesOf = (id: string): number[] =>
  (set.markers.find((m) => m.id === id)?.paint ?? []).map((l) => resolveOne(step, l));

const centroid = (m: StepModel, t: number): V3 => {
  const a = at3(m.positions, m.indices[t * 3] ?? 0);
  const b = at3(m.positions, m.indices[t * 3 + 1] ?? 0);
  const c = at3(m.positions, m.indices[t * 3 + 2] ?? 0);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
};

/** Mesh triangles lying on the given STEP faces (found by position: the mesh may be re-ordered). */
function meshTrianglesOn(mesh: StepModel, move: Move, faces: readonly number[]): number[] {
  const want = new Map<string, true>();
  const key = (p: V3): string => p.map((x) => x.toFixed(2)).join(',');
  for (let t = 0; t < step.triangleFace.length; t++)
    if (faces.includes(step.triangleFace[t] ?? -1)) want.set(key(move(centroid(step, t))), true);
  const out: number[] = [];
  for (let t = 0; t < mesh.triangleFace.length; t++)
    if (want.has(key(centroid(mesh, t)))) out.push(t);
  return out;
}

/** A mesh-mode sidecar: paint on face 0 (the only "face"), samples + clear as the app writes. */
function meshDoc(mesh: StepModel, markers: { id: string; tris: number[] }[]): Annotations {
  const list: MarkerData[] = markers.map(({ id, tris }) => {
    const pts = paintSamples(
      mesh,
      tris.map((t) => ({ t, tree: 1 as const })),
      2000,
    ).get(0);
    return {
      id,
      name: id,
      color: '#ff0000',
      visible: true,
      entities: [],
      paint: {
        faces: [
          {
            faceId: 0,
            triangles: [],
            ...(pts?.samples.length ? { samples: pts.samples } : {}),
            ...(pts?.clear.length ? { clear: pts.clear } : {}),
          },
        ],
      },
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    model: { fileName: 'bracket.stl', format: 'stl', contentHash: `sha256:${'0'.repeat(64)}` },
    markers: list,
    comments: [],
    bodies: bodyFingerprints(mesh, mesh.bodyCount),
  };
}

const area = (m: StepModel, t: number): number => {
  const a = at3(m.positions, m.indices[t * 3] ?? 0);
  const b = at3(m.positions, m.indices[t * 3 + 1] ?? 0);
  const c = at3(m.positions, m.indices[t * 3 + 2] ?? 0);
  return len(cross(sub(b, a), sub(c, a))) / 2;
};

const shareOf = (tree: PieceTree): number =>
  tree === 0 || tree === 1 ? tree : tree.reduce<number>((s, k) => s + shareOf(k), 0) / 4;

/** STEP faces painted, and painted area. */
function painted(mk: MarkerData | undefined): { faces: number[]; area: number } {
  let a = 0;
  for (const f of mk?.paint.faces ?? []) {
    for (const t of fromRuns(f.triangles)) a += area(step, t);
    for (const p of f.pieces ?? []) a += area(step, p.triangle) * shareOf(p.tree);
  }
  return { faces: (mk?.paint.faces ?? []).map((f) => f.faceId), area: a };
}

const faceArea = (faces: readonly number[]): number => {
  let a = 0;
  for (let t = 0; t < step.triangleFace.length; t++)
    if (faces.includes(step.triangleFace[t] ?? -1)) a += area(step, t);
  return a;
};

describe('transferMeshAnnotations', () => {
  it('lines up a turned, moved STL and puts its paint on the matching STEP faces', () => {
    const mesh = stlOf(yUp);
    const top = facesOf('m_top');
    // One marker over two CAD faces (the mesh is one face: any stroke may cross CAD edges).
    const both = [...facesOf('m_end'), ...facesOf('m_wall_in')];
    const doc = meshDoc(mesh, [
      { id: 'top', tris: meshTrianglesOn(mesh, yUp, top) },
      { id: 'both', tris: meshTrianglesOn(mesh, yUp, both) },
    ]);
    const r = transferMeshAnnotations(doc, step, mesh);
    expect(r.status).toEqual({ top: 'found', both: 'found' });
    expect(r.coverage.mirrored).toBe(false);
    expect(r.coverage.surface).toBeGreaterThan(0.99);
    expect(r.coverage.matched).toBe(r.coverage.points);
    expect(r.coverage.toleranceMm).toBeGreaterThanOrEqual(0.5);
    const out = annotationsSchema.parse(r.annotations);
    const gotTop = painted(out.markers.find((m) => m.id === 'top'));
    expect(gotTop.faces).toEqual(top);
    expect(gotTop.area / faceArea(top)).toBeGreaterThan(0.97);
    expect(gotTop.area / faceArea(top)).toBeLessThan(1.03);
    expect(painted(out.markers.find((m) => m.id === 'both')).faces.sort()).toEqual(
      [...both].sort(),
    );
    // The STEP's bodies, not the mesh's one.
    expect(out.bodies?.length).toBe(step.bodyCount);
    expect(out.markers.every((m) => m.transfer === undefined)).toBe(true);
  });

  it('works from the notes alone when the mesh file is gone (paint points + body box)', () => {
    const mesh = stlOf(yUp);
    const top = facesOf('m_top');
    const doc = meshDoc(mesh, [{ id: 'top', tris: meshTrianglesOn(mesh, yUp, top) }]);
    const r = transferMeshAnnotations(doc, step);
    expect(r.status.top).toBe('found');
    expect(painted(r.annotations.markers[0]).faces).toEqual(top);
  });

  it('a mirrored mesh: markers are "check", kept as ghosts at the mirrored place', () => {
    const move: Move = (p) => mirror(yUp(p));
    const mesh = stlOf(move);
    const doc = meshDoc(mesh, [{ id: 'top', tris: meshTrianglesOn(mesh, move, facesOf('m_top')) }]);
    const r = transferMeshAnnotations(doc, step, mesh);
    expect(r.coverage.mirrored).toBe(true);
    expect(r.coverage.matched).toBe(0);
    expect(r.status.top).toBe('check');
    const mk = r.annotations.markers[0];
    expect(mk?.paint.faces).toEqual([]);
    expect(mk?.transfer?.ghost?.faces?.[0]?.samples.length).toBeGreaterThan(0);
  });

  it('another part: paint is lost (kept as a ghost), nothing painted', () => {
    // A stretched copy: no turn fits the box.
    const move: Move = (p) => [p[0] * 3, p[1], p[2]];
    const mesh = stlOf(move);
    const doc = meshDoc(mesh, [{ id: 'top', tris: meshTrianglesOn(mesh, move, facesOf('m_top')) }]);
    const r = transferMeshAnnotations(doc, step, mesh);
    expect(r.status.top).toBe('lost');
    expect(r.coverage.matched).toBe(0);
    expect(r.annotations.markers[0]?.transfer?.ghost?.faces?.length).toBe(1);
  });
});
