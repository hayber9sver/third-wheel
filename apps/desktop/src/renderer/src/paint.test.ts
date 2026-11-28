import { describe, expect, it } from 'vitest';
import { forEachPiece, PaintLayer, PaintRecord } from './paint.js';

const none = new Set<string>();

describe('PaintLayer', () => {
  it('paints, repaints with another marker and counts per marker', () => {
    const p = new PaintLayer(10);
    expect(p.paint([0, 1, 2], 'm1', none)).toBe(3);
    expect(p.paint([2, 3], 'm2', none)).toBe(2);
    expect(p.paint([3], 'm2', none)).toBe(0);
    expect(p.count('m1')).toBe(2);
    expect(p.count('m2')).toBe(2);
    expect(p.count('m9')).toBe(0);
    expect(p.markerAt(2)).toBe('m2');
    expect(p.markerAt(5)).toBeUndefined();
  });

  it('erases any marker except locked (hidden) ones; painting skips locked too', () => {
    const p = new PaintLayer(6);
    p.paint([0, 1], 'm1', none);
    p.paint([2, 3], 'm2', none);
    const locked = new Set(['m2']);
    expect(p.erase([0, 2, 5], locked)).toBe(1);
    expect(p.markerAt(0)).toBeUndefined();
    expect(p.markerAt(2)).toBe('m2');
    expect(p.paint([1, 3, 4], 'm1', locked)).toBe(1);
    expect(p.markerAt(3)).toBe('m2');
    expect(p.count('m1')).toBe(2);
  });

  it('bumps version only on real changes', () => {
    const p = new PaintLayer(4);
    const v0 = p.version;
    p.erase([0], none);
    expect(p.version).toBe(v0);
    p.paint([0], 'm1', none);
    expect(p.version).toBe(v0 + 1);
  });

  it('drops the paint of deleted markers and reuses their slot', () => {
    const p = new PaintLayer(4);
    p.paint([0, 1], 'm1', none);
    p.paint([2], 'm2', none);
    p.retainMarkers(['m2']);
    expect(p.count('m1')).toBe(0);
    expect(p.markerAt(0)).toBeUndefined();
    expect(p.markerAt(2)).toBe('m2');
    p.paint([3], 'm3', none);
    expect(p.markerAt(3)).toBe('m3');
    expect(p.markerAt(2)).toBe('m2');
  });

  it('groups painted triangles by marker in the given order, filtered', () => {
    const p = new PaintLayer(6);
    p.paint([0, 4], 'm1', none);
    p.paint([1, 5], 'm2', none);
    const g = p.groups(['m2', 'm1'], (t) => t !== 5);
    expect(g.map((x) => [x.markerId, [...x.triangles]])).toEqual([
      ['m2', [1]],
      ['m1', [0, 4]],
    ]);
    expect(p.groups(['m1'], (t) => t > 4)).toEqual([]);
    expect(p.groups([])).toEqual([]);
  });

  it('records a stroke and restores before / after', () => {
    const p = new PaintLayer(6);
    p.paint([0, 1], 'm1', none);
    const r = new PaintRecord();
    p.paint([1, 2], 'm2', none, r);
    p.erase([0, 2], none, r); // triangle 2 changes twice: before = none, after = none
    expect(r.size).toBe(3);
    const v = p.version;
    p.restore(r.seal(), 'before');
    expect(p.version).toBeGreaterThan(v);
    expect([0, 1, 2].map((t) => p.markerAt(t))).toEqual(['m1', 'm1', undefined]);
    expect(p.count('m1')).toBe(2);
    expect(p.count('m2')).toBe(0);
    p.restore(r, 'after');
    expect([0, 1, 2].map((t) => p.markerAt(t))).toEqual([undefined, 'm2', undefined]);
    expect(p.count('m2')).toBe(1);
  });

  it("records a marker's paint so a delete can be undone after its slot is reused", () => {
    const p = new PaintLayer(5);
    p.paint([0, 1], 'm1', none);
    p.paint([2], 'm2', none);
    const lost = p.recordMarker('m1').seal();
    expect(lost.size).toBe(2);
    p.retainMarkers(['m2']);
    p.paint([3], 'm3', none); // takes m1's free slot
    p.restore(lost, 'before');
    expect([0, 1, 2, 3].map((t) => p.markerAt(t))).toEqual(['m1', 'm1', 'm2', 'm3']);
    expect(p.count('m1')).toBe(2);
    expect(p.count('m3')).toBe(1);
    expect(p.recordMarker('m9').size).toBe(0);
  });
});

