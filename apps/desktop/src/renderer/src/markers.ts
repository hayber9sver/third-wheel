/**
 * Markers: named, coloured paint layers. Pure state — no DOM. There is always exactly one
 * active marker while any exist; a fresh list starts with "Marker 1" so Brush works right away
 * (like slicers where a colour is always active).
 *
 * A marker also holds exact B-rep entities (vertex / edge / face / body ids). They stay exact
 * (never turned into paint); one entity may sit in several markers.
 */
import {
  copyMarkerName,
  isMarkerNameTaken,
  markerNameKey,
  newId,
  type MarkerTransfer,
} from '@third-wheel/core';
import type { SelectionItem } from './selection.js';

/** An entity held by a marker. `seq` grows with every add (across markers): "added last" wins. */
export interface MarkerEntity extends SelectionItem {
  readonly seq: number;
}

/** `face:12` — one key per entity (same as the selection's). */
export const entityKey = (item: SelectionItem): string => `${item.kind}:${String(item.id)}`;

export interface Marker {
  readonly id: string;
  readonly name: string;
  /** `#rrggbb` (lower case). */
  readonly color: string;
  readonly visible: boolean;
  /** Exact entities in the order they were added. */
  readonly entities: readonly MarkerEntity[];
  /**
   * How it came over from the previous version of the model: changed / lost / needs check,
   * until the user says it looks right. Undefined = found where it was (or never moved).
   */
  readonly transfer?: MarkerTransfer;
}

/** Fixed colours for new markers, in order; "Custom…" in the panel allows any other. */
export const MARKER_COLORS: readonly { readonly name: string; readonly hex: string }[] = [
  { name: 'Orange', hex: '#ff8a1f' },
  { name: 'Green', hex: '#2fbf71' },
  { name: 'Purple', hex: '#8b5cf6' },
  { name: 'Yellow', hex: '#f2c230' },
  { name: 'Pink', hex: '#e0409a' },
  { name: 'Teal', hex: '#19b5c8' },
  { name: 'Red', hex: '#e5484d' },
  { name: 'Brown', hex: '#a0703c' },
];

export const DEFAULT_MARKER_COLOR = MARKER_COLORS[0] ?? { name: 'Orange', hex: '#ff8a1f' };

export const MAX_MARKER_NAME = 60;

/** `#rgb` / `#rrggbb` (any case) → `#rrggbb`, else undefined. */
export function normalizeColor(text: string): string | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m?.[1]) return undefined;
  const h = m[1].toLowerCase();
  return h.length === 3 ? `#${h.replace(/./g, (c) => c + c)}` : `#${h}`;
}

/** `#rrggbb` → 0xrrggbb (three.js colour). */
export function colorToHex(color: string): number {
  return Number.parseInt(color.slice(1), 16);
}

/** First palette colour no marker uses yet; when all are used, cycle by count. */
export function nextMarkerColor(markers: readonly Pick<Marker, 'color'>[]): string {
  const used = new Set(markers.map((m) => m.color));
  const free = MARKER_COLORS.find((c) => !used.has(c.hex));
  const pick = free ?? MARKER_COLORS[markers.length % MARKER_COLORS.length];
  return (pick ?? DEFAULT_MARKER_COLOR).hex;
}

/** "Marker N" with N one above the highest "Marker N" in use (never reuses a visible number). */
export function nextMarkerName(markers: readonly Pick<Marker, 'name'>[]): string {
  let max = 0;
  for (const m of markers) {
    const n = /^Marker (\d+)$/.exec(m.name)?.[1];
    if (n) max = Math.max(max, Number(n));
  }
  return `Marker ${String(max + 1)}`;
}

