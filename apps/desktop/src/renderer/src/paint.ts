/**
 * Paint layer: which marker painted each triangle of the import (pure, no three.js).
 * One marker per triangle — painting with another marker repaints it. Triangles owned by a
 * marker in `locked` (hidden markers) are never painted over or erased.
 *
 * Finer paint (like the PrusaSlicer / OrcaSlicer paint tools): a brush stamp whose circle
 * edge crosses a big triangle cuts it into 4 at its edge midpoints, again and again near the
 * circle edge, until the pieces are about a third of the brush radius; a piece is painted when
 * its centre is inside the ball. Only the paint is cut — the model, picking and Smart fill keep
 * the import triangles. Whenever the 4 pieces of a triangle end up alike they merge again, so
 * erasing all paint of a cut triangle leaves it plain (nothing stored).
 */

/**
 * Paint of one triangle: a marker slot (0 = none), or 4 pieces — children 0 (a, ab, ca),
 * 1 (ab, b, bc), 2 (ca, bc, c), 3 (ab, bc, ca), where ab… are edge midpoints.
 */
export type PaintNode = number | readonly [PaintNode, PaintNode, PaintNode, PaintNode];

/** Paint of one triangle as marker ids (undo records keep ids, not slots). */
export type PaintState =
  string | undefined | readonly [PaintState, PaintState, PaintState, PaintState];

/** A brush stamp. */
export interface PaintSphere {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** The import's triangles (`indices[3t..3t+2]` into `positions`). */
export interface PaintGeometry {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

/**
 * Triangles per paint block: the layer stamps a block on every change of its paint, so
 * renderers rebuild only the blocks that changed (a brush step touches a few dozen triangles of
 * a million).
 */
export const PAINT_BLOCK = 4096;

/** Pieces are cut until their longest edge is at most radius × this. */
export const PIECE_SIZE = 1 / 3;
/** Cuts at most this deep (a piece is 4^-depth of its triangle). */
export const MAX_PIECE_DEPTH = 14;

/** `owner` value of a triangle that is cut into pieces (see `piecesOf`). */
const SPLIT = 0xffff;

type V3 = readonly [number, number, number];

/** Slot 0 = unpainted; slot n ≥ 1 = `slotIds[n]`. */
export class PaintLayer {
  /** Per triangle: marker slot (0 = none, `SPLIT` = cut into pieces). */
  readonly owner: Uint16Array;
  private readonly slotIds: (string | undefined)[] = [undefined];
  private readonly slotOf = new Map<string, number>();
  /** Per slot: triangles holding any paint of it (whole or some pieces). */
  private readonly counts: number[] = [0];
  /** Cut triangles → their pieces. */
  private readonly split = new Map<number, PaintNode>();
  /** Bumped on every change (renderers rebuild when it moves). */
  version = 0;
  /** Per block of `PAINT_BLOCK` triangles: stamp of its last change (0 = never changed). */
  private readonly blockEdits: Uint32Array;
  private edits = 0;

  /** Without `geometry`, brush stamps paint whole triangles (tests). */
  constructor(
    readonly triangleCount: number,
    private readonly geometry?: PaintGeometry,
  ) {
    this.owner = new Uint16Array(triangleCount);
    this.blockEdits = new Uint32Array(Math.ceil(triangleCount / PAINT_BLOCK));
  }

  /** Number of paint blocks (`PAINT_BLOCK` triangles each, the last one may be shorter). */
  get blockCount(): number {
    return this.blockEdits.length;
  }

  /**
   * Stamp of block `b`'s last paint change: a renderer that saw another stamp rebuilds the
   * block. Stamps only grow; 0 = never changed.
   */
  blockEdit(b: number): number {
    return this.blockEdits[b] ?? 0;
  }

  /** Pieces of triangle `t` when it is cut, else undefined (same object until its paint changes). */
  splitAt(t: number): PaintNode | undefined {
    return this.split.get(t);
  }

