/**
 * Box select, pure. The user drags a rectangle: left→right **adds** to the
 * selection, right→left **removes** from it. Which entities count:
 * - **window** (no Alt): visible entities lying *fully* inside the rectangle;
 * - **crossing** (Alt, pressed any time during the drag): visible entities with any visible
 *   pixel inside it. "Visible" comes from the GPU ID buffer of the
 * rectangle (picker.ts `renderRegion`), so parts behind other parts or hidden bodies never count.
 * "Fully inside" projects every point of the entity (face triangles, edge polyline, vertex) to the
 * screen — a perspective view maps a triangle to the triangle of its projected corners, so corner
 * tests are exact.
 */
import type { StepModel } from '@third-wheel/geometry';
import type { FaceTriangles } from './highlight-buffers.js';
import { KIND_CODE, type EntityKind } from './pick-resolve.js';
import type { SelectionFilter } from './selection-filter.js';
import type { SelectionItem } from './selection.js';

export type BoxMode = 'window' | 'crossing';

/** Rectangle in canvas CSS px (top-left origin), x0 ≤ x1, y0 ≤ y1. */
export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** What a finished box does to the selection. */
export type BoxAction = 'add' | 'remove';

/** No Alt = window (fully inside), Alt = crossing. */
export function boxMode(altKey: boolean): BoxMode {
  return altKey ? 'crossing' : 'window';
}

/** Left→right (or straight up/down) = add, right→left = remove. */
export function boxAction(startX: number, endX: number): BoxAction {
  return endX >= startX ? 'add' : 'remove';
}

/**
 * Label next to the box while dragging: what releasing does, plus how to switch the mode,
 * e.g. "+ inside · Alt: crossing". Replaces the long status-bar hint.
 */
export function boxLabel(action: BoxAction, mode: BoxMode): string {
  const sign = action === 'add' ? '+' : '−';
  return mode === 'crossing'
    ? `${sign} crossing · release Alt: inside`
    : `${sign} inside · Alt: crossing`;
}

/** Rectangle spanned by two corners, clipped to a `width`×`height` canvas. */
export function boxRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  height: number,
): Rect {
  const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), max);
  return {
    x0: clamp(Math.min(a.x, b.x), width),
    y0: clamp(Math.min(a.y, b.y), height),
    x1: clamp(Math.max(a.x, b.x), width),
    y1: clamp(Math.max(a.y, b.y), height),
  };
}

/** Ids of each kind with at least one pixel in an ID buffer (RGBA bytes, pick-resolve.ts encoding). */
export type VisibleIds = Record<EntityKind, Set<number>>;

export function visibleIds(pixels: Uint8Array, into?: VisibleIds): VisibleIds {
  const out = into ?? { vertex: new Set(), edge: new Set(), face: new Set() };
  for (let o = 0; o + 3 < pixels.length; o += 4) {
    const code = pixels[o + 3] ?? 0;
    if (code === 0) continue;
    const id = (pixels[o] ?? 0) | ((pixels[o + 1] ?? 0) << 8) | ((pixels[o + 2] ?? 0) << 16);
    if (code === KIND_CODE.face) out.face.add(id);
    else if (code === KIND_CODE.edge) out.edge.add(id);
    else if (code === KIND_CODE.vertex) out.vertex.add(id);
  }
  return out;
}

/**
 * Screen projection: column-major 4×4 view-projection matrix (three.js `elements` order) and the
 * canvas size in CSS px.
 */
export interface Projection {
  readonly matrix: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** True when world point (x, y, z) is in front of the camera and projects inside `rect`. */
export function projectsInside(
  p: Projection,
  rect: Rect,
  x: number,
  y: number,
  z: number,
): boolean {
  const m = p.matrix;
  const e = (i: number): number => m[i] ?? 0;
  const w = e(3) * x + e(7) * y + e(11) * z + e(15);
  if (w <= 0) return false;
  const nx = (e(0) * x + e(4) * y + e(8) * z + e(12)) / w;
  const ny = (e(1) * x + e(5) * y + e(9) * z + e(13)) / w;
  const sx = ((nx + 1) / 2) * p.width;
  const sy = ((1 - ny) / 2) * p.height;
  return sx >= rect.x0 && sx <= rect.x1 && sy >= rect.y0 && sy <= rect.y1;
}

export type BoxModel = Pick<
  StepModel,
  | 'positions'
  | 'indices'
  | 'faceBody'
  | 'edgePoints'
  | 'edgeRanges'
  | 'vertexPositions'
  | 'vertexBody'
>;

/**
 * Items a box selects, given what is visible inside it. Every kind that is on in the filter
 * counts (Body: the bodies of visible faces). Order: faces, edges, vertices, bodies, each by id.
 */
export function boxSelectItems(
  visible: VisibleIds,
  model: BoxModel,
  faceTris: FaceTriangles,
  projection: Projection,
  rect: Rect,
  mode: BoxMode,
  filter: SelectionFilter,
): SelectionItem[] {
  const inside = (arr: Float32Array, i: number): boolean =>
    projectsInside(projection, rect, arr[i * 3] ?? 0, arr[i * 3 + 1] ?? 0, arr[i * 3 + 2] ?? 0);

  const faceInside = new Map<number, boolean>();
  const faceFullyInside = (f: number): boolean => {
    let r = faceInside.get(f);
    if (r !== undefined) return r;
    r = true;
    for (let i = faceTris.start[f] ?? 0; r && i < (faceTris.start[f + 1] ?? 0); i++) {
      const t = faceTris.tris[i] ?? 0;
      for (let k = 0; k < 3; k++) {
        if (!inside(model.positions, model.indices[t * 3 + k] ?? 0)) {
          r = false;
          break;
        }
      }
    }
    faceInside.set(f, r);
    return r;
  };
  const edgeFullyInside = (e: number): boolean => {
    const first = model.edgeRanges[e * 2] ?? 0;
    const n = model.edgeRanges[e * 2 + 1] ?? 0;
    for (let i = 0; i < n; i++) if (!inside(model.edgePoints, first + i)) return false;
    return true;
  };
  const sorted = (ids: Iterable<number>): number[] => [...ids].sort((a, b) => a - b);
  const window = mode === 'window';

  const items: SelectionItem[] = [];
  if (filter.face)
    for (const id of sorted(visible.face))
      if (!window || faceFullyInside(id)) items.push({ kind: 'face', id });
  if (filter.edge)
    for (const id of sorted(visible.edge))
      if (!window || edgeFullyInside(id)) items.push({ kind: 'edge', id });
  if (filter.vertex)
    for (const id of sorted(visible.vertex))
      if (!window || inside(model.vertexPositions, id)) items.push({ kind: 'vertex', id });
  if (filter.body) {
    const bodies = new Set<number>();
    for (const f of visible.face) bodies.add(model.faceBody[f] ?? 0);
    if (window) {
      // A body counts when all its faces are inside (hidden ones too: it is the whole body).
      for (let f = 0; f < model.faceBody.length; f++) {
        const b = model.faceBody[f] ?? 0;
        if (bodies.has(b) && !faceFullyInside(f)) bodies.delete(b);
      }
    }
    for (const id of sorted(bodies)) items.push({ kind: 'body', id });
  }
  return items;
}
