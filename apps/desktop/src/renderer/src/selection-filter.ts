/**
 * Selection filter, pure: which entity kinds hover/click may pick, like the selection
 * filter in a CAD tool. Applies to new picks only; the current selection is left alone.
 */
import type { EntityRef } from './pick-resolve.js';
import type { SelectionItem, SelectionKind } from './selection.js';

export type SelectionFilter = Readonly<Record<SelectionKind, boolean>>;

/** Toolbar order. */
export const FILTER_KINDS: readonly SelectionKind[] = ['vertex', 'edge', 'face', 'body'];

/** Default: single entities; whole bodies by double-click or the Body toggle. */
export const DEFAULT_FILTER: SelectionFilter = {
  vertex: true,
  edge: true,
  face: true,
  body: false,
};

export const FILTER_STORAGE_KEY = 'third-wheel.selection-filter';

/** Flip one kind. Switching off the last kind that is on is refused (returns `filter` unchanged). */
export function toggleFilter(filter: SelectionFilter, kind: SelectionKind): SelectionFilter {
  const next = { ...filter, [kind]: !filter[kind] };
  return FILTER_KINDS.some((k) => next[k]) ? next : filter;
}

/** Storage form: the kinds that are on, comma separated, e.g. "vertex,edge,face". */
export function serializeFilter(filter: SelectionFilter): string {
  return FILTER_KINDS.filter((k) => filter[k]).join(',');
}

/** Inverse of `serializeFilter`; undefined for anything else (unknown kind, duplicates, empty). */
export function parseFilter(text: unknown): SelectionFilter | undefined {
  if (typeof text !== 'string' || text === '') return undefined;
  const parts = text.split(',');
  if (new Set(parts).size !== parts.length) return undefined;
  if (!parts.every((p) => (FILTER_KINDS as readonly string[]).includes(p))) return undefined;
  return { vertex: false, edge: false, face: false, body: false, ...ofKinds(parts) };
}

function ofKinds(parts: readonly string[]): Partial<Record<SelectionKind, boolean>> {
  return Object.fromEntries(parts.map((p) => [p, true]));
}

/**
 * Which kinds the GPU pick pass draws as candidates. Faces are always drawn (they hide what is
 * behind them); vertices/edges only when allowed, so a filtered-out edge never covers the face
 * under it.
 */
export function pickPassKinds(filter: SelectionFilter): { vertex: boolean; edge: boolean } {
  return { vertex: filter.vertex, edge: filter.edge };
}

/**
 * Turn a raw pick (from a pass drawn with `pickPassKinds`) into what the filter allows.
 * A face counts as itself when faces are on, else as its body when bodies are on, else nothing.
 * Vertices/edges are only in the pass when allowed, so they pass through.
 */
export function applyFilter(
  ref: EntityRef | undefined,
  body: number,
  filter: SelectionFilter,
): SelectionItem | undefined {
  if (!ref) return undefined;
  if (!filter[ref.kind]) {
    if (ref.kind === 'face' && filter.body) return { kind: 'body', id: body };
    return undefined;
  }
  return ref;
}