  /**
   * Paint `triangles` with `markerId`, except paint of a locked marker. With `spheres` (brush
   * stamps), triangles the ball edge crosses are painted in pieces; without (Smart fill), whole.
   * Returns how many triangles changed.
   */
  paint(
    triangles: Iterable<number>,
    markerId: string,
    locked: ReadonlySet<string>,
    record?: PaintRecord,
    spheres?: readonly PaintSphere[],
  ): number {
    return this.apply(triangles, this.slotFor(markerId), locked, record, spheres);
  }

  /** Clear paint on `triangles` (pieces with `spheres`), except of locked markers. */
  erase(
    triangles: Iterable<number>,
    locked: ReadonlySet<string>,
    record?: PaintRecord,
    spheres?: readonly PaintSphere[],
  ): number {
    return this.apply(triangles, 0, locked, record, spheres);
  }

  /**
   * Puts back the paint a record saw before (`'before'`, undo) or left after (`'after'`, redo).
   * Ignores locks — undo restores exactly. The markers named must exist again by then.
   */
  restore(record: PaintRecord, side: 'before' | 'after'): void {
    let changed = false;
    for (let i = 0; i < record.size; i++) {
      const t = record.triangleAt(i);
      if (t >= this.triangleCount) continue;
      const node = this.toNode(record.stateAt(i, side));
      if (nodeEquals(node, this.nodeAt(t))) continue;
      this.setNode(t, node);
      changed = true;
    }
    if (changed) this.version++;
  }

  /** Record of the current paint of `markerId` (before = with it, after = without): for delete undo. */
  recordMarker(markerId: string): PaintRecord {
    const record = new PaintRecord();
    const slot = this.slotOf.get(markerId);
    if (slot === undefined || (this.counts[slot] ?? 0) === 0) return record;
    const owner = this.owner;
    for (let t = 0; t < owner.length; t++) {
      const o = owner[t];
      if (o === slot) record.note(t, markerId, undefined);
      else if (o === SPLIT) {
        const node = this.split.get(t) ?? 0;
        if (!nodeHas(node, slot)) continue;
        const without = mapNode(node, (s) => (s === slot ? 0 : s));
        record.note(t, this.toState(node), this.toState(without));
      }
    }
    return record;
  }

  /** Number of triangles holding paint of `markerId` (whole or some pieces). */
  count(markerId: string): number {
    const slot = this.slotOf.get(markerId);
    return slot === undefined ? 0 : (this.counts[slot] ?? 0);
  }

  /** Marker of a whole-painted triangle `t`; undefined when unpainted or cut into pieces. */
  markerAt(t: number): string | undefined {
    const o = this.owner[t] ?? 0;
    return o === SPLIT ? undefined : this.slotIds[o];
  }

  /** Paint of triangle `t` as marker ids (pieces as nested 4-tuples). */
  stateAt(t: number): PaintState {
    return this.toState(this.nodeAt(t));
  }

