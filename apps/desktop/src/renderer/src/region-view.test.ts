import { describe, expect, it } from 'vitest';
import { boxCenter, dot, length, type Vec3 } from './camera-views.js';
import { faceTriangles } from './highlight-buffers.js';
import type { Marker } from './markers.js';
import { flipRows } from './region-render.js';
import {
  REGION_FILL,
  REGION_SIZE,
  regionRequest,
  regionSamples,
  regionSize,
  regionView,
  regionViewDir,
  type RegionModel,
  type RegionSamples,
} from './region-view.js';
import type { SelectionItem } from './selection.js';

/**
 * One body, a 2 × 2 × 1 block's top (face 0, +Z, triangles 0–1), bottom (face 1, −Z, wound the
 * other way round, triangles 2–3) and right side (face 2, +X, 2 × 1, triangles 4–5).
 * Edge 0: top front edge (0,0,1)→(2,0,1). Vertex 0: (2,2,1).
 */
const model: RegionModel = {
  positions: new Float32Array([
    ...[0, 0, 1, 2, 0, 1, 2, 2, 1, 0, 2, 1],
    ...[0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0],
    ...[2, 0, 0, 2, 2, 0, 2, 2, 1, 2, 0, 1],
  ]),
  normals: new Float32Array([
    ...[0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    ...[0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1],
    ...[1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
  ]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]),
  triangleFace: new Uint32Array([0, 0, 1, 1, 2, 2]),
  faceBody: new Uint32Array([0, 0, 0]),
  edgePoints: new Float32Array([0, 0, 1, 2, 0, 1]),
  edgeRanges: new Uint32Array([0, 2]),
  edgeBody: new Uint32Array([0]),
  vertexPositions: new Float32Array([2, 2, 1]),
  vertexBody: new Uint32Array([0]),
};
const faceTris = faceTriangles(model.triangleFace, 3);
const boxes = new Float64Array([0, 0, 0, 2, 2, 1]);
const center = (b: number): Vec3 => boxCenter(boxes, b);
const samples = (items: readonly SelectionItem[], triangles: number[] = []): RegionSamples =>
  regionSamples(model, faceTris, items, triangles, center);
const close = (v: Vec3, want: Vec3): void => {
  v.forEach((c, i) => {
    expect(c).toBeCloseTo(want[i] ?? 0, 6);
  });
};
const s3 = 1 / Math.sqrt(3);

describe('regionSamples', () => {
  it('painted triangles: area-weighted normal, their points', () => {
    const s = samples([], [0, 1]);
    expect(s.area).toBeCloseTo(4);
    close(s.normalSum, [0, 0, 4]);
    expect(s.points.length).toBe(4 * 3);
    expect(s.outward).toBeUndefined();
  });

  it('turns triangles to their vertex normals (reversed winding)', () => {
    close(samples([], [2, 3]).normalSum, [0, 0, -4]);
  });

  it('a held face and paint on it count once; a body holds all its faces', () => {
    expect(samples([{ kind: 'face', id: 0 }], [0]).area).toBeCloseTo(4);
    const body = samples([{ kind: 'body', id: 0 }]);
    expect(body.area).toBeCloseTo(10);
    expect(body.points.length).toBe(12 * 3);
  });

  it('edges and vertices: their points, seen from outside their body', () => {
    const s = samples([{ kind: 'edge', id: 0 }]);
    expect(s.area).toBe(0);
    expect([...s.points]).toEqual([0, 0, 1, 2, 0, 1]);
    close(s.outward ?? [0, 0, 0], [0, -1 / Math.hypot(1, 0.5), 0.5 / Math.hypot(1, 0.5)]);
    expect(samples([{ kind: 'vertex', id: 0 }]).points.length).toBe(3);
  });

  it('ignores unknown ids', () => {
    expect(samples([{ kind: 'face', id: 9 }], [99]).points.length).toBe(0);
    expect(samples([{ kind: 'face', id: 9 }], [99]).bodies).toEqual([]);
  });

  it('bodies the region lies on', () => {
    expect(samples([], [0]).bodies).toEqual([0]);
    expect(samples([{ kind: 'edge', id: 0 }]).bodies).toEqual([0]);
  });
});

describe('regionViewDir', () => {
  it('flat region: along its normal', () => {
    close(regionViewDir(samples([], [0, 1])), [0, 0, 1]);
    close(regionViewDir(samples([], [2, 3])), [0, 0, -1]);
  });

  it('bent but mostly one way: the average normal', () => {
    // top (4 mm², +Z) + right side (2 mm², +X): flatness √20 / 6 ≈ 0.75
    close(regionViewDir(samples([], [0, 1, 4, 5])), [2 / Math.sqrt(20), 0, 4 / Math.sqrt(20)]);
  });

  it('wraps all around (normals cancel): iso corner', () => {
    close(regionViewDir(samples([], [0, 1, 2, 3])), [s3, -s3, s3]);
  });

  it('wraps partly: between the normal and the nearest iso corner', () => {
    const s: RegionSamples = {
      points: new Float32Array(3),
      normalSum: [0, 0, 1],
      area: 4, // flatness 0.25 → half way
      outward: undefined,
      bodies: [],
    };
    const d = regionViewDir(s);
    expect(length(d)).toBeCloseTo(1);
    const toCorner = dot(d, [s3, -s3, s3]);
    expect(d[2]).toBeGreaterThan(toCorner * s3);
    expect(toCorner).toBeGreaterThan(s3);
  });

  it('only edges / vertices: from outside the body; nothing: iso', () => {
    const s = samples([{ kind: 'edge', id: 0 }]);
    expect(regionViewDir(s)).toEqual(s.outward);
    close(regionViewDir({ ...s, outward: undefined }), [s3, -s3, s3]);
  });
});

describe('regionView', () => {
  const whole = { center: [1, 1, 0.5] as Vec3, radius: 1.5 };

  it('top view of the top face: centred, Y up, region fills REGION_FILL', () => {
    const v = regionView(samples([], [0, 1]).points, [0, 0, 1], whole);
    close(v.dir, [0, 0, 1]);
    close(v.up, [0, 1, 0]);
    close(v.target, [1, 1, 1]);
    expect(v.halfSize).toBeCloseTo(1 / REGION_FILL);
    // camera outside the whole model, model between near and far
    expect(v.distance).toBeGreaterThan(whole.radius + 0.5);
    expect(v.near).toBeLessThan(v.distance - 1);
    expect(v.far).toBeGreaterThan(v.distance + 1);
  });

  it('a side view keeps Z up', () => {
    const v = regionView(samples([], [4, 5]).points, [1, 0, 0], whole);
    close(v.up, [0, 0, 1]);
    expect(v.halfSize).toBeCloseTo(1 / REGION_FILL); // 2 wide, 1 high → width counts
  });

  it('a vertex still gets a small picture around it', () => {
    const v = regionView(new Float32Array([2, 2, 1]), [s3, -s3, s3], { ...whole, radius: 100 });
    expect(v.halfSize).toBeCloseTo(2);
    close(v.target, [2, 2, 1]);
  });

  it('no points: the whole model', () => {
    const v = regionView(new Float32Array(0), [0, 0, 1], whole);
    close(v.target, whole.center);
    expect(v.halfSize).toBeCloseTo(whole.radius);
  });
});

describe('regionSize', () => {
  it('defaults to 384 and clamps to 64…768', () => {
    expect(regionSize(undefined)).toBe(REGION_SIZE.default);
    expect(regionSize(Number.NaN)).toBe(384);
    expect(regionSize(10)).toBe(64);
    expect(regionSize(5000)).toBe(768);
    expect(regionSize(500.4)).toBe(500);
  });
});

describe('regionRequest', () => {
  const markers: Marker[] = [
    {
      id: 'm1',
      name: 'A',
      color: '#ff8a1f',
      visible: false,
      entities: [{ kind: 'face', id: 2, seq: 1 }],
    },
    {
      id: 'm2',
      name: 'B',
      color: '#2fbf71',
      visible: true,
      entities: [{ kind: 'edge', id: 0, seq: 2 }],
    },
  ];

  it('the asked markers in their colours, hidden ones too; unknown ids left out', () => {
    const r = regionRequest(markers, ['m1', 'x']);
    expect(r.markerIds).toEqual(['m1']);
    expect(r.styles).toEqual([{ id: 'm1', color: 0xff8a1f, visible: true }]);
    expect(r.entities).toEqual([{ kind: 'face', id: 2, markerId: 'm1', color: '#ff8a1f' }]);
  });
});

describe('flipRows', () => {
  it('turns bottom-up rows top-down and makes alpha opaque', () => {
    const raw = new Uint8Array([1, 1, 1, 0, 2, 2, 2, 0, 3, 3, 3, 0, 4, 4, 4, 0]);
    expect([...flipRows(raw, 2)]).toEqual([3, 3, 3, 255, 4, 4, 4, 255, 1, 1, 1, 255, 2, 2, 2, 255]);
  });
});
