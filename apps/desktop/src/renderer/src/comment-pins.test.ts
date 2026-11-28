import { describe, expect, it } from 'vitest';
import type { Vec3 } from './camera-views.js';
import { closestOnSegment, closestOnTriangle, pinSpecs, pinSpots } from './comment-pins.js';
import { Comments } from './comments.js';
import { counterIds } from './markers.js';

function close(a: Vec3 | undefined, b: Vec3): void {
  expect(a).toBeDefined();
  for (let k = 0; k < 3; k++) expect(a?.[k]).toBeCloseTo(b[k] as number, 6);
}

describe('closestOnTriangle / closestOnSegment', () => {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [10, 0, 0];
  const c: Vec3 = [0, 10, 0];
  it('projects inside, clamps to sides and corners', () => {
    close(closestOnTriangle([2, 3, 5], a, b, c), [2, 3, 0]);
    close(closestOnTriangle([-5, -5, 1], a, b, c), a);
    close(closestOnTriangle([20, -1, 0], a, b, c), b);
    close(closestOnTriangle([5, -3, 0], a, b, c), [5, 0, 0]);
    close(closestOnTriangle([8, 8, 0], a, b, c), [5, 5, 0]);
    close(closestOnTriangle([1, 1, 1], a, a, a), a);
  });
  it('segment: clamps to the ends', () => {
    close(closestOnSegment([5, 4, 0], a, b), [5, 0, 0]);
    close(closestOnSegment([-3, 4, 0], a, b), a);
    close(closestOnSegment([1, 1, 1], a, a), a);
  });
});

describe('pinSpots', () => {
  // A "U": two walls (x = 0 and x = 10) of a channel; the box centre (5, 5, 5) is in the air.
  const positions = new Float32Array([
    0, 0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 10, 0, 0, 10, 10, 0, 10, 0, 10, 10, 10, 10,
  ]);
  const walls = new Uint32Array([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]);
  const none = new Float32Array(0);
  const vertexFace = [0, 0, 0, 0, 1, 1, 1, 1];
  const anchor = (b: Parameters<typeof pinSpots>[0]): Vec3 | undefined =>
    pinSpots(b, positions, vertexFace, undefined, 0)[0];
  it('one spot per face on the surface nearest the centre, not in the air', () => {
    const spots = pinSpots(
      { indices: walls, edgeSegments: none, points: none, outlineSegments: none },
      positions,
      vertexFace,
      undefined,
      0,
    );
    expect(spots).toHaveLength(2);
    expect(spots.map((p) => p[0]).sort()).toEqual([0, 10]);
    for (const p of spots) {
      expect(p[1]).toBeCloseTo(5);
      expect(p[2]).toBeCloseTo(5);
    }
  });
  it('sorted by distance to the centre, capped', () => {
    const edge = new Float32Array([0, 0, 0, 10, 0, 0]); // y = 0: farther than the walls' middles
    const spots = pinSpots(
      { indices: walls, edgeSegments: edge, points: none, outlineSegments: none },
      positions,
      vertexFace,
      undefined,
      0,
    );
    expect(spots).toHaveLength(3);
    close(spots[2], [5, 0, 0]);
    expect(
      pinSpots(
        { indices: walls, edgeSegments: edge, points: none, outlineSegments: none },
        positions,
        vertexFace,
        1,
        0,
      ),
    ).toHaveLength(1);
  });
  it('then spread spots over the triangles, so a face hidden at its nearest point still has others', () => {
    // One face (both walls share face 0): its nearest point is on one wall only.
    const oneFace = [0, 0, 0, 0, 0, 0, 0, 0];
    const spots = pinSpots(
      { indices: walls, edgeSegments: none, points: none, outlineSegments: none },
      positions,
      oneFace,
    );
    expect(spots).toHaveLength(1 + 4); // 1 per face, then each of the 4 triangle centres
    expect(new Set(spots.slice(1).map((p) => p[0]))).toEqual(new Set([0, 10]));
    // Capped and spread evenly: 2 of 4 triangles → one per wall.
    const two = pinSpots(
      { indices: walls, edgeSegments: none, points: none, outlineSegments: none },
      positions,
      oneFace,
      undefined,
      2,
    );
    expect(new Set(two.slice(1).map((p) => p[0]))).toEqual(new Set([0, 10]));
  });
  it('edges and vertices count; empty = undefined', () => {
    const edge = new Float32Array([0, 0, 0, 10, 0, 0]);
    close(
      anchor({
        indices: new Uint32Array(0),
        edgeSegments: edge,
        points: none,
        outlineSegments: none,
      }),
      [5, 0, 0],
    );
    const pt = new Float32Array([3, 4, 5]);
    close(
      anchor({
        indices: new Uint32Array(0),
        edgeSegments: none,
        points: pt,
        outlineSegments: none,
      }),
      [3, 4, 5],
    );
    expect(
      anchor({
        indices: new Uint32Array(0),
        edgeSegments: none,
        points: none,
        outlineSegments: none,
      }),
    ).toBeUndefined();
  });
});

describe('pinSpecs', () => {
  const comments = new Comments(undefined, counterIds('c'));
  comments.add('Fillet\nthis edge', ['m1']); // c1
  comments.add('No markers', []); // c2
  comments.add('On a hidden marker', ['m2']); // c3
  comments.add('Gone marker', ['mX']); // c4
  const resolved = comments.add('Done', ['m1']); // c5
  if (resolved) comments.setStatus(resolved.id, 'resolved');
  comments.add('AI here', ['m2', 'm1'], 'ai'); // c6
  const vis: Record<string, boolean> = { m1: true, m2: false };
  const visible = (id: string): boolean | undefined => vis[id];

  it('numbers by list position; skips no / hidden / gone markers and closed ones', () => {
    const pins = pinSpecs(comments.list(), visible, false, undefined);
    expect(pins.map((p) => [p.id, p.number])).toEqual([
      ['c1', 1],
      ['c6', 6],
    ]);
    expect(pins[0]?.title).toBe('#1 · Fillet');
    expect(pins[1]).toMatchObject({ ai: true, closed: false, markerIds: ['m2', 'm1'] });
  });
  it('closed with "Show resolved"; the focused comment always (its hidden markers show)', () => {
    expect(pinSpecs(comments.list(), visible, true, undefined).map((p) => p.id)).toEqual([
      'c1',
      'c5',
      'c6',
    ]);
    const pins = pinSpecs(comments.list(), visible, false, 'c3');
    expect(pins.map((p) => p.id)).toEqual(['c1', 'c3', 'c6']);
    expect(pins.find((p) => p.id === 'c3')?.focused).toBe(true);
    expect(pinSpecs(comments.list(), visible, false, 'c4').map((p) => p.id)).toEqual(['c1', 'c6']);
  });
});