  /** Markers with any paint (whole or a piece) on triangle `t` (comments on a click). */
  markersAt(t: number): string[] {
    const out: string[] = [];
    for (const s of slotsIn(this.nodeAt(t))) {
      const id = this.slotIds[s];
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  /** Triangles holding any paint (whole or a piece) of one of `markerIds`, ascending. */
  trianglesOf(markerIds: Iterable<string>): Uint32Array {
    const slots = new Set<number>();
    for (const id of markerIds) {
      const s = this.slotOf.get(id);
      if (s !== undefined && (this.counts[s] ?? 0) > 0) slots.add(s);
    }
    if (slots.size === 0) return new Uint32Array(0);
    const out: number[] = [];
    const owner = this.owner;
    for (let t = 0; t < owner.length; t++) {
      const o = owner[t] ?? 0;
      if (o === 0) continue;
      if (o === SPLIT) {
        const node = this.split.get(t) ?? 0;
        for (const s of slots) {
          if (nodeHas(node, s)) {
            out.push(t);
            break;
          }
        }
      } else if (slots.has(o)) out.push(t);
    }
    return Uint32Array.from(out);
  }

  /**
   * Triangles holding paint of each of `markerIds` (one pass for all — comment pins).
   * Markers without paint are left out.
   */
  trianglesByMarker(markerIds: Iterable<string>): Map<string, number[]> {
    const bySlot = new Map<number, number[]>();
    const idOf = new Map<number, string>();
    for (const id of markerIds) {
      const s = this.slotOf.get(id);
      if (s === undefined || (this.counts[s] ?? 0) === 0 || bySlot.has(s)) continue;
      bySlot.set(s, []);
      idOf.set(s, id);
    }
    const out = new Map<string, number[]>();
    if (bySlot.size === 0) return out;
    const owner = this.owner;
    for (let t = 0; t < owner.length; t++) {
      const o = owner[t] ?? 0;
      if (o === 0) continue;
      if (o === SPLIT) {
        const node = this.split.get(t) ?? 0;
        for (const [s, list] of bySlot) if (nodeHas(node, s)) list.push(t);
      } else bySlot.get(o)?.push(t);
    }
    for (const [s, list] of bySlot) out.set(idOf.get(s) ?? '', list);
    return out;
  }

  /** Number of triangles cut into pieces. */
  get splitCount(): number {
    return this.split.size;
  }

  /** Painted area of `markerId` (model units², needs the geometry; pieces count their share). */
  paintedArea(markerId: string): number {
    const slot = this.slotOf.get(markerId);
    const g = this.geometry;
    if (slot === undefined || !g) return 0;
    let area = 0;
    const owner = this.owner;
    for (let t = 0; t < owner.length; t++) {
      const o = owner[t];
      if (o === slot) area += triangleArea(g, t);
      else if (o === SPLIT) area += triangleArea(g, t) * nodeShare(this.split.get(t) ?? 0, slot);
    }
    return area;
  }

  /** Drop the paint of every marker not in `ids` (a deleted marker loses its paint). */
  retainMarkers(ids: Iterable<string>): void {
    const keep = new Set(ids);
    const drop = new Set<number>();
    for (const [id, slot] of this.slotOf) if (!keep.has(id)) drop.add(slot);
    if (drop.size === 0) return;
    let changed = false;
    const owner = this.owner;
    for (let t = 0; t < owner.length; t++) {
      const o = owner[t] ?? 0;
      if (o === SPLIT) {
        const node = this.split.get(t) ?? 0;
        const next = mapNode(node, (s) => (drop.has(s) ? 0 : s));
        if (!nodeEquals(next, node)) {
          this.setNode(t, next);
          changed = true;
        }
      } else if (drop.has(o)) {
        this.setNode(t, 0);
        changed = true;
      }
    }
    for (const slot of drop) {
      const id = this.slotIds[slot];
      if (id !== undefined) this.slotOf.delete(id);
      this.slotIds[slot] = undefined;
      this.counts[slot] = 0;
    }
    if (changed) this.version++;
  }

  /**
   * Whole-painted triangles grouped by marker, in marker order of `markerIds` (others skipped),
   * and only where `include(t)` is true (e.g. visible bodies). One pass over all triangles. Cut
   * triangles are in `pieces`.
   */
  groups(
    markerIds: readonly string[],
    include: (t: number) => boolean = () => true,
  ): { markerId: string; triangles: Uint32Array }[] {
    const want = markerIds
      .map((id) => ({ id, slot: this.slotOf.get(id) }))
      .filter((m): m is { id: string; slot: number } => m.slot !== undefined);
    if (want.length === 0) return [];
    const order = new Int32Array(this.slotIds.length).fill(-1);
    want.forEach((m, i) => (order[m.slot] = i));
    const sizes = new Uint32Array(want.length);
    const owner = this.owner;
    for (let t = 0; t < owner.length; t++) {
      const i = order[owner[t] ?? 0] ?? -1;
      if (i >= 0 && include(t)) sizes[i] = (sizes[i] ?? 0) + 1;
    }
    const out = want.map((m, i) => ({ markerId: m.id, triangles: new Uint32Array(sizes[i] ?? 0) }));
    const fill = new Uint32Array(want.length);
    for (let t = 0; t < owner.length; t++) {
      const i = order[owner[t] ?? 0] ?? -1;
      if (i < 0 || !include(t)) continue;
      const g = out[i];
      if (!g) continue;
      g.triangles[fill[i] ?? 0] = t;
      fill[i] = (fill[i] ?? 0) + 1;
    }
    return out.filter((g) => g.triangles.length > 0);
  }

  /**
   * Cut triangles with their pieces (slots, see `slotOfMarker`; walk them with `forEachPiece`).
   * Pieces are immutable: a triangle whose paint changes gets a new object, so renderers can
   * cache per triangle by identity.
   */
  splitEntries(): IterableIterator<[number, PaintNode]> {
    return this.split.entries();
  }

  /** Slot of `markerId` in `PaintNode`s, or undefined when it has never painted. */
  slotOfMarker(markerId: string): number | undefined {
    return this.slotOf.get(markerId);
  }

  private apply(
    triangles: Iterable<number>,
    slot: number,
    locked: ReadonlySet<string>,
    record: PaintRecord | undefined,
    spheres: readonly PaintSphere[] | undefined,
  ): number {
    const lockedSlots = this.slotsOf(locked);
    const assign = (node: PaintNode): PaintNode => assignAll(node, slot, lockedSlots);
    const g = spheres && spheres.length > 0 ? this.geometry : undefined;
    let changed = 0;
    for (const t of triangles) {
      if (t < 0 || t >= this.triangleCount) continue;
      const old = this.nodeAt(t);
      let next: PaintNode;
      if (g && spheres) {
        next = old;
        const [a, b, c] = corners(g, t);
        for (const s of spheres) next = stamp(next, a, b, c, s, 0, assign);
      } else next = assign(old);
      if (nodeEquals(next, old)) continue;
      record?.note(t, this.toState(old), this.toState(next));
      this.setNode(t, next);
      changed++;
    }
    if (changed > 0) this.version++;
    return changed;
  }

  private nodeAt(t: number): PaintNode {
    const o = this.owner[t] ?? 0;
    return o === SPLIT ? (this.split.get(t) ?? 0) : o;
  }

  /** Set triangle `t`'s paint, keeping `counts` and `split` in step (not `version`). */
  private setNode(t: number, node: PaintNode): void {
    this.blockEdits[Math.floor(t / PAINT_BLOCK)] = ++this.edits;
    const old = this.nodeAt(t);
    if (typeof old === 'number' && typeof node === 'number') {
      // Fast path (whole triangles, e.g. a big Smart fill): no Sets.
      if (old !== 0) this.counts[old] = (this.counts[old] ?? 0) - 1;
      if (node !== 0) this.counts[node] = (this.counts[node] ?? 0) + 1;
      this.owner[t] = node;
      this.split.delete(t);
      return;
    }
    for (const s of slotsIn(old)) this.counts[s] = (this.counts[s] ?? 0) - 1;
    for (const s of slotsIn(node)) this.counts[s] = (this.counts[s] ?? 0) + 1;
    if (typeof node === 'number') {
      this.owner[t] = node;
      this.split.delete(t);
    } else {
      this.owner[t] = SPLIT;
      this.split.set(t, node);
    }
  }

  private toState(node: PaintNode): PaintState {
    if (typeof node === 'number') return this.slotIds[node];
    return [
      this.toState(node[0]),
      this.toState(node[1]),
      this.toState(node[2]),
      this.toState(node[3]),
    ];
  }

  private toNode(state: PaintState): PaintNode {
    if (state === undefined) return 0;
    if (typeof state === 'string') return this.slotFor(state);
    return normalize([
      this.toNode(state[0]),
      this.toNode(state[1]),
      this.toNode(state[2]),
      this.toNode(state[3]),
    ]);
  }

  private slotFor(markerId: string): number {
    let slot = this.slotOf.get(markerId);
    if (slot !== undefined) return slot;
    slot = this.slotIds.indexOf(undefined, 1);
    if (slot < 0) {
      slot = this.slotIds.length;
      if (slot >= SPLIT) throw new Error('too many markers');
      this.slotIds.push(markerId);
      this.counts.push(0);
    } else {
      this.slotIds[slot] = markerId;
      this.counts[slot] = 0;
    }
    this.slotOf.set(markerId, slot);
    return slot;
  }

  private slotsOf(ids: ReadonlySet<string>): Set<number> {
    const out = new Set<number>();
    for (const id of ids) {
      const s = this.slotOf.get(id);
      if (s !== undefined) out.add(s);
    }
    return out;
  }
}

/** Every piece (unlocked) of `node` → `slot`; merges where the 4 pieces end up alike. */
function assignAll(node: PaintNode, slot: number, locked: ReadonlySet<number>): PaintNode {
  if (typeof node === 'number') return locked.has(node) ? node : slot;
  return normalize([
    assignAll(node[0], slot, locked),
    assignAll(node[1], slot, locked),
    assignAll(node[2], slot, locked),
    assignAll(node[3], slot, locked),
  ]);
}

/**
 * One brush stamp on a (piece of a) triangle a b c at cut depth `depth`. Fully inside → all of
 * it; crossed by the ball edge → cut while bigger than the piece size, then a piece takes the
 * paint when its centre is inside (a whole import triangle small enough: painted when touched).
 */
function stamp(
  node: PaintNode,
  a: V3,
  b: V3,
  c: V3,
  s: PaintSphere,
  depth: number,
  assign: (n: PaintNode) => PaintNode,
): PaintNode {
  // Plain paint the stamp can't change (already this marker, nothing to erase, locked): done.
  if (typeof node === 'number' && assign(node) === node) return node;
  const r2 = s.radius * s.radius;
  const o = s.center;
  if (dist2(a, o) <= r2 && dist2(b, o) <= r2 && dist2(c, o) <= r2) return assign(node);
  if (closestDist2(o, a, b, c) > r2) return node;
  const piece = s.radius * PIECE_SIZE;
  const longest = Math.max(dist2(a, b), dist2(b, c), dist2(c, a));
  if (longest <= piece * piece || depth >= MAX_PIECE_DEPTH) {
    if (depth === 0) return assign(node);
    const m: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    return dist2(m, o) <= r2 ? assign(node) : node;
  }
  const kids = typeof node === 'number' ? ([node, node, node, node] as const) : node;
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  const d = depth + 1;
  const k0 = stamp(kids[0], a, ab, ca, s, d, assign);
  const k1 = stamp(kids[1], ab, b, bc, s, d, assign);
  const k2 = stamp(kids[2], ca, bc, c, s, d, assign);
  const k3 = stamp(kids[3], ab, bc, ca, s, d, assign);
  // Unchanged pieces stay the same object (renderers cache cut triangles by identity).
  if (
    typeof node !== 'number' &&
    k0 === node[0] &&
    k1 === node[1] &&
    k2 === node[2] &&
    k3 === node[3]
  )
    return node;
  return normalize([k0, k1, k2, k3]);
}

/** Merge 4 alike plain pieces into one (children are normalised already). */
function normalize(node: readonly [PaintNode, PaintNode, PaintNode, PaintNode]): PaintNode {
  const [p, q, r, s] = node;
  if (typeof p === 'number' && p === q && p === r && p === s) return p;
  return node;
}

function mapNode(node: PaintNode, f: (slot: number) => number): PaintNode {
  if (typeof node === 'number') return f(node);
  return normalize([
    mapNode(node[0], f),
    mapNode(node[1], f),
    mapNode(node[2], f),
    mapNode(node[3], f),
  ]);
}

export function nodeEquals(x: PaintNode, y: PaintNode): boolean {
  if (x === y) return true;
  if (typeof x === 'number' || typeof y === 'number') return false;
  return (
    nodeEquals(x[0], y[0]) &&
    nodeEquals(x[1], y[1]) &&
    nodeEquals(x[2], y[2]) &&
    nodeEquals(x[3], y[3])
  );
}

function nodeHas(node: PaintNode, slot: number): boolean {
  if (typeof node === 'number') return node === slot;
  return node.some((n) => nodeHas(n, slot));
}

/** Painted slots (not 0) in `node`. */
function slotsIn(node: PaintNode): Set<number> {
  const out = new Set<number>();
  const walk = (n: PaintNode): void => {
    if (typeof n === 'number') {
      if (n !== 0) out.add(n);
    } else n.forEach(walk);
  };
  walk(node);
  return out;
}

/** Share of the triangle's area that `slot` covers. */
function nodeShare(node: PaintNode, slot: number): number {
  if (typeof node === 'number') return node === slot ? 1 : 0;
  return (
    (nodeShare(node[0], slot) +
      nodeShare(node[1], slot) +
      nodeShare(node[2], slot) +
      nodeShare(node[3], slot)) /
    4
  );
}

/** Calls `f` per plain piece of `node` with its slot and barycentric corners (see `pieces`). */
export function forEachPiece(
  node: PaintNode,
  f: (slot: number, u0: number, v0: number, u1: number, v1: number, u2: number, v2: number) => void,
): void {
  const walk = (
    n: PaintNode,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    u2: number,
    v2: number,
  ): void => {
    if (typeof n === 'number') {
      f(n, u0, v0, u1, v1, u2, v2);
      return;
    }
    const abu = (u0 + u1) / 2;
    const abv = (v0 + v1) / 2;
    const bcu = (u1 + u2) / 2;
    const bcv = (v1 + v2) / 2;
    const cau = (u2 + u0) / 2;
    const cav = (v2 + v0) / 2;
    walk(n[0], u0, v0, abu, abv, cau, cav);
    walk(n[1], abu, abv, u1, v1, bcu, bcv);
    walk(n[2], cau, cav, bcu, bcv, u2, v2);
    walk(n[3], abu, abv, bcu, bcv, cau, cav);
  };
  walk(node, 0, 0, 1, 0, 0, 1);
}

function corners(g: PaintGeometry, t: number): [V3, V3, V3] {
  const p = g.positions;
  const v = (k: number): V3 => {
    const i = (g.indices[t * 3 + k] ?? 0) * 3;
    return [p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0];
  };
  return [v(0), v(1), v(2)];
}

function triangleArea(g: PaintGeometry, t: number): number {
  const [a, b, c] = corners(g, t);
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

function mid(a: V3, b: V3): V3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function dist2(a: V3, b: V3): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Squared distance from `p` to triangle a b c (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestDist2(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist2(p, a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist2(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist2(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist2(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist2(p, [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return dist2(p, [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const denom = va + vb + vc;
  if (denom === 0) return Math.min(dist2(p, a), dist2(p, b), dist2(p, c)); // degenerate
  const v = vb / denom;
  const w = vc / denom;
  return dist2(p, [
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ]);
}

/**
 * What one undo step changed: per triangle the paint before and after (first "before"
 * and last "after" win when a triangle changes twice). Marker ids, not slots — a deleted
 * marker's slot can be reused before the step is undone. Cut triangles keep their pieces
 * as id-index trees on the side; plain triangles stay ~10 bytes each once sealed.
 */
export class PaintRecord {
  /** Index 0 = unpainted. */
  private readonly ids: (string | undefined)[] = [undefined];
  private readonly idIndex = new Map<string, number>();
  private readonly at = new Map<number, number>();
  private tris: number[] | Uint32Array = [];
  private beforeIds: number[] | Uint16Array = [];
  private afterIds: number[] | Uint16Array = [];
  private readonly beforeTrees = new Map<number, IndexTree>();
  private readonly afterTrees = new Map<number, IndexTree>();

  get size(): number {
    return this.tris.length;
  }

  triangleAt(i: number): number {
    return this.tris[i] ?? 0;
  }

  /** Paint of entry `i` on one side, as marker ids. */
  stateAt(i: number, side: 'before' | 'after'): PaintState {
    const plain = (side === 'before' ? this.beforeIds : this.afterIds)[i] ?? 0;
    if (plain !== TREE) return this.ids[plain];
    const tree = (side === 'before' ? this.beforeTrees : this.afterTrees).get(i) ?? 0;
    return this.fromTree(tree);
  }

  note(t: number, before: PaintState, after: PaintState): void {
    if (!Array.isArray(this.tris)) throw new Error('PaintRecord is sealed');
    let i = this.at.get(t);
    if (i === undefined) {
      i = this.tris.length;
      this.at.set(t, i);
      this.tris.push(t);
      (this.beforeIds as number[]).push(this.put(before, i, this.beforeTrees));
      (this.afterIds as number[]).push(0);
    }
    this.afterTrees.delete(i);
    this.afterIds[i] = this.put(after, i, this.afterTrees);
  }

  /**
   * Ends recording: drops the lookup map and packs into typed arrays (~10 bytes per triangle
   * instead of ~24 + map; 100 steps of big fills on a 1M model stay small).
   */
  seal(): this {
    if (!Array.isArray(this.tris)) return this;
    this.at.clear();
    this.tris = Uint32Array.from(this.tris);
    this.beforeIds = Uint16Array.from(this.beforeIds);
    this.afterIds = Uint16Array.from(this.afterIds);
    return this;
  }

  private put(state: PaintState, i: number, trees: Map<number, IndexTree>): number {
    if (state === undefined || typeof state === 'string') return this.indexOf(state);
    trees.set(i, this.toTree(state));
    return TREE;
  }

  private toTree(state: PaintState): IndexTree {
    if (state === undefined || typeof state === 'string') return this.indexOf(state);
    return [
      this.toTree(state[0]),
      this.toTree(state[1]),
      this.toTree(state[2]),
      this.toTree(state[3]),
    ];
  }

  private fromTree(tree: IndexTree): PaintState {
    if (typeof tree === 'number') return this.ids[tree];
    return [
      this.fromTree(tree[0]),
      this.fromTree(tree[1]),
      this.fromTree(tree[2]),
      this.fromTree(tree[3]),
    ];
  }

  private indexOf(id: string | undefined): number {
    if (id === undefined) return 0;
    let i = this.idIndex.get(id);
    if (i === undefined) {
      i = this.ids.length;
      if (i >= TREE) throw new Error('too many markers in one step');
      this.ids.push(id);
      this.idIndex.set(id, i);
    }
    return i;
  }
}

type IndexTree = number | readonly [IndexTree, IndexTree, IndexTree, IndexTree];
/** Entry value: "pieces, see the tree map". */
const TREE = 0xffff;

/**
 * Paints and erases a small throw-away grid with brush stamps, so the JavaScript engine has
 * optimised the paint code before the first real stroke (cold, its first step took ~10× longer:
 * 16 ms on a fast stroke on 1M triangles). Call in idle time after a load; ~15 ms.
 */
export function warmPaintCode(): void {
  const n = 12;
  const size = 5;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) positions.push(i * size, j * size, 0);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j;
      const b = a + n + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const triangles = Array.from({ length: indices.length / 3 }, (_, t) => t);
  for (let round = 0; round < 3; round++) {
    const layer = new PaintLayer(triangles.length, { positions, indices });
    const spheres = Array.from({ length: 16 }, (_, k) => ({
      center: [5 + k * 3, 30 + 8 * Math.sin(k / 3 + round), 0] as const,
      radius: 3 + round,
    }));
    const record = new PaintRecord();
    layer.paint(triangles, 'a', new Set(), record, spheres);
    layer.paint(triangles, 'b', new Set(['a']), record, spheres.slice(4));
    layer.erase(triangles, new Set(), record, spheres.slice(8));
    record.seal();
    layer.restore(record, 'before');
  }
}
