import { describe, expect, it } from 'vitest';
import {
  bodyBoxes,
  cubeHitDirection,
  dot,
  easeInOut,
  FIT_KEY,
  fitDistance,
  fitInFreeArea,
  freeAreaShift,
  nearestScreenUp,
  orbitSetup,
  PRESET_VIEWS,
  rollScreenUp,
  rotateShortestArc,
  sphereOfBodies,
  standardScreenUp,
  viewForKey,
  type Vec3,
  Z_UP,
} from './camera-views.js';
import { toolForKey } from './tools.js';

function expectVec(actual: Vec3, expected: Vec3, digits = 6): void {
  actual.forEach((c, i) => {
    expect(c).toBeCloseTo(expected[i] ?? NaN, digits);
  });
}

describe('preset views', () => {
  it('uses FreeCAD numbering and unit directions', () => {
    expect(PRESET_VIEWS.map((v) => `${v.key}:${v.id}`)).toEqual([
      '0:iso',
      '1:front',
      '2:top',
      '3:right',
      '4:back',
      '5:bottom',
      '6:left',
    ]);
    for (const v of PRESET_VIEWS) expect(Math.hypot(...v.dir)).toBeCloseTo(1, 9);
    expect(viewForKey('1')?.dir).toEqual([0, -1, 0]); // front camera sits at −Y
    expect(viewForKey('9')).toBeUndefined();
  });
});

describe('cubeHitDirection', () => {
  it('maps face centres, edges and corners to 26 directions', () => {
    expect(cubeHitDirection([0.05, -0.5, 0.1])).toEqual([0, -1, 0]); // front face centre
    expectVec(cubeHitDirection([0.45, -0.5, 0]), [Math.SQRT1_2, -Math.SQRT1_2, 0]); // front-right edge
    const s = 1 / Math.sqrt(3);
    expectVec(cubeHitDirection([0.42, -0.5, 0.44]), [s, -s, s]); // front-right-top corner
    const dirs = new Set<string>();
    for (const x of [-0.5, 0, 0.5])
      for (const y of [-0.5, 0, 0.5])
        for (const z of [-0.5, 0, 0.5]) {
          if (x === 0 && y === 0 && z === 0) continue;
          dirs.add(cubeHitDirection([x, y, z]).join());
        }
    expect(dirs.size).toBe(26);
  });
});

describe('fitDistance', () => {
  it('fits the sphere into the narrower field of view', () => {
    const square = fitDistance(10, 90, 1);
    expect(square).toBeCloseTo(10 / Math.sin(Math.PI / 4), 9);
    expect(fitDistance(10, 90, 2)).toBeCloseTo(square, 9); // wide: vertical FOV limits
    expect(fitDistance(10, 90, 0.5)).toBeGreaterThan(square); // tall: horizontal FOV limits
  });
});

describe('fitInFreeArea', () => {
  it('without a cover: the plain fit', () => {
    expect(fitInFreeArea(10, 60, 1000, 800, 0)).toBe(fitDistance(10, 60, 1000 / 800));
  });

  it('fits into the free width', () => {
    expect(fitInFreeArea(10, 60, 960, 800, 480)).toBeCloseTo(fitDistance(10, 60, 480 / 800), 9);
  });

  it('a cover wider than the view leaves at least a pixel', () => {
    expect(Number.isFinite(fitInFreeArea(10, 60, 300, 800, 900))).toBe(true);
  });
});

describe('freeAreaShift', () => {
  it('moves the picture by half the cover', () => {
    expect(freeAreaShift(1000, 0)).toBe(0);
    expect(freeAreaShift(960, 480)).toBe(240);
    expect(freeAreaShift(1000, -20)).toBe(0);
  });

  it('a cover wider than the view is clamped to it', () => {
    expect(freeAreaShift(300, 900)).toBe(149.5);
  });
});

describe('body bounds', () => {
  // Body 0: triangle at x∈[0,1]; body 1: triangle at x∈[10,12]; body 2: one edge only.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 12, 0, 0, 10, 2, 4]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const triStart = new Uint32Array([0, 3, 6, 6]);
  const edgeSegments = new Float32Array([-5, 0, 0, -5, 0, 2]);
  const edgeStart = new Uint32Array([0, 0, 0, 2]);
  const boxes = bodyBoxes(positions, indices, triStart, edgeSegments, edgeStart);

  it('computes one box per body, including edge-only bodies', () => {
    expect(Array.from(boxes.subarray(0, 6))).toEqual([0, 0, 0, 1, 1, 0]);
    expect(Array.from(boxes.subarray(6, 12))).toEqual([10, 0, 0, 12, 2, 4]);
    expect(Array.from(boxes.subarray(12, 18))).toEqual([-5, 0, 0, -5, 0, 2]);
  });

  it('gives a sphere around the chosen bodies only', () => {
    const one = sphereOfBodies(boxes, [1]);
    expectVec(one?.center ?? [NaN, NaN, NaN], [11, 1, 2]);
    expect(one?.radius).toBeCloseTo(Math.hypot(2, 2, 4) / 2, 9);
    const both = sphereOfBodies(boxes, [0, 1]);
    expectVec(both?.center ?? [NaN, NaN, NaN], [6, 1, 2]);
    expect(sphereOfBodies(boxes, [])).toBeUndefined();
  });
});

