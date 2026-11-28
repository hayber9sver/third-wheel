import { describe, expect, it } from 'vitest';
import { BufferAttribute } from 'three';
import { FADED_PAINT_OPACITY, PaintOverlay, type MarkerStyle } from './paint-overlay.js';
import { PAINT_BLOCK, PaintLayer, PaintRecord, forEachPiece, type PaintSphere } from './paint.js';

/** n × n squares of 5 mm, 2 triangles each; bodies: triangles below `split` → 0, rest → 1. */
function grid(n: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) positions.push(i * 5, j * 5, 0);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j;
      const b = a + n + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const count = indices.length / 3;
  const split = Math.floor(count * 0.6);
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    triBody: Uint32Array.from({ length: count }, (_, t) => (t < split ? 0 : 1)),
    count,
  };
}

const g = grid(90); // 16 200 triangles: 4 paint blocks
const all = Array.from({ length: g.count }, (_, t) => t);

function overlay(): PaintOverlay {
  const normals = new Float32Array(g.positions.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return new PaintOverlay(
    new BufferAttribute(g.positions, 3),
    new BufferAttribute(normals, 3),
    g.indices,
    g.triBody,
  );
}

/** What an overlay draws: per marker colour, sorted triangle keys and a checksum of its pieces. */
function drawn(o: PaintOverlay) {
  const out: Record<string, { whole: string[]; pieces: number; sum: number }> = {};
  const entry = (color: number) => (out[color.toString(16)] ??= { whole: [], pieces: 0, sum: 0 });
  if (o.mesh.visible) {
    const index = o.mesh.geometry.getIndex()?.array ?? [];
    for (const group of o.mesh.geometry.groups) {
      const e = entry(o.mesh.material[group.materialIndex ?? 0]?.color.getHex() ?? -1);
      for (let i = group.start; i < group.start + group.count; i += 3)
        e.whole.push(`${String(index[i])},${String(index[i + 1])},${String(index[i + 2])}`);
    }
  }
  if (o.pieceMesh.visible) {
    const pos = o.pieceMesh.geometry.getAttribute('position').array;
    for (const group of o.pieceMesh.geometry.groups) {
      const e = entry(o.pieceMesh.material[group.materialIndex ?? 0]?.color.getHex() ?? -1);
      e.pieces += group.count / 3;
      for (let i = group.start * 3; i < (group.start + group.count) * 3; i++) e.sum += pos[i] ?? 0;
    }
  }
  for (const e of Object.values(out)) {
    e.whole.sort();
    e.sum = Math.round(e.sum * 1000) / 1000;
  }
  return { out, triangles: o.shownTriangles, pieces: o.shownPieces };
}

const line = (y: number, radius: number, from = 20, to = 400): PaintSphere[] => {
  const s: PaintSphere[] = [];
  for (let x = from; x <= to; x += radius / 2) s.push({ center: [x, y, 0], radius });
  return s;
};

describe('PaintOverlay block-wise rebuild', () => {
  it('the grid spans several paint blocks', () => {
    expect(g.count).toBeGreaterThan(3 * PAINT_BLOCK);
  });

  it('draws the same as a fresh build after every kind of edit', () => {
    const layer = new PaintLayer(g.count, g);
    const live = overlay();
    let styles: MarkerStyle[] = [
      { id: 'm1', color: 0xff0000, visible: true },
      { id: 'm2', color: 0x00ff00, visible: true },
    ];
    let visible = [true, true];
    const check = (): void => {
      live.update(layer, styles, visible);
      const fresh = overlay();
      fresh.update(layer, styles, visible);
      expect(drawn(live)).toEqual(drawn(fresh));
    };
    const none = new Set<string>();
    const record = new PaintRecord();

    // A long stroke in small steps (one update per step, as per frame).
    const stroke = line(200, 3);
    for (let i = 0; i < stroke.length; i += 4) {
      layer.paint(all, 'm1', none, record, stroke.slice(i, i + 4));
      live.update(layer, styles, visible);
    }
    check();
    expect(live.shownPieces).toBeGreaterThan(0);
    // Whole triangles: the same set as the layer's own scan.
    const whole = layer.groups(['m1'])[0]?.triangles.length ?? 0;
    expect(drawn(live).out['ff0000']?.whole.length).toBe(whole);

    layer.paint(all, 'm2', none, record, line(210, 12)); // over m1, big brush
    check();
    layer.paint(all.slice(0, 500), 'm2', none, record); // Smart fill: whole triangles
    check();
    layer.erase(all, none, record, line(205, 4, 100, 300));
    check();
    styles = [
      { id: 'm1', color: 0xff0000, visible: true },
      { id: 'm2', color: 0x00ff00, visible: false }, // hide m2
    ];
    check();
    styles = [
      { id: 'm1', color: 0x0000ff, visible: true }, // recolour
      { id: 'm2', color: 0x00ff00, visible: true },
    ];
    check();
    visible = [true, false]; // hide body 1
    check();
    layer.paint(all, 'm1', none, record, line(150, 5)); // paint while a body is hidden
    check();
    visible = [true, true];
    check();
    record.seal();
    layer.restore(record, 'before'); // undo everything
    check();
    expect(live.mesh.visible || live.pieceMesh.visible).toBe(false);
    layer.restore(record, 'after'); // redo
    check();
    layer.retainMarkers(['m2']); // delete m1
    check();
  });

  it('starts over for a new paint layer', () => {
    const live = overlay();
    const styles: MarkerStyle[] = [{ id: 'm1', color: 0xff0000, visible: true }];
    const a = new PaintLayer(g.count, g);
    a.paint(all, 'm1', new Set(), undefined, line(100, 3));
    live.update(a, styles, [true, true]);
    const b = new PaintLayer(g.count, g); // same stamps / version numbers, other paint
    b.paint(all, 'm1', new Set(), undefined, line(300, 3));
    live.update(b, styles, [true, true]);
    const fresh = overlay();
    fresh.update(b, styles, [true, true]);
    expect(drawn(live)).toEqual(drawn(fresh));
  });

  it('counts each cut triangle once, even with pieces of two markers', () => {
    const layer = new PaintLayer(g.count, g);
    const none = new Set<string>();
    layer.paint(all, 'm1', none, undefined, line(200, 3, 50, 60));
    layer.paint(all, 'm2', none, undefined, line(202, 3, 50, 60));
    const o = overlay();
    o.update(
      layer,
      [
        { id: 'm1', color: 1, visible: true },
        { id: 'm2', color: 2, visible: true },
      ],
      [true, true],
    );
    let pieces = 0;
    for (const [, node] of layer.splitEntries()) {
      forEachPiece(node, (slot) => {
        if (slot !== 0) pieces++;
      });
    }
    expect(layer.splitCount).toBeGreaterThan(0);
    expect(overlapCut(layer)).toBeGreaterThan(0);
    expect(o.shownTriangles).toBe(layer.count('m1') + layer.count('m2') - overlapCut(layer));
    expect(o.shownPieces).toBe(pieces);
  });
});

/** Cut triangles holding paint of both markers (counted once by the overlay, twice by `count`). */
function overlapCut(layer: PaintLayer): number {
  const m1 = layer.slotOfMarker('m1');
  const m2 = layer.slotOfMarker('m2');
  let both = 0;
  for (const [, node] of layer.splitEntries()) {
    const slots = new Set<number>();
    forEachPiece(node, (slot) => slots.add(slot));
    if (m1 !== undefined && m2 !== undefined && slots.has(m1) && slots.has(m2)) both++;
  }
  return both;
}

describe('PaintOverlay fade while comparing', () => {
  it('fades every marker material, also ones made later, and back to solid', () => {
    const layer = new PaintLayer(g.count, g);
    const o = overlay();
    layer.paint(all, 'm1', new Set(), new PaintRecord(), line(60, 3));
    const styles: MarkerStyle[] = [{ id: 'm1', color: 0xff0000, visible: true }];
    o.update(layer, styles, [true, true]);
    const materials = () => [...o.mesh.material, ...o.pieceMesh.material];
    expect(materials().length).toBeGreaterThan(0);
    o.setFaded(true);
    for (const m of materials())
      expect(m).toMatchObject({
        transparent: true,
        opacity: FADED_PAINT_OPACITY,
        depthWrite: false,
      });
    layer.paint(all, 'm2', new Set(), new PaintRecord(), line(40, 3));
    o.update(layer, [...styles, { id: 'm2', color: 0x00ff00, visible: true }], [true, true]);
    for (const m of materials()) expect(m.opacity).toBe(FADED_PAINT_OPACITY);
    o.setFaded(false);
    for (const m of materials())
      expect(m).toMatchObject({ transparent: false, opacity: 1, depthWrite: true });
  });
});
