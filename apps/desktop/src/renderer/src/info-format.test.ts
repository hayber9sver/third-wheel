import type { EntityInfo } from '@third-wheel/geometry';
import { describe, expect, it } from 'vitest';
import {
  dimensionLabel,
  infoRows,
  infoTitle,
  measurementRows,
  num,
  sizeHint,
} from './info-format.js';

const rows = (info: EntityInfo): Record<string, string> =>
  Object.fromEntries(infoRows(info).map((r) => [r.label, r.value]));

describe('num', () => {
  it('rounds, trims zeros, no -0, no thousands separator', () => {
    expect(num(1.75)).toBe('1.75');
    expect(num(3.00004)).toBe('3');
    expect(num(-0.0001)).toBe('0');
    expect(num(12345.6789)).toBe('12345.679');
    expect(num(89.999, 2)).toBe('90');
  });
});

describe('infoTitle / infoRows', () => {
  it('cylinder hole: Ø, radius, axis, area', () => {
    const info: EntityInfo = {
      kind: 'face',
      id: 12,
      body: 0,
      type: 'cylinder',
      radius: 1.75,
      axis: [0, 0, 1],
      axisPoint: [1, 2, 0],
      form: 'hole',
      area: 33.0001,
    };
    expect(infoTitle(info)).toBe('Face 12 · Cylinder (hole)');
    expect(rows(info)).toEqual({
      Diameter: 'Ø 3.5 mm',
      Radius: '1.75 mm',
      Axis: '(0, 0, 1)',
      Area: '≈ 33 mm²',
    });
  });

  it('arc vs full circle; vertex coordinates; free-form type names', () => {
    const arc: EntityInfo = {
      kind: 'edge',
      id: 3,
      body: 0,
      type: 'circle',
      radius: 2,
      arcAngle: 90,
      length: Math.PI,
    };
    expect(infoTitle(arc)).toBe('Edge 3 · Arc');
    expect(rows(arc)['Arc angle']).toBe('90°');
    expect(sizeHint(arc)).toBe('R2');
    const full: EntityInfo = { ...arc, arcAngle: 360 };
    expect(infoTitle(full)).toBe('Edge 3 · Circle');
    expect(rows(full)['Arc angle']).toBeUndefined();
    expect(sizeHint(full)).toBe('Ø4');
    expect(rows({ kind: 'vertex', id: 1, body: 0, position: [1, -0, 2.5] })).toEqual({
      X: '1 mm',
      Y: '0 mm',
      Z: '2.5 mm',
    });
    expect(infoTitle({ kind: 'face', id: 4, body: 0, type: 'bspline' })).toBe('Face 4 · B-spline');
  });

  it('body: name, path, counts, size', () => {
    const body: EntityInfo = {
      kind: 'body',
      id: 0,
      body: 0,
      name: 'Plate',
      path: 'Printer › Frame',
      faceCount: 7,
      edgeCount: 15,
      bboxMin: [0, 0, 0],
      bboxMax: [40, 40, 10],
      area: 2000,
    };
    expect(infoTitle(body)).toBe('Plate');
    expect(rows(body)).toEqual({
      Assembly: 'Printer › Frame',
      Faces: '7',
      Edges: '15',
      'Size X × Y × Z': '≈ 40 × 40 × 10 mm',
      Area: '≈ 2000 mm²',
    });
  });
});

describe('measurementRows', () => {
  it('labels each kind of distance; ≈ for mesh distances', () => {
    expect(
      measurementRows({
        distance: { value: 10, exact: false },
        planeDistance: 10,
        angle: 0,
      }),
    ).toEqual([
      { label: 'Shortest distance', value: '≈ 10 mm' },
      { label: 'Perpendicular to plane', value: '10 mm' },
      { label: 'Angle', value: '0°' },
    ]);
    expect(
      measurementRows({
        distance: { value: 5, exact: true },
        centreDistance: 5,
        delta: [3, 4, 0],
      }).map((r) => r.value),
    ).toEqual(['5 mm', '5 mm', '3, 4, 0 mm']);
  });

  it('says when the shortest distance was skipped', () => {
    expect(measurementRows({ angle: 45, distanceSkipped: 'too-large' })).toEqual([
      { label: 'Shortest distance', value: '— (too large to compare)' },
      { label: 'Angle', value: '45°' },
    ]);
    expect(measurementRows({ distanceSkipped: 'no-geometry' })[0]?.value).toBe(
      '— (no shape to measure)',
    );
  });

  it('names what the angle compares', () => {
    const label = (angleBetween: 'lines' | 'planes' | 'edge-plane' | 'axis-plane'): string =>
      measurementRows({ distance: { value: 0, exact: true }, angle: 90, angleBetween })[1]?.label ??
      '';
    expect(label('planes')).toBe('Angle');
    expect(label('lines')).toBe('Angle');
    expect(label('axis-plane')).toBe('Axis to plane');
    expect(label('edge-plane')).toBe('Edge to plane');
  });
});

describe('dimensionLabel', () => {
  it('mm with Ø / R, ≈ only for mesh values, degrees for angles', () => {
    expect(dimensionLabel({ kind: 'length', value: 40, exact: true })).toBe('40 mm');
    expect(dimensionLabel({ kind: 'distance', value: 2.5, exact: false })).toBe('≈ 2.5 mm');
    expect(dimensionLabel({ kind: 'diameter', value: 6, exact: true })).toBe('Ø6 mm');
    expect(dimensionLabel({ kind: 'radius', value: 1.25, exact: true })).toBe('R1.25 mm');
    expect(dimensionLabel({ kind: 'angle', value: 90, exact: true })).toBe('90°');
  });
});
