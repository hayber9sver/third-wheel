import { describe, expect, it } from 'vitest';
import { buildBodyBuffers, visibleRuns } from './body-buffers.js';

// 4 triangles over 3 faces; faces → bodies [1, 0, 1]; triangles interleave the bodies.
const model = {
  bodyCount: 3, // body 2 is empty
  indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  triangleFace: new Uint32Array([0, 1, 2, 1]),
  faceBody: new Uint32Array([1, 0, 1]),
  // edge 0: 3 points (2 segments) body 1; edge 1: 2 points body 0; edge 2: degenerate (0 points).
  edgePoints: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 5, 5, 5, 6, 5, 5]),
  edgeRanges: new Uint32Array([0, 3, 3, 2, 0, 0]),
  edgeBody: new Uint32Array([1, 0, 0]),
  edgeChain: new Uint32Array([0, 1, 2]),
};

describe('buildBodyBuffers', () => {
  const b = buildBodyBuffers(model);

  it('groups triangles by body, keeping their order within a body', () => {
    expect(Array.from(b.triangleOrder)).toEqual([1, 3, 0, 2]);
    expect(Array.from(b.indices)).toEqual([3, 4, 5, 9, 10, 11, 0, 1, 2, 6, 7, 8]);
    expect(Array.from(b.triStart)).toEqual([0, 6, 12, 12]);
  });

  it('splits edge polylines into segments grouped by body, skipping degenerate edges', () => {
    expect(Array.from(b.edgeStart)).toEqual([0, 2, 6, 6]);
    expect(Array.from(b.edgeSegments)).toEqual([
      5, 5, 5, 6, 5, 5, // body 0: edge 1
      0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, // body 1: edge 0, two segments
    ]); // prettier-ignore
    expect(Array.from(b.edgeSegmentIds)).toEqual([1, 1, 0, 0, 0, 0]);
  });
});

describe('visibleRuns', () => {
  const starts = new Uint32Array([0, 3, 3, 9, 12]); // body 1 empty

  it('draws everything as one run when all bodies are visible', () => {
    expect(visibleRuns(starts, [true, true, true, true])).toEqual([{ start: 0, count: 12 }]);
  });

  it('treats missing entries as visible and nothing visible as no runs', () => {
    expect(visibleRuns(starts, [])).toEqual([{ start: 0, count: 12 }]);
    expect(visibleRuns(starts, [false, false, false, false])).toEqual([]);
  });

  it('merges neighbours across empty bodies and splits around hidden ones', () => {
    expect(visibleRuns(starts, [true, false, true, false])).toEqual([{ start: 0, count: 9 }]);
    expect(visibleRuns(starts, [true, true, false, true])).toEqual([
      { start: 0, count: 3 },
      { start: 9, count: 3 },
    ]);
  });
});
