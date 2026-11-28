import { describe, expect, it } from 'vitest';
import { arrowPoints, labelOffset } from './dimension-overlay.js';

describe('arrowPoints', () => {
  it('a triangle with its tip on the end, pointing away from the other end', () => {
    const pts = arrowPoints({ x: 100, y: 50 }, { x: 0, y: 50 })
      ?.split(' ')
      .map((p) => p.split(',').map(Number));
    expect(pts?.[0]).toEqual([100, 50]);
    // Base 9 px back towards the tail, 3.5 px either side.
    expect(pts?.slice(1).map((p) => p[0])).toEqual([91, 91]);
    expect(
      pts
        ?.slice(1)
        .map((p) => p[1])
        .sort(),
    ).toEqual([46.5, 53.5]);
  });

  it('nothing for a zero-length line', () => {
    expect(arrowPoints({ x: 3, y: 3 }, { x: 3, y: 3 })).toBeUndefined();
  });
});

describe('labelOffset', () => {
  it('above a horizontal line, right of a vertical one, on the point for an angle', () => {
    for (const h of [
      labelOffset({ x: 0, y: 0 }, { x: 100, y: 0 }, 40, 18),
      labelOffset({ x: 100, y: 0 }, { x: 0, y: 0 }, 40, 18),
    ]) {
      expect(h.x).toBeCloseTo(0);
      expect(h.y).toBeCloseTo(-13);
    }
    const v = labelOffset({ x: 0, y: 0 }, { x: 0, y: 100 }, 40, 18);
    expect(v.x).toBeCloseTo(24);
    expect(v.y).toBeCloseTo(0);
    expect(labelOffset({ x: 5, y: 5 }, { x: 5, y: 5 }, 40, 18)).toEqual({ x: 0, y: 0 });
  });
});