function named(names: readonly string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

/** Trimmed, length-capped name; empty → undefined (rename is then ignored). */
export function cleanMarkerName(text: string): string | undefined {
  const name = text.replace(/\s+/g, ' ').trim().slice(0, MAX_MARKER_NAME);
  return name === '' ? undefined : name;
}

/** List + active marker, for undo. */
export interface MarkersState {
  readonly items: readonly Marker[];
  readonly activeId: string | undefined;
}

/** An undoable change: not setActive / setVisible (view state). */
export interface MarkerEdit {
  readonly kind:
    | 'add'
    | 'remove'
    | 'rename'
    | 'color'
    | 'add-entities'
    | 'remove-entities'
    | 'confirm'
    | 'place';
  readonly id: string;
  readonly before: MarkersState;
  readonly after: MarkersState;
  /** A colour change from dragging in the system picker (many in a row → one undo step). */
  readonly live?: boolean;
}

export class Markers {
  private items: Marker[] = [];
  private activeId: string | undefined;
  /**
   * The project's markers this list doesn't hold (other parts, other versions): names are unique
   * in the project, so theirs are taken too. Ones that come into the list count as its own.
   */
  private others: readonly { readonly id: string; readonly name: string }[] = [];
  /** Entity add counter (`MarkerEntity.seq`); never wound back. */
  private entitySeq = 0;
  /** Called after every change with the new list and active id. */
  onChange: ((markers: readonly Marker[], activeId: string | undefined) => void) | undefined;
  /**
   * Called for each undoable change, after the state changed but before `onChange` (so the
   * paint of a deleted marker can still be read).
   */
  onEdit: ((edit: MarkerEdit) => void) | undefined;
  private quiet = false;

  /**
   * `makeId`: a new marker's id — random (unique in the project, never reused, so a new marker
   * never takes an id another part or an undone marker had). Tests pass a counter.
   */
  constructor(private readonly makeId: () => string = () => newId()) {
    this.reset();
  }

  /**
   * Back to a single "Marker 1" (opening a model; markers belong to its annotations). The
   * project's other markers are forgotten too ({@link setOthers} brings them), unless `keepOthers`
   * (the same model starting empty).
   */
  reset(keepOthers = false): void {
    this.items = [];
    if (!keepOthers) this.others = [];
    this.activeId = undefined;
    this.quiet = true;
    try {
      this.add();
    } finally {
      this.quiet = false;
    }
  }

  /**
   * The project's other markers (from opening a version). A fresh list's untouched default
   * marker whose name one of them uses takes the next free name (not undoable).
   */
  setOthers(others: readonly { readonly id: string; readonly name: string }[]): void {
    this.others = others;
    const only = this.items.length === 1 ? this.items[0] : undefined;
    if (!only || only.entities.length > 0 || !this.takenBy(only.name, only.id)) return;
    this.items = [{ ...only, name: nextMarkerName(named(this.names(only.id))) }];
    this.emit();
  }

  /**
   * The name (as written there) of another marker of the project that `text` would clash with
   * (case and extra spaces ignored), or undefined when `text` is free for marker `id`.
   */
  takenBy(text: string, id?: string): string | undefined {
    const key = markerNameKey(text);
    return this.names(id).find((n) => markerNameKey(n) === key);
  }

  /** Names of the list's markers (but `except`) and of the project's other markers. */
  names(except?: string): string[] {
    const ids = new Set(this.items.map((m) => m.id));
    return [
      ...this.items.filter((m) => m.id !== except).map((m) => m.name),
      ...this.others.filter((m) => !ids.has(m.id) && m.id !== except).map((m) => m.name),
    ];
  }

  state(): MarkersState {
    return { items: this.items, activeId: this.activeId };
  }

  /**
   * Markers read from a sidecar; the first one is active. Not undoable. Entity `seq`s
   * continue above the loaded ones. An empty list starts fresh with "Marker 1".
   */
  load(items: readonly Marker[]): void {
    if (items.length === 0) {
      this.reset(true);
      return;
    }
    this.items = [...items];
    this.activeId = items[0]?.id;
    this.entitySeq = Math.max(0, ...items.flatMap((m) => m.entities.map((e) => e.seq)));
    this.emit();
  }

  /**
   * Puts back a list from `state()` (undo / redo). Visibility stays as it is now for markers that
   * still exist (hiding is not undoable). `takeActive`: also restore which marker was active (add /
   * delete changed it); else the current one stays when it still exists. Ids are never reused
   * (random).
   */
  restore(state: MarkersState, takeActive: boolean): void {
    const now = new Map(this.items.map((m) => [m.id, m]));
    this.items = state.items.map((m) => {
      const cur = now.get(m.id);
      return cur && cur.visible !== m.visible ? { ...m, visible: cur.visible } : m;
    });
    const keep = !takeActive && this.activeId !== undefined && this.get(this.activeId);
    if (!keep) this.activeId = state.activeId;
    this.emit();
  }

  list(): readonly Marker[] {
    return this.items;
  }

  get(id: string): Marker | undefined {
    return this.items.find((m) => m.id === id);
  }

  active(): Marker | undefined {
    return this.activeId === undefined ? undefined : this.get(this.activeId);
  }

  /**
   * Adds a marker with the next name and colour and makes it active; `entities` go in it right
   * away (right-click "Add to marker ▸ New marker": one undo step). `name` replaces the next
   * "Marker N" (e.g. "Comment 2" from "Comment on selection").
   */
  add(entities: readonly SelectionItem[] = [], name?: string): Marker {
    const before = this.state();
    let id = this.makeId();
    while (this.get(id)) id = this.makeId();
    const marker: Marker = {
      id,
      name: this.freeName(name),
      color: nextMarkerColor(this.items),
      visible: true,
      entities: this.stamp(uniqueItems(entities)),
    };
    this.items = [...this.items, marker];
    this.activeId = marker.id;
    this.edited('add', marker.id, before);
    this.emit();
    return marker;
  }

  setActive(id: string): void {
    if (id === this.activeId || !this.get(id)) return;
    this.activeId = id;
    this.emit();
  }

  /**
   * Empty / whitespace names and names another marker of the project uses ({@link takenBy}) are
   * ignored. Returns whether the name changed.
   */
  rename(id: string, text: string): boolean {
    const name = cleanMarkerName(text);
    return name !== undefined && !this.takenBy(name, id) && this.patch(id, { name }, 'rename');
  }

  /** `wanted` (cleaned), or "wanted (2)" … when taken; no name → the next free "Marker N". */
  private freeName(wanted: string | undefined): string {
    const all = this.names();
    const name = wanted === undefined ? undefined : cleanMarkerName(wanted);
    if (name === undefined) return nextMarkerName(named(all));
    return isMarkerNameTaken(name, all)
      ? copyMarkerName(name, new Set(all.map(markerNameKey)))
      : name;
  }

  /** Invalid colours are ignored. `live`: from the system picker while it is dragged. */
  setColor(id: string, text: string, live = false): boolean {
    const color = normalizeColor(text);
    return color !== undefined && this.patch(id, { color }, 'color', live);
  }

  setVisible(id: string, visible: boolean): boolean {
    return this.patch(id, { visible });
  }

  /**
   * Removes a marker. If it was active, the next one (or the previous, at the end) becomes active.
   * The last marker can be deleted too; the list is then empty and nothing is active.
   */
  remove(id: string): boolean {
    const index = this.items.findIndex((m) => m.id === id);
    if (index < 0) return false;
    const before = this.state();
    this.items = this.items.filter((m) => m.id !== id);
    if (this.activeId === id) {
      this.activeId = (this.items[index] ?? this.items[index - 1])?.id;
    }
    this.edited('remove', id, before);
    this.emit();
    return true;
  }

  /** "Looks right" on a marker flagged by the revision transfer: the flag goes. */
  confirmTransfer(id: string): boolean {
    const old = this.get(id);
    if (!old?.transfer) return false;
    const before = this.state();
    this.items = this.items.map((m) => {
      if (m.id !== id) return m;
      return { id: m.id, name: m.name, color: m.color, visible: m.visible, entities: m.entities };
    });
    this.edited('confirm', id, before);
    this.emit();
    return true;
  }

  /**
   * "✓ Place here" on a "? Check" marker: it now holds `items` too (its paint is
   * set by the caller); what still couldn't be placed stays as a ghost, flagged ✕ Lost.
   */
  placeTransfer(
    id: string,
    items: readonly SelectionItem[],
    left: MarkerTransfer['ghost'] | undefined,
  ): boolean {
    const old = this.get(id);
    const was = old?.transfer;
    if (!old || !was) return false;
    const before = this.state();
    const have = new Set(old.entities.map(entityKey));
    const fresh = uniqueItems(items).filter((i) => !have.has(entityKey(i)));
    const entities = [...old.entities, ...this.stamp(fresh)];
    this.items = this.items.map((m) => {
      if (m.id !== id) return m;
      const base = { id: m.id, name: m.name, color: m.color, visible: m.visible, entities };
      return left ? { ...base, transfer: { ...was, status: 'lost' as const, ghost: left } } : base;
    });
    this.edited('place', id, before);
    this.emit();
    return true;
  }

  /** Adds `items` not yet in the marker. Returns how many were added. */
  addEntities(id: string, items: readonly SelectionItem[]): number {
    const marker = this.get(id);
    if (!marker) return 0;
    const have = new Set(marker.entities.map(entityKey));
    const fresh = uniqueItems(items).filter((i) => !have.has(entityKey(i)));
    if (fresh.length === 0) return 0;
    this.replaceEntities(id, [...marker.entities, ...this.stamp(fresh)], 'add-entities');
    return fresh.length;
  }

  /** Removes `items` from the marker (those not in it are ignored). Returns how many were removed. */
  removeEntities(id: string, items: readonly SelectionItem[]): number {
    const marker = this.get(id);
    if (!marker) return 0;
    const drop = new Set(items.map(entityKey));
    const kept = marker.entities.filter((e) => !drop.has(entityKey(e)));
    const removed = marker.entities.length - kept.length;
    if (removed > 0) this.replaceEntities(id, kept, 'remove-entities');
    return removed;
  }

  /** Markers holding at least one of `items`, in list order. */
  holding(items: readonly SelectionItem[]): Marker[] {
    const keys = new Set(items.map(entityKey));
    return this.items.filter((m) => m.entities.some((e) => keys.has(entityKey(e))));
  }

  private stamp(items: readonly SelectionItem[]): MarkerEntity[] {
    return items.map((i) => ({ kind: i.kind, id: i.id, seq: ++this.entitySeq }));
  }

  private replaceEntities(
    id: string,
    entities: readonly MarkerEntity[],
    kind: 'add-entities' | 'remove-entities',
  ): void {
    const before = this.state();
    this.items = this.items.map((m) => (m.id === id ? { ...m, entities } : m));
    this.edited(kind, id, before);
    this.emit();
  }

  private patch(
    id: string,
    change: Partial<Omit<Marker, 'id' | 'entities'>>,
    kind?: 'rename' | 'color',
    live = false,
  ): boolean {
    const index = this.items.findIndex((m) => m.id === id);
    const old = this.items[index];
    if (!old) return false;
    const next = { ...old, ...change };
    if (next.name === old.name && next.color === old.color && next.visible === old.visible) {
      return false;
    }
    const before = this.state();
    this.items = this.items.map((m, i) => (i === index ? next : m));
    if (kind) this.edited(kind, id, before, live);
    this.emit();
    return true;
  }

  private edited(kind: MarkerEdit['kind'], id: string, before: MarkersState, live = false): void {
    if (!this.quiet) this.onEdit?.({ kind, id, before, after: this.state(), live });
  }

  private emit(): void {
    this.onChange?.(this.items, this.activeId);
  }
}

/** Ids `m1`, `m2`, … for tests (the app uses random ids). */
export function counterIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(++n)}`;
}

function uniqueItems(items: readonly SelectionItem[]): SelectionItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = entityKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** An entity to draw for the markers, in the colour of the marker that shows it. */
export interface ShownEntity extends SelectionItem {
  readonly markerId: string;
  readonly color: string;
  /** Resolved marker shown by "Show resolved": drawn faded unless its comment is highlighted. */
  readonly fade?: boolean;
}

/**
 * Which marker colours each entity: only visible markers count; the active marker
 * if it holds the entity, else the visible marker it was added to last. Each entity appears once.
 */
export function shownEntities(markers: readonly Marker[], activeId?: string): ShownEntity[] {
  const best = new Map<string, { entity: MarkerEntity; marker: Marker; rank: number }>();
  for (const marker of markers) {
    if (!marker.visible) continue;
    for (const entity of marker.entities) {
      const rank = marker.id === activeId ? Infinity : entity.seq;
      const key = entityKey(entity);
      const old = best.get(key);
      if (!old || rank > old.rank) best.set(key, { entity, marker, rank });
    }
  }
  return [...best.values()].map(({ entity, marker }) => ({
    kind: entity.kind,
    id: entity.id,
    markerId: marker.id,
    color: marker.color,
  }));
}
