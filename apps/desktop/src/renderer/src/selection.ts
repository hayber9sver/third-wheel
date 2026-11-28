/**
 * The current selection, pure. Items are B-rep entities (vertex/edge/face, ids = OCCT
 * traversal index like everywhere else) or whole bodies. Insertion order is kept, so later tasks
 * (comments, MCP) can list them in the order the user picked them.
 */
import type { EntityKind } from './pick-resolve.js';

export type SelectionKind = EntityKind | 'body';

export interface SelectionItem {
  readonly kind: SelectionKind;
  readonly id: number;
}

const keyOf = (item: SelectionItem): string => `${item.kind}:${String(item.id)}`;

export class Selection {
  private readonly items = new Map<string, SelectionItem>();

  /** Called after every change with the new item list. */
  onChange: ((items: readonly SelectionItem[]) => void) | undefined;

  get size(): number {
    return this.items.size;
  }

  list(): SelectionItem[] {
    return [...this.items.values()];
  }

  has(item: SelectionItem): boolean {
    return this.items.has(keyOf(item));
  }

  /**
   * A click on an item in the viewport (multi-select by default): adds it, or removes it
   * when it is already selected. Modifier keys make no difference.
   */
  toggle(item: SelectionItem): void {
    const key = keyOf(item);
    if (!this.items.delete(key)) this.items.set(key, { kind: item.kind, id: item.id });
    this.changed();
  }

  /**
   * Toggle a group (a folder's bodies): if all are selected, remove them all; otherwise add the
   * missing ones. A single item behaves like a toggle click.
   */
  toggleAll(items: readonly SelectionItem[]): void {
    if (items.length === 0) return;
    const allIn = items.every((i) => this.has(i));
    for (const i of items) {
      if (allIn) this.items.delete(keyOf(i));
      else if (!this.has(i)) this.items.set(keyOf(i), { kind: i.kind, id: i.id });
    }
    this.changed();
  }

  /** Add `items` (those already selected stay); e.g. a left→right box or a Shift range. */
  addAll(items: readonly SelectionItem[]): void {
    const missing = items.filter((i) => !this.has(i));
    if (missing.length === 0) return;
    for (const i of missing) this.items.set(keyOf(i), { kind: i.kind, id: i.id });
    this.changed();
  }

  /** Remove `items` (those not selected are ignored); e.g. a right→left box. */
  removeAll(items: readonly SelectionItem[]): void {
    let removed = false;
    for (const i of items) removed = this.items.delete(keyOf(i)) || removed;
    if (removed) this.changed();
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.changed();
  }

  private changed(): void {
    this.onChange?.(this.list());
  }
}

/** Per-kind body of each entity id (the model's faceBody / edgeBody / vertexBody). */
export type EntityBodies = Readonly<Record<EntityKind, ArrayLike<number>>>;

/**
 * Bodies that hold something selected: a selected body itself, or the body of a selected
 * vertex / edge / face (for marking rows in the body list).
 */
export function selectionBodies(
  items: readonly SelectionItem[],
  bodyOf: EntityBodies,
): Set<number> {
  const bodies = new Set<number>();
  for (const item of items) {
    const body = item.kind === 'body' ? item.id : bodyOf[item.kind][item.id];
    if (body !== undefined) bodies.add(body);
  }
  return bodies;
}

/** Status-bar text, e.g. "2 faces, 1 edge selected"; empty when nothing is selected. */
export function selectionSummary(items: readonly SelectionItem[]): string {
  if (items.length === 0) return '';
  const order: SelectionKind[] = ['body', 'face', 'edge', 'vertex'];
  const parts: string[] = [];
  for (const kind of order) {
    const n = items.filter((i) => i.kind === kind).length;
    if (n === 0) continue;
    const word = kind === 'body' ? (n === 1 ? 'body' : 'bodies') : n === 1 ? kind : `${kind}s`;
    parts.push(`${String(n)} ${word}`);
  }
  return `${parts.join(', ')} selected`;
}
