import { describe, expect, it } from 'vitest';
import {
  faceTriangles,
  highlightBuffers,
  highlightSphere,
  triangleVertexIndices,
  type HighlightModel,
} from './highlight-buffers.js';

/**
 * Two bodies. Body 0: faces 0 (triangles 0, 2) and 1 (triangle 1); body 1: face 2 (triangle 3).
 * Edge 0 (3 points) in body 0, edge 1 (2 points) in body 1. Vertex 0 in body 0, vertex 1 in body 1.
 */
const model: HighlightModel = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 1, 2, 0, 2, 0, 1, 3, 4, 5]),
  triangleFace: new Uint32Array([0, 1, 0, 2]),
  faceBody: new Uint32Array([0, 0, 1]),
  edgePoints: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 10, 0, 0, 10, 2, 0]),
  edgeRanges: new Uint32Array([0, 3, 3, 2]),
  edgeBody: new Uint32Array([0, 1]),
  vertexPositions: new Float32Array([0, 0, 0, 10, 0, 0]),
  vertexBody: new Uint32Array([0, 1]),
};
const tris = faceTriangles(model.triangleFace, 3);

describe('faceTriangles', () => {
  it('groups triangle ids by face, in order', () => {
    expect([...tris.start]).toEqual([0, 2, 3, 4]);
    expect([...tris.tris]).toEqual([0, 2, 1, 3]);
  });
});

describe('highlightBuffers', () => {
  it('faces → their triangles from the model index buffer', () => {
    const b = highlightBuffers([{ kind: 'face', id: 0 }], model, tris);
    expect([...b.indices]).toEqual([0, 1, 2, 2, 0, 1]);
    expect(b.edgeSegments.length).toBe(0);
    expect(b.points.length).toBe(0);
  });

  it('a body → all its faces, each once even if also selected alone', () => {
    const b = highlightBuffers(
      [
        { kind: 'face', id: 1 },
        { kind: 'body', id: 0 },
      ],
      model,
      tris,
    );
    expect([...b.indices]).toEqual([1, 2, 0, 0, 1, 2, 2, 0, 1]);
  });

  it('outlines the B-rep edges of highlighted bodies only', () => {
    expect(highlightBuffers([{ kind: 'body', id: 1 }], model, tris).outlineSegments).toEqual(
      new Float32Array([10, 0, 0, 10, 2, 0]),
    );
    expect(highlightBuffers([{ kind: 'edge', id: 1 }], model, tris).outlineSegments.length).toBe(0);
  });

  it('edges → segment pairs; vertices → points', () => {
    const b = highlightBuffers(
      [
        { kind: 'edge', id: 0 },
        { kind: 'vertex', id: 1 },
      ],
      model,
      tris,
    );
    expect([...b.edgeSegments]).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect([...b.points]).toEqual([10, 0, 0]);
  });

  it('skips entities of hidden bodies and unknown ids', () => {
    const items = [
      { kind: 'face', id: 2 },
      { kind: 'edge', id: 1 },
      { kind: 'vertex', id: 1 },
      { kind: 'body', id: 1 },
      { kind: 'face', id: 99 },
    ] as const;
    const b = highlightBuffers(items, model, tris, [true, false]);
    expect(b.indices.length + b.edgeSegments.length + b.points.length).toBe(0);
    expect(highlightBuffers(items, model, tris).indices.length).toBe(3);
  });
});

describe('highlightSphere', () => {
  it('encloses all highlighted geometry', () => {
    const b = highlightBuffers(
      [
        { kind: 'face', id: 1 },
        { kind: 'vertex', id: 1 },
      ],
      model,
      tris,
    );
    const s = highlightSphere(b, model.positions);
    expect(s?.center).toEqual([5, 0.5, 0]);
    expect(s?.radius).toBeCloseTo(Math.hypot(5, 0.5));
  });

  it('can include extra triangles (painted triangles)', () => {
    const b = highlightBuffers([{ kind: 'vertex', id: 1 }], model, tris);
    const extra = triangleVertexIndices([0], model.indices);
    expect(extra.length).toBe(3);
    const s = highlightSphere({ ...b, indices: extra }, model.positions);
    expect(s).toBeDefined();
    expect(s?.radius).toBeGreaterThan(0);
  });

  it('is undefined when nothing is highlighted', () => {
    expect(highlightSphere(highlightBuffers([], model, tris), model.positions)).toBeUndefined();
  });
});
