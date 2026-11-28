import { describe, expect, it } from 'vitest';
import {
  boxAction,
  boxLabel,
  boxMode,
  boxRect,
  boxSelectItems,
  projectsInside,
  visibleIds,
  type BoxModel,
  type Projection,
} from './box-select.js';
import { faceTriangles } from './highlight-buffers.js';
import { encodePick } from './pick-resolve.js';
import { DEFAULT_FILTER } from './selection-filter.js';

/** Orthographic-like test projection: world x,y in [0,100] → canvas 100×100 (y down), w = 1. */
const identity: Projection = {
  // Column-major: ndc.x = x/50 - 1, ndc.y = 1 - y/50 → canvas (x, y) = world (x, y).
  matrix: [1 / 50, 0, 0, 0, 0, -1 / 50, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1],
  width: 100,
  height: 100,
};

describe('boxMode / boxAction', () => {
  it('no Alt = window (fully inside), Alt = crossing', () => {
    expect(boxMode(false)).toBe('window');
    expect(boxMode(true)).toBe('crossing');
  });

  it('left→right = add, right→left = remove; a straight vertical drag adds', () => {
    expect(boxAction(10, 50)).toBe('add');
    expect(boxAction(50, 10)).toBe('remove');
    expect(boxAction(30, 30)).toBe('add');
  });
});

describe('boxLabel', () => {
  it('says what releasing does and how to switch the mode', () => {
    expect(boxLabel('add', 'window')).toBe('+ inside · Alt: crossing');
    expect(boxLabel('remove', 'window')).toBe('− inside · Alt: crossing');
    expect(boxLabel('add', 'crossing')).toBe('+ crossing · release Alt: inside');
    expect(boxLabel('remove', 'crossing')).toBe('− crossing · release Alt: inside');
  });
});

describe('boxRect', () => {
  it('orders corners and clips to the canvas', () => {
    expect(boxRect({ x: 80, y: -5 }, { x: 20, y: 40 }, 60, 100)).toEqual({
      x0: 20,
      y0: 0,
      x1: 60,
      y1: 40,
    });
  });
});

describe('projectsInside', () => {
  const rect = { x0: 10, y0: 10, x1: 50, y1: 50 };
  it('maps world to canvas through the matrix', () => {
    expect(projectsInside(identity, rect, 20, 30, 0)).toBe(true);
    expect(projectsInside(identity, rect, 60, 30, 0)).toBe(false);
    expect(projectsInside(identity, rect, 20, 5, 0)).toBe(false);
  });
  it('rejects points behind the camera (w ≤ 0)', () => {
    const behind = { ...identity, matrix: [...Array.from(identity.matrix).slice(0, 15), -1] };
    expect(projectsInside(behind, rect, 20, 30, 0)).toBe(false);
  });
});

describe('visibleIds', () => {
  it('collects ids per kind and skips background', () => {
    const px = new Uint8Array([
      ...encodePick('face', 3),
      0,
      0,
      0,
      0,
      ...encodePick('edge', 70000),
      ...encodePick('face', 3),
      ...encodePick('vertex', 1),
    ]);
    const v = visibleIds(px);
    expect([...v.face]).toEqual([3]);
    expect([...v.edge]).toEqual([70000]);
    expect([...v.vertex]).toEqual([1]);
  });
});

/**
 * Two bodies side by side in the canvas plane: body 0 = face 0 (square 10..30), body 1 = faces 1
 * (square 40..60) and 2 (square 60..80). Edge 0 runs 10..30 along y = 10, edge 1 runs 40..80.
 * Vertex 0 at (10, 10), vertex 1 at (80, 10).
 */
function twoBodies(): BoxModel & { triangleFace: Uint32Array } {
  const square = (x0: number, x1: number): number[] => [x0, 10, 0, x1, 10, 0, x1, 30, 0, x0, 30, 0];
  const positions = new Float32Array([...square(10, 30), ...square(40, 60), ...square(60, 80)]);
  const quad = (b: number): number[] => [b, b + 1, b + 2, b, b + 2, b + 3];
  return {
    positions,
    indices: new Uint32Array([...quad(0), ...quad(4), ...quad(8)]),
    triangleFace: new Uint32Array([0, 0, 1, 1, 2, 2]),
    faceBody: new Uint32Array([0, 1, 1]),
    edgePoints: new Float32Array([10, 10, 0, 30, 10, 0, 40, 10, 0, 80, 10, 0]),
    edgeRanges: new Uint32Array([0, 2, 2, 2]),
    vertexPositions: new Float32Array([10, 10, 0, 80, 10, 0]),
    vertexBody: new Uint32Array([0, 1]),
  };
}

describe('boxSelectItems', () => {
  const model = twoBodies();
  const tris = faceTriangles(model.triangleFace, 3);
  const all = {
    face: new Set([0, 1, 2]),
    edge: new Set([0, 1]),
    vertex: new Set([0, 1]),
  };
  const rect = { x0: 5, y0: 5, x1: 65, y1: 35 }; // covers body 0 fully, body 1 half

  it('window: only entities fully inside, in kind order', () => {
    expect(boxSelectItems(all, model, tris, identity, rect, 'window', DEFAULT_FILTER)).toEqual([
      { kind: 'face', id: 0 },
      { kind: 'face', id: 1 },
      { kind: 'edge', id: 0 },
      { kind: 'vertex', id: 0 },
    ]);
  });

  it('crossing: every visible entity touching the box', () => {
    expect(boxSelectItems(all, model, tris, identity, rect, 'crossing', DEFAULT_FILTER)).toEqual([
      { kind: 'face', id: 0 },
      { kind: 'face', id: 1 },
      { kind: 'face', id: 2 },
      { kind: 'edge', id: 0 },
      { kind: 'edge', id: 1 },
      { kind: 'vertex', id: 0 },
      { kind: 'vertex', id: 1 },
    ]);
  });

  it('never selects what is not visible, even fully inside', () => {
    const someHidden = { face: new Set([1]), edge: new Set<number>(), vertex: new Set<number>() };
    expect(
      boxSelectItems(someHidden, model, tris, identity, rect, 'window', DEFAULT_FILTER),
    ).toEqual([{ kind: 'face', id: 1 }]);
  });

  it('follows the filter; a body needs all its faces inside in window mode', () => {
    const bodies = { vertex: false, edge: false, face: false, body: true };
    expect(boxSelectItems(all, model, tris, identity, rect, 'window', bodies)).toEqual([
      { kind: 'body', id: 0 },
    ]);
    expect(boxSelectItems(all, model, tris, identity, rect, 'crossing', bodies)).toEqual([
      { kind: 'body', id: 0 },
      { kind: 'body', id: 1 },
    ]);
  });
});