/** One big flat square 100 × 100 at z = 0 as 2 triangles (like a CAD face). */
function square(): { positions: Float32Array; indices: Uint32Array } {
  return {
    positions: new Float32Array([0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

describe('PaintLayer finer paint', () => {
  const none = new Set<string>();
  const dot = (x: number, y: number, radius = 3) => [{ center: [x, y, 0] as const, radius }];

  it('a small stamp on a big triangle paints only about the ball area', () => {
    const p = new PaintLayer(2, square());
    expect(p.paint([0], 'm1', none, undefined, dot(70, 30))).toBe(1);
    expect(p.splitCount).toBe(1);
    expect(p.count('m1')).toBe(1);
    expect(p.markerAt(0)).toBeUndefined(); // in pieces
    const area = p.paintedArea('m1');
    expect(area).toBeGreaterThan(Math.PI * 9 * 0.6);
    expect(area).toBeLessThan(Math.PI * 9 * 1.6);
    // Pieces cover the triangle exactly (barycentric areas sum to 1).
    const [[t, node] = [-1, 0]] = [...p.splitEntries()];
    expect(t).toBe(0);
    let share = 0;
    let painted = 0;
    forEachPiece(node, (slot, u0, v0, u1, v1, u2, v2) => {
      const a = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
      share += a;
      if (slot === p.slotOfMarker('m1')) painted++;
    });
    expect(share).toBeCloseTo(1, 9);
    expect(painted).toBeGreaterThan(4);
  });

  it('a stamp that changes nothing keeps the pieces object and the block stamp', () => {
    const p = new PaintLayer(2, square());
    p.paint([0], 'm1', none, undefined, dot(70, 30));
    const node = p.splitAt(0);
    const edit = p.blockEdit(0);
    expect(edit).toBeGreaterThan(0);
    expect(p.paint([0], 'm1', none, undefined, dot(70, 30))).toBe(0); // same stamp again
    expect(p.splitAt(0)).toBe(node);
    expect(p.blockEdit(0)).toBe(edit);
    p.paint([0], 'm1', none, undefined, dot(75, 30));
    expect(p.blockEdit(0)).toBeGreaterThan(edit);
  });

  it('erasing all paint of a cut triangle leaves it plain again', () => {
    const p = new PaintLayer(2, square());
    p.paint([0], 'm1', none, undefined, dot(70, 30));
    p.paint([0], 'm1', none, undefined, dot(75, 30));
    expect(p.erase([0], none, undefined, dot(72, 30, 10))).toBe(1);
    expect(p.splitCount).toBe(0);
    expect(p.stateAt(0)).toBeUndefined();
    expect(p.count('m1')).toBe(0);
    expect([...p.splitEntries()]).toEqual([]);
  });

  it('Smart fill (no spheres) replaces pieces with the whole triangle', () => {
    const p = new PaintLayer(2, square());
    p.paint([0], 'm1', none, undefined, dot(70, 30));
    p.paint([0, 1], 'm2', none);
    expect(p.splitCount).toBe(0);
    expect([p.markerAt(0), p.markerAt(1)]).toEqual(['m2', 'm2']);
    expect(p.count('m1')).toBe(0);
    expect(p.count('m2')).toBe(2);
  });

  it('a ball covering the triangle paints it whole; small triangles keep the touch rule', () => {
    const p = new PaintLayer(2, square());
    p.paint([0], 'm1', none, undefined, dot(70, 30));
    p.paint([0], 'm1', none, undefined, dot(50, 50, 80));
    expect(p.splitCount).toBe(0);
    expect(p.markerAt(0)).toBe('m1');
    // Brush radius 300 → piece size 100: the 141-long triangle 1 is cut once, then touch rule.
    const q = new PaintLayer(2, square());
    q.paint([1], 'm1', none, undefined, [{ center: [0, 100, -299], radius: 300 }]);
    expect(q.count('m1')).toBe(1);
  });

  it('pieces of a hidden (locked) marker stay; others are painted over', () => {
    const p = new PaintLayer(2, square());
    p.paint([0], 'm1', none, undefined, dot(70, 30));
    const before = p.paintedArea('m1');
    p.paint([0], 'm2', new Set(['m1']));
    expect(p.paintedArea('m1')).toBeCloseTo(before, 6);
    expect(p.count('m2')).toBe(1);
    expect(p.paintedArea('m2') + before).toBeCloseTo(5000, 3);
    p.erase([0], new Set(['m1']));
    expect(p.paintedArea('m1')).toBeCloseTo(before, 6);
    expect(p.count('m2')).toBe(0);
  });

  it('undo / redo bring back the exact pieces', () => {
    const p = new PaintLayer(2, square());
    p.paint([0], 'm1', none, undefined, dot(70, 30));
    const first = p.stateAt(0);
    const r = new PaintRecord();
    p.paint([0], 'm1', none, r, dot(80, 20));
    p.erase([0], none, r, dot(70, 30, 2));
    const after = p.stateAt(0);
    p.restore(r.seal(), 'before');
    expect(p.stateAt(0)).toEqual(first);
    p.restore(r, 'after');
    expect(p.stateAt(0)).toEqual(after);
    expect(p.count('m1')).toBe(1);
  });

  it('deleting a marker drops its pieces (and merges), undo brings them back', () => {
    const p = new PaintLayer(2, square());
    p.paint([0], 'm1', none, undefined, dot(70, 30));
    p.paint([0], 'm2', none, undefined, dot(80, 20));
    const state = p.stateAt(0);
    const lost = p.recordMarker('m1').seal();
    expect(lost.size).toBe(1);
    p.retainMarkers(['m2']);
    expect(p.count('m1')).toBe(0);
    expect(p.paintedArea('m2')).toBeGreaterThan(0);
    p.retainMarkers([]);
    expect(p.splitCount).toBe(0);
    p.restore(lost, 'before'); // m2 is gone too: restores m1's pieces only where recorded
    expect(p.count('m1')).toBe(1);
    const q = new PaintLayer(2, square());
    q.paint([0], 'm1', none, undefined, dot(70, 30));
    q.paint([0], 'm2', none, undefined, dot(80, 20));
    expect(q.stateAt(0)).toEqual(state);
  });
});

describe('PaintLayer lookups', () => {
  const none = new Set<string>();
  it('markersAt lists whole and piece paint; trianglesOf finds a set of markers', () => {
    const p = new PaintLayer(2, square());
    p.paint([1], 'm2', none);
    p.paint([0], 'm1', none, undefined, [{ center: [70, 30, 0], radius: 3 }]);
    p.paint([0], 'm3', none, undefined, [{ center: [90, 20, 0], radius: 3 }]);
    expect(p.markersAt(0).sort()).toEqual(['m1', 'm3']);
    expect(p.markersAt(1)).toEqual(['m2']);
    expect([...p.trianglesOf(['m1'])]).toEqual([0]);
    expect([...p.trianglesOf(['m2', 'm3'])]).toEqual([0, 1]);
    expect([...p.trianglesOf(['nope'])]).toEqual([]);
    const by = p.trianglesByMarker(['m1', 'm2', 'm3', 'nope', 'm1']);
    expect([...by.entries()].sort()).toEqual([
      ['m1', [0]],
      ['m2', [1]],
      ['m3', [0]],
    ]);
  });
});
