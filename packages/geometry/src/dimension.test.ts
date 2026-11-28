import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { entityDimension, pairDimension, type Dimension } from './dimension.js';
import { measure, type EntityRef } from './entity-info.js';
import type { StepModel } from './model.js';
import { importStep } from './step-import.js';
import { dist, mid, sub, type V3 } from './vec.js';

let m: StepModel;

beforeAll(async () => {
  const k = await OcctKernel.init();
  // Body 0: 40×40×10 plate with a Ø6 hole at (10, 10). Body 1: Ø10 shaft, 20 tall, at x = 60.
  // Body 2: half of an R5 cylinder (x ≥ 100), standing for a fillet / partial round.
  const plate = k.cut(k.makeBox(40, 40, 10), k.translate(k.makeCylinder(3, 10), 10, 10, 0));
  const shaft = k.translate(k.makeCylinder(5, 20), 60, 0, 0);
  const half = k.translate(
    k.cut(k.makeCylinder(5, 10), k.translate(k.makeBox(10, 20, 10), -10, -10, 0)),
    100,
    0,
    0,
  );
  m = importStep(k, k.exportStep(k.makeCompound([plate, shaft, half])));
}, 30_000);

const face = (pred: (id: number) => boolean): EntityRef => {
  const id = m.faceTypes.findIndex((_, i) => pred(i));
  expect(id).toBeGreaterThanOrEqual(0);
  return { kind: 'face', id };
};
const normal = (id: number): V3 => [
  m.faceGeometry[id * 8] ?? NaN,
  m.faceGeometry[id * 8 + 1] ?? NaN,
  m.faceGeometry[id * 8 + 2] ?? NaN,
];
const plane = (body: number, n: V3): EntityRef =>
  face(
    (i) =>
      m.faceBody[i] === body &&
      m.faceTypes[i] === 'plane' &&
      normal(i).every((c, j) => Math.abs(c - (n[j] ?? 0)) < 1e-6),
  );
const cylinder = (body: number): EntityRef =>
  face((i) => m.faceBody[i] === body && m.faceTypes[i] === 'cylinder');
const vertexAt = (x: number, y: number, z: number): EntityRef => {
  for (let id = 0; id < m.vertexPositions.length / 3; id++) {
    const p = m.vertexPositions.subarray(id * 3, id * 3 + 3);
    if (Math.hypot((p[0] ?? 0) - x, (p[1] ?? 0) - y, (p[2] ?? 0) - z) < 1e-4)
      return { kind: 'vertex', id };
  }
  throw new Error(`no vertex at ${String([x, y, z])}`);
};
const pair = (a: EntityRef, b: EntityRef): Dimension | undefined =>
  pairDimension(m, a, b, measure(m, a, b));
const span = (d: Dimension | undefined): number => (d ? dist(d.from, d.to) : NaN);

describe('entityDimension', () => {
  it('a straight edge: its length, end to end', () => {
    const id = m.edgeTypes.findIndex(
      (t, i) => t === 'line' && Math.abs((m.edgeGeometry[i * 9 + 6] ?? 0) - 40) < 1e-6,
    );
    const d = entityDimension(m, { kind: 'edge', id });
    expect(d?.kind).toBe('length');
    expect(d?.value).toBeCloseTo(40, 6);
    expect(span(d)).toBeCloseTo(40, 6);
  });

  it('a hole and its circle edge: Ø across the axis', () => {
    const d = entityDimension(m, cylinder(0));
    expect(d?.kind).toBe('diameter');
    expect(d?.value).toBeCloseTo(6, 5);
    expect(span(d)).toBeCloseTo(6, 5);
    const c = d && mid(d.from, d.to);
    expect(c?.[0]).toBeCloseTo(10, 4);
    expect(c?.[1]).toBeCloseTo(10, 4);
    const edge = m.edgeTypes.findIndex((t, i) => t === 'circle' && m.edgeBody[i] === 0);
    const e = entityDimension(m, { kind: 'edge', id: edge });
    expect(e?.kind).toBe('diameter');
    expect(span(e)).toBeCloseTo(6, 5);
  });

  it('half a cylinder: R from the axis to the face', () => {
    const d = entityDimension(m, cylinder(2));
    expect(d?.kind).toBe('radius');
    expect(d?.value).toBeCloseTo(5, 5);
    expect(span(d)).toBeCloseTo(5, 5);
    expect(d?.to[0]).toBeGreaterThan(100); // on the half that is there
  });

  it('nothing for a vertex, a plane or a body', () => {
    expect(entityDimension(m, vertexAt(40, 40, 10))).toBeUndefined();
    expect(entityDimension(m, plane(0, [0, 0, 1]))).toBeUndefined();
    expect(entityDimension(m, { kind: 'body', id: 0 })).toBeUndefined();
  });
});

describe('pairDimension', () => {
  it('two parallel faces: perpendicular distance, line along the normal', () => {
    const d = pair(plane(0, [0, 0, 1]), plane(0, [0, 0, -1]));
    expect(d?.kind).toBe('distance');
    expect(d?.value).toBeCloseTo(10, 6);
    expect(span(d)).toBeCloseTo(10, 6);
    const v = d && sub(d.to, d.from);
    expect(Math.abs(v?.[0] ?? NaN)).toBeLessThan(1e-6);
  });

  it('a hole and a side face: axis to plane', () => {
    const d = pair(cylinder(0), plane(0, [1, 0, 0]));
    expect(d?.value).toBeCloseTo(30, 5);
    expect(span(d)).toBeCloseTo(30, 5);
    expect(d?.to[0]).toBeCloseTo(40, 5);
  });

  it('two parallel holes / shafts: axis to axis', () => {
    const d = pair(cylinder(0), cylinder(1));
    expect(d?.value).toBeCloseTo(Math.hypot(50, 10), 4);
    expect(span(d)).toBeCloseTo(Math.hypot(50, 10), 4);
  });

  it('two faces meeting at an edge: the angle, at the corner', () => {
    const d = pair(plane(0, [0, 0, 1]), plane(0, [1, 0, 0]));
    expect(d?.kind).toBe('angle');
    expect(d?.value).toBeCloseTo(90, 6);
    expect(d?.to).toEqual(d?.from);
  });

  it('two vertices: the straight distance between them', () => {
    const d = pair(vertexAt(0, 0, 0), vertexAt(40, 40, 10));
    expect(d?.value).toBeCloseTo(Math.hypot(40, 40, 10), 6);
    expect(d?.exact).toBe(true);
    expect(span(d)).toBeCloseTo(Math.hypot(40, 40, 10), 6);
  });

  it('nothing for two things in the same place', () => {
    const v = vertexAt(0, 0, 0);
    expect(pair(v, v)).toBeUndefined();
  });
});
