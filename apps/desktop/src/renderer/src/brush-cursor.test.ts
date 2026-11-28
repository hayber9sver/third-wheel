import type { StepModel } from '@third-wheel/geometry';
import { Ray, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  BrushCursor,
  ERASE_COLOR,
  NO_MARKER_COLOR,
  ringPositions,
  smoothNormal,
  SurfaceRaycaster,
  triangleNormal,
} from './brush-cursor.js';

/**
 * Two unit squares facing +Z: body 0 at z = 0, body 1 at z = 1 (in front, seen from above).
 * Triangles listed body 1 first so a BVH that reorders triangles would return wrong ids.
 */
function twoPlates(): StepModel {
  const positions = new Float32Array([
    0,
    0,
    1,
    1,
    0,
    1,
    1,
    1,
    1,
    0,
    1,
    1, // body 1 (z = 1), vertices 0–3
    0,
    0,
    0,
    1,
    0,
    0,
    1,
    1,
    0,
    0,
    1,
    0, // body 0 (z = 0), vertices 4–7
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return {
    positions,
    indices,
    normals: new Float32Array(Array.from({ length: 8 }, () => [0, 0, 1]).flat()),
    triangleFace: new Uint32Array([1, 1, 0, 0]),
    faceBody: new Uint32Array([0, 1]),
  } as unknown as StepModel;
}

const down = (x: number, y: number): Ray => new Ray(new Vector3(x, y, 5), new Vector3(0, 0, -1));

describe('SurfaceRaycaster', () => {
  it('returns the nearest visible triangle with the import triangle id', () => {
    const r = new SurfaceRaycaster(twoPlates());
    const hit = r.hit(down(0.75, 0.25), []);
    expect(hit).toMatchObject({ triangle: 0, face: 1, body: 1 });
    expect(hit?.point[2]).toBeCloseTo(1);
    expect(hit?.normal).toEqual([0, 0, 1]);
  });

  it('skips hidden bodies', () => {
    const r = new SurfaceRaycaster(twoPlates());
    const hit = r.hit(down(0.25, 0.75), [true, false]);
    expect(hit).toMatchObject({ triangle: 3, face: 0, body: 0 });
    expect(hit?.point[2]).toBeCloseTo(0);
    expect(r.hit(down(0.5, 0.5), [false, false])).toBeUndefined();
  });

  it('turns the normal towards the viewer and misses outside the model', () => {
    const r = new SurfaceRaycaster(twoPlates());
    const up = new Ray(new Vector3(0.75, 0.25, -5), new Vector3(0, 0, 1));
    expect(r.hit(up, [])?.normal).toEqual([-0, -0, -1]);
    expect(r.hit(down(3, 3), [])).toBeUndefined();
  });
});

describe('SurfaceRaycaster.trianglesInSphere', () => {
  it('returns every triangle the ball touches, with import ids, on visible bodies', () => {
    const r = new SurfaceRaycaster(twoPlates());
    // Ball at a corner of the front plate, reaching only its first triangle's corner region.
    expect(r.trianglesInSphere([1.05, 0, 1], 0.1, []).sort()).toEqual([0]);
    // Radius 0.6 from the front plate's centre doesn't reach z = 0; 1.2 does.
    expect(r.trianglesInSphere([0.5, 0.5, 1], 0.6, []).sort()).toEqual([0, 1]);
    expect(r.trianglesInSphere([0.5, 0.5, 1], 1.2, []).sort()).toEqual([0, 1, 2, 3]);
    expect(r.trianglesInSphere([0.5, 0.5, 1], 1.2, [true, false]).sort()).toEqual([2, 3]);
    expect(r.trianglesInSphere([5, 5, 5], 1, [])).toEqual([]);
  });
});

describe('smoothNormal', () => {
  it('interpolates vertex normals across the triangle', () => {
    const model = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array([0, 0, 1, 1, 0, 0, 0, 0, 1]),
    };
    const atV0 = smoothNormal(model, 0, [0, 0, 0]);
    expect(atV0[2]).toBeCloseTo(1);
    const atV1 = smoothNormal(model, 0, [1, 0, 0]);
    expect(atV1[0]).toBeCloseTo(1);
    const mid = smoothNormal(model, 0, [0.5, 0, 0]);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2);
    expect(mid[2]).toBeCloseTo(Math.SQRT1_2);
  });

  it('falls back to the facet normal when vertex normals cancel out', () => {
    const model = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array([0, 0, 1, 0, 0, -1, 0, 0, 0]),
    };
    expect(smoothNormal(model, 0, [0.5, 0, 0])).toEqual([0, 0, 1]);
  });
});

describe('triangleNormal', () => {
  it('follows the winding and survives degenerate triangles', () => {
    const p = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    expect(triangleNormal(p, [0, 1, 2], 0)).toEqual([0, 0, 1]);
    expect(triangleNormal(p, [0, 2, 1], 0)).toEqual([0, 0, -1]);
    expect(triangleNormal(p, [0, 0, 1], 0)).toEqual([0, 0, 1]);
  });
});

describe('ringPositions', () => {
  it('makes 2 triangles per segment between the radii; dashed keeps half', () => {
    const solid = ringPositions(0.9, 1, 64, false);
    expect(solid.length).toBe(64 * 2 * 3 * 3);
    expect(ringPositions(0.9, 1, 64, true).length).toBe(solid.length / 2);
    for (let i = 0; i < solid.length; i += 3) {
      const r = Math.hypot(solid[i] ?? 0, solid[i + 1] ?? 0);
      expect(r).toBeGreaterThan(0.9 - 1e-6);
      expect(r).toBeLessThan(1 + 1e-6);
      expect(solid[i + 2]).toBe(0);
    }
  });
});

describe('BrushCursor', () => {
  it('lies on the surface, sized to the radius; hides', () => {
    const c = new BrushCursor();
    const hit = { point: [1, 2, 3], normal: [1, 0, 0], triangle: 0, face: 0, body: 0 } as const;
    c.show({ ...hit, point: [1, 2, 3], normal: [1, 0, 0] }, 3, 0.05, 'erase');
    expect(c.current()).toEqual({
      center: [1, 2, 3],
      normal: [1, 0, 0],
      radius: 3,
      style: 'erase',
      color: ERASE_COLOR,
    });
    expect(c.root.visible).toBe(true);
    expect(c.root.scale.x).toBe(3);
    // The ring's local +Z (its axis) points along the surface normal.
    const axis = new Vector3(0, 0, 1).applyQuaternion(c.root.quaternion);
    expect(axis.x).toBeCloseTo(1);
    c.hide();
    expect(c.current()).toBeUndefined();
    expect(c.root.visible).toBe(false);
    c.dispose();
  });

  it('brush uses the set colour (active marker), erase stays red', () => {
    const c = new BrushCursor();
    const hit = { point: [0, 0, 0], normal: [0, 0, 1], triangle: 0, face: 0, body: 0 } as const;
    c.show(hit, 1, 0.01, 'brush');
    expect(c.current()?.color).toBe(NO_MARKER_COLOR);
    c.setBrushColor(0x2fbf71);
    c.show(hit, 1, 0.01, 'brush');
    expect(c.current()?.color).toBe(0x2fbf71);
    c.show(hit, 1, 0.01, 'erase');
    expect(c.current()?.color).toBe(ERASE_COLOR);
    c.dispose();
  });
});
