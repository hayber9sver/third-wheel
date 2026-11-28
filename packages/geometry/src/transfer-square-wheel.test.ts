import { readFileSync } from 'node:fs';
import type { Annotations } from '@third-wheel/core';
import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StepModel } from './model.js';
import { baseAnnotations, type Locator, type RevisionSet } from './revision-set.js';
import { importStep } from './step-import.js';
import { transferAnnotations } from './transfer.js';

// The Square Wheel test model: the cube's front (eyes + smile, -Y) and back (eyes + slot mouth,
// +Y) are near mirror images of each other. Its v2 changes the front face (smile removed, the
// left eye moved up) and the wheel's pin. Markers on the cube must move over, not be taken for a
// mirror image of the cube ("check").
const dir = new URL('../../../test-models/square-wheel/', import.meta.url);
const CUBE = 'Square wheel';

const frontFace: Locator = { kind: 'face', body: CUBE, type: 'plane', at: [-9, -15, 4] };
const holeRim: Locator = { kind: 'edge', body: CUBE, type: 'circle', at: [15, 0, 17.55] };
const topFace: Locator = { kind: 'face', body: CUBE, type: 'bspline', at: [4, -6, 29.34] };

let v1: StepModel;
let v2: StepModel;

beforeAll(async () => {
  const k = await OcctKernel.init();
  v1 = importStep(k, readFileSync(new URL('square-wheel.step', dir), 'utf8'));
  v2 = importStep(k, readFileSync(new URL('square-wheel_v2.step', dir), 'utf8'));
}, 60_000);

const notes = (markers: RevisionSet['markers']): Annotations =>
  baseAnnotations(
    v1,
    { version: 1, base: 'square-wheel.step', markers, pairs: [] },
    'square-wheel.step',
  );

describe('Square Wheel v1 → v2 (front and back nearly mirror images)', () => {
  it('moves a marker on the changed front face and the pin-hole rim, never "check"', () => {
    const before = notes([
      { id: 'm_hole', name: 'Hole', paint: [], entities: [holeRim] },
      { id: 'm_front', name: 'Front', paint: [frontFace], entities: [] },
    ]);
    const r = transferAnnotations(before, v2);
    expect(r.status.m_hole).toBe('found');
    expect(['found', 'changed']).toContain(r.status.m_front);
  });

  it('keeps finding markers on unchanged faces (the wavy top + the hole rim)', () => {
    const before = notes([
      { id: 'm_hole', name: 'Hole', paint: [], entities: [holeRim] },
      { id: 'm_top', name: 'Top', paint: [topFace], entities: [] },
    ]);
    const r = transferAnnotations(before, v2);
    expect(r.status).toEqual({ m_hole: 'found', m_top: 'found' });
  });

  it('a front-face marker alone moves too', () => {
    const before = notes([{ id: 'm_front', name: 'Front', paint: [frontFace], entities: [] }]);
    const r = transferAnnotations(before, v2);
    expect(['found', 'changed']).toContain(r.status.m_front);
  });
});
