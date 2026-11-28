import { describe, expect, it } from 'vitest';
import { edgeChains, edgesInChain, type EdgeEnds } from './edge-chain.js';

/** Edges as [start vertex, end vertex, start tangent, end tangent]. */
function ends(
  list: [number, number, [number, number, number], [number, number, number]][],
): EdgeEnds {
  return {
    vertices: Int32Array.from(list.flatMap(([a, b]) => [a, b])),
    tangents: Float32Array.from(list.flatMap(([, , t0, t1]) => [...t0, ...t1])),
  };
}

describe('edgeChains', () => {
  it('joins edges that continue smoothly, whatever their curve direction', () => {
    const chain = edgeChains(
      ends([
        [0, 1, [1, 0, 0], [1, 0, 0]], // 0 → 1 along +x
        [2, 1, [-1, 0, 0], [-1, 0, 0]], // 2 → 1 along −x: arrives at 1 from the other side
        [1, 3, [0, 1, 0], [0, 1, 0]], // leaves 1 at 90°: a corner
      ]),
      new Uint32Array(3),
    );
    expect(Array.from(chain)).toEqual([0, 0, 2]);
    expect(edgesInChain(chain, 1)).toEqual([0, 1]);
    expect(edgesInChain(chain, 2)).toEqual([2]);
  });

  it('does not join a sharp corner, other bodies or edges with unknown ends', () => {
    const chain = edgeChains(
      ends([
        [0, 1, [1, 0, 0], [1, 0, 0]],
        [1, 2, [Math.cos(0.05), Math.sin(0.05), 0], [1, 0, 0]], // ≈ 2.9°: too sharp
        [1, 4, [1, 0, 0], [1, 0, 0]], // smooth, but another body
        [-1, 1, [NaN, NaN, NaN], [1, 0, 0]], // unknown start: still joins at its end vertex
        [1, 5, [NaN, NaN, NaN], [NaN, NaN, NaN]], // no tangents: joins nothing
      ]),
      Uint32Array.from([0, 0, 1, 0, 0]),
    );
    expect(Array.from(chain)).toEqual([0, 1, 2, 3, 4]);
  });

  it('follows a closed loop back to its start', () => {
    // A square with rounded corners, simplified: four edges, each tangent into the next.
    const chain = edgeChains(
      ends([
        [0, 1, [1, 0, 0], [0, 1, 0]],
        [1, 2, [0, 1, 0], [-1, 0, 0]],
        [2, 3, [-1, 0, 0], [0, -1, 0]],
        [3, 0, [0, -1, 0], [1, 0, 0]],
      ]),
      new Uint32Array(4),
    );
    expect(Array.from(chain)).toEqual([0, 0, 0, 0]);
  });
});