describe('easeInOut', () => {
  it('eases in and out', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
  });
});

describe('orientation', () => {
  const FRONT: Vec3 = [0, -1, 0];
  const TOP: Vec3 = [0, 0, 1];
  const RIGHT: Vec3 = [1, 0, 0];
  const s = 1 / Math.sqrt(3);
  const ISO: Vec3 = [s, -s, s];

  it('has standard screen-ups: Z on sides, +Y on top, −Y on bottom', () => {
    expect(standardScreenUp(FRONT)).toEqual([0, 0, 1]);
    expect(standardScreenUp(TOP)).toEqual([0, 1, 0]);
    expect(standardScreenUp([0, 0, -1])).toEqual([0, -1, 0]);
    const iso = standardScreenUp(ISO);
    expect(dot(iso, ISO)).toBeCloseTo(0, 9);
    expect(iso[2]).toBeGreaterThan(0);
  });

  it('rolls the picture 90° clockwise / counter-clockwise', () => {
    // Front view: +X is on the right, so −X (left) comes up when rolling clockwise.
    expectVec(rollScreenUp(FRONT, Z_UP, true), [-1, 0, 0]);
    expectVec(rollScreenUp(FRONT, Z_UP, false), [1, 0, 0]);
    // Four clockwise rolls are a full turn.
    let up: Vec3 = Z_UP;
    for (let i = 0; i < 4; i++) up = rollScreenUp(FRONT, up, true);
    expectVec(up, Z_UP);
  });

  it('carries the screen-up along the shortest turn (nearest orientation)', () => {
    // Unrolled: Front → Top shows +Y up (front edge at the bottom); Top → Front shows Z up.
    expectVec(nearestScreenUp(FRONT, Z_UP, TOP), [0, 1, 0]);
    expectVec(nearestScreenUp(TOP, [0, 1, 0], FRONT), Z_UP);
    expectVec(nearestScreenUp(FRONT, Z_UP, RIGHT), Z_UP);
    // Rolled front (−X up) → Right keeps the roll: up becomes the axis carried along (−Y).
    expectVec(nearestScreenUp(FRONT, [-1, 0, 0], RIGHT), [0, -1, 0]);
    // Front → Back (opposite): turn around the screen-up, which stays.
    expectVec(nearestScreenUp(FRONT, Z_UP, [0, 1, 0]), Z_UP);
    // Iso → Top is a tie between −X and +Y; the standard (+Y) wins.
    expectVec(nearestScreenUp(ISO, standardScreenUp(ISO), TOP), [0, 1, 0]);
  });

  it('rotateShortestArc turns vectors with the direction', () => {
    expectVec(rotateShortestArc(Z_UP, FRONT, TOP, Z_UP), [0, 1, 0]);
    expectVec(rotateShortestArc(RIGHT, FRONT, FRONT, Z_UP), RIGHT);
  });

  it('keeps the orbit axis when it already shows the wanted screen-up', () => {
    expect(orbitSetup(FRONT, Z_UP, Z_UP)).toEqual({ orbitUp: Z_UP, cameraDir: FRONT });
    const iso = orbitSetup(ISO, standardScreenUp(ISO), Z_UP);
    expect(iso.orbitUp).toEqual(Z_UP);
  });

  it('tilts a hair when looking along the orbit axis so the picture turns right', () => {
    for (const [dir, up] of [
      [TOP, [0, 1, 0]],
      // Already tilted for +Y (a previous Top view), now rolled to −X: the old tilt must not stay.
      [
        [0, -1e-4, 1],
        [-1, 0, 0],
      ],
      [TOP, [1, 0, 0]],
      [
        [0, 0, -1],
        [0, -1, 0],
      ],
    ] as [Vec3, Vec3][]) {
      const setup = orbitSetup(dir, up, Z_UP);
      expect(setup.orbitUp).toEqual(Z_UP);
      expect(dot(setup.cameraDir, dir)).toBeGreaterThan(0.9999);
      // What an orbit camera shows as up: the axis' projection ⟂ the camera direction.
      const c = setup.cameraDir;
      const d = dot(Z_UP, c);
      const shown = [-d * c[0], -d * c[1], 1 - d * c[2]] as Vec3;
      const len = Math.hypot(...shown);
      expectVec([shown[0] / len, shown[1] / len, shown[2] / len], up, 3);
    }
  });

  it('switches the orbit axis to the new screen-up after a side-view roll', () => {
    expect(orbitSetup(FRONT, [-1, 0, 0], Z_UP)).toEqual({ orbitUp: [-1, 0, 0], cameraDir: FRONT });
  });
});

describe('shortcuts', () => {
  it('do not clash with tool shortcuts', () => {
    for (const key of [...PRESET_VIEWS.map((v) => v.key), FIT_KEY]) {
      expect(toolForKey(key)).toBeUndefined();
    }
  });
});
