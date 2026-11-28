/**
 * The user's own folders in the body list. Pure: no DOM.
 *
 * Starts from the STEP tree (`buildBodyTree`) and puts on top of it: user folders, and bodies /
 * STEP assemblies moved somewhere else (free sorting: any row can go into any folder or to
 * the top level). It only sorts the list; the model file is never changed. Order inside a folder:
 * user folders first (oldest first), then STEP rows in STEP order. Empty folders stay shown, so
 * things can be dragged back in.
 */
import type { BodyTreeData, TreePlace, UserFolderData } from '@third-wheel/core';
import { MAX_NAME_LENGTH } from '@third-wheel/core';
import type { Folder, TreeNode } from './body-tree.js';

/** Container key of a place: "top", "f<assembly>" or "u<id>" (same as the folder's row key). */
export function placeKey(p: TreePlace): string {
  if (p === 'top') return 'top';
  return 'assembly' in p ? `f${String(p.assembly)}` : `u${p.folder}`;
}

/** The place a folder row key stands for ("top" for anything else). */
export function keyPlace(key: string): TreePlace {
  if (key.startsWith('f')) {
    const a = Number(key.slice(1));
    if (Number.isInteger(a) && a >= 0) return { assembly: a };
  }
  if (key.startsWith('u') && key.length > 1) return { folder: key.slice(1) };
  return 'top';
}

/** A snapshot of the user's changes (for undo and the sidecar). */
export interface FolderState {
  readonly folders: readonly UserFolderData[];
  readonly bodies: ReadonlyMap<number, TreePlace>;
  readonly assemblies: ReadonlyMap<number, TreePlace>;
  readonly nextId: number;
}

export type FolderEditKind = 'new-folder' | 'move' | 'rename-folder' | 'delete-folder';

export interface FolderEdit {
  readonly kind: FolderEditKind;
  readonly before: FolderState;
  readonly after: FolderState;
}

/** A folder to offer in "Move to folder ▸", in list order. */
export interface FolderChoice {
  readonly key: string;
  readonly place: TreePlace;
  /** "Fans › Front" — the folder's path. */
  readonly label: string;
}

interface StepFolderInfo {
  readonly name: string;
  readonly parent: string;
  readonly order: number;
}

export class BodyFolders {
  private stepFolders = new Map<number, StepFolderInfo>();
  /** Per body: container key in the STEP tree, and STEP order. */
  private bodyHome: string[] = [];
  private bodyOrder: number[] = [];
  private folders: UserFolderData[] = [];
  private bodies = new Map<number, TreePlace>();
  private assemblies = new Map<number, TreePlace>();
  private nextId = 1;

  /** After every change of the arrangement (edits, undo, load). */
  onChange: (() => void) | undefined;
  /** After a user edit (not after `restore` / `load` / `reset`). */
  onEdit: ((edit: FolderEdit) => void) | undefined;

  /** A new model: its STEP tree, no user changes. */
  reset(stepRoots: readonly TreeNode[]): void {
    this.stepFolders.clear();
    this.bodyHome = [];
    this.bodyOrder = [];
    let order = 0;
    const walk = (nodes: readonly TreeNode[], parent: string): void => {
      for (const n of nodes) {
        if (n.kind === 'body') {
          this.bodyHome[n.body] = parent;
          this.bodyOrder[n.body] = order++;
        } else {
          this.stepFolders.set(n.assembly, { name: n.name, parent, order: order++ });
          walk(n.children, n.key);
        }
      }
    };
    walk(stepRoots, 'top');
    this.folders = [];
    this.bodies.clear();
    this.assemblies.clear();
    this.nextId = 1;
    this.onChange?.();
  }

  /** True when the user changed nothing (no folders, nothing moved). */
  get isEmpty(): boolean {
    return this.folders.length === 0 && this.bodies.size === 0 && this.assemblies.size === 0;
  }

  /** The changes for the sidecar; undefined when there are none. */
  data(): BodyTreeData | undefined {
    if (this.isEmpty) return undefined;
    return {
      folders: this.folders.map((f) => ({ ...f, parent: copyPlace(f.parent) })),
      bodies: [...this.bodies]
        .sort((a, b) => a[0] - b[0])
        .map(([body, parent]) => ({ body, parent: copyPlace(parent) })),
      assemblies: [...this.assemblies]
        .sort((a, b) => a[0] - b[0])
        .map(([assembly, parent]) => ({ assembly, parent: copyPlace(parent) })),
    };
  }

  /**
   * Takes the sidecar's changes (after `reset`). Entries that don't fit this model — duplicate or
   * unknown folders, bodies / assemblies out of range, a folder inside itself — are left out;
   * returns how many.
   */
  load(data: BodyTreeData | undefined): number {
    if (!data) return 0;
    let dropped = 0;
    const ids = new Set<string>();
    for (const f of data.folders) {
      if (ids.has(f.id)) {
        dropped++;
        continue;
      }
      ids.add(f.id);
      this.folders.push({ id: f.id, name: f.name, parent: copyPlace(f.parent) });
    }
    // A folder whose parent is unknown or that sits inside itself goes to the top level.
    for (const f of this.folders) {
      if (!this.exists(f.parent) || this.reaches(f.parent, `u${f.id}`)) {
        f.parent = 'top';
        dropped++;
      }
    }
    for (const a of data.assemblies) {
      const key = `f${String(a.assembly)}`;
      if (
        !this.stepFolders.has(a.assembly) ||
        !this.exists(a.parent) ||
        this.assemblies.has(a.assembly)
      ) {
        dropped++;
        continue;
      }
      this.assemblies.set(a.assembly, copyPlace(a.parent));
      if (this.reaches(a.parent, key)) {
        this.assemblies.delete(a.assembly);
        dropped++;
      }
    }
    for (const b of data.bodies) {
      if (b.body >= this.bodyHome.length || !this.exists(b.parent) || this.bodies.has(b.body)) {
        dropped++;
        continue;
      }
      this.setBodyPlace(b.body, b.parent);
    }
    // New ids continue after the loaded ones ("n1", "n2"…).
    for (const f of this.folders) {
      const m = /^n(\d{1,9})$/.exec(f.id);
      if (m) this.nextId = Math.max(this.nextId, Number(m[1]) + 1);
    }
    this.onChange?.();
    return dropped;
  }

  state(): FolderState {
    return {
      folders: this.folders.map((f) => ({ ...f, parent: copyPlace(f.parent) })),
      bodies: new Map(this.bodies),
      assemblies: new Map(this.assemblies),
      nextId: this.nextId,
    };
  }

  /** Back to a snapshot (undo / redo). */
  restore(state: FolderState): void {
    this.folders = state.folders.map((f) => ({ ...f, parent: copyPlace(f.parent) }));
    this.bodies = new Map(state.bodies);
    this.assemblies = new Map(state.assemblies);
    this.nextId = state.nextId;
    this.onChange?.();
  }

  /** User folder by id. */
  folder(id: string): UserFolderData | undefined {
    return this.folders.find((f) => f.id === id);
  }

  /** "Folder 1", "Folder 2"… — the first name no folder has. */
  nextFolderName(): string {
    const names = new Set(this.folders.map((f) => f.name));
    for (let i = 1; ; i++) if (!names.has(`Folder ${String(i)}`)) return `Folder ${String(i)}`;
  }

  /**
   * New user folder in `parent`, holding the rows `keys` (bodies "b…" and folders "f…" / "u…")
   * — one undo step. Returns its id, or undefined when `parent` doesn't exist.
   */
  newFolder(parent: TreePlace, keys: readonly string[] = [], name?: string): string | undefined {
    if (!this.exists(parent)) return undefined;
    const before = this.state();
    const id = `n${String(this.nextId++)}`;
    this.folders.push({
      id,
      name: cleanName(name ?? '') || this.nextFolderName(),
      parent: copyPlace(parent),
    });
    this.moveRows(keys, { folder: id });
    this.edited('new-folder', before);
    return id;
  }

  /**
   * Moves rows into `target`. Rows that can't go there (a folder into itself or a folder inside
   * it, unknown rows) are skipped. Returns how many rows moved.
   */
  move(keys: readonly string[], target: TreePlace): number {
    if (!this.exists(target)) return 0;
    const before = this.state();
    const moved = this.moveRows(keys, target);
    if (moved > 0) this.edited('move', before);
    return moved;
  }

  /** Whether row `key` may go into `target` (not itself, not a folder inside itself). */
  canMove(key: string, target: TreePlace): boolean {
    if (!this.exists(target)) return false;
    if (key.startsWith('b')) return Number(key.slice(1)) < this.bodyHome.length;
    if (!this.exists(keyPlace(key)) || key === 'top') return false;
    return !this.reaches(target, key);
  }

  /** Renames a user folder; false when the name is empty or unchanged. */
  rename(id: string, name: string): boolean {
    const f = this.folders.find((x) => x.id === id);
    const clean = cleanName(name);
    if (!f || !clean || clean === f.name) return false;
    const before = this.state();
    f.name = clean;
    this.edited('rename-folder', before);
    return true;
  }

  /** Deletes a user folder; what it held moves to the folder's own parent. */
  deleteFolder(id: string): boolean {
    const f = this.folders.find((x) => x.id === id);
    if (!f) return false;
    const before = this.state();
    const into = f.parent;
    const inside = (p: TreePlace): boolean => p !== 'top' && 'folder' in p && p.folder === id;
    for (const g of this.folders) if (inside(g.parent)) g.parent = copyPlace(into);
    for (const [a, p] of [...this.assemblies]) if (inside(p)) this.setAssemblyPlace(a, into);
    for (const [b, p] of [...this.bodies]) if (inside(p)) this.setBodyPlace(b, into);
    this.folders = this.folders.filter((x) => x !== f);
    this.edited('delete-folder', before);
    return true;
  }

  /** The arranged tree for the list. */
  tree(): TreeNode[] {
    /** Container key → rows in it, with a sort key (user folders first, then STEP order). */
    const children = new Map<string, { sort: number; key: string }[]>();
    const put = (parent: string, key: string, sort: number): void => {
      let list = children.get(parent);
      if (!list) children.set(parent, (list = []));
      list.push({ sort, key });
    };
    this.folders.forEach((f, i) => {
      put(this.exists(f.parent) ? placeKey(f.parent) : 'top', `u${f.id}`, i - this.folders.length);
    });
    for (const [a, info] of this.stepFolders) {
      const moved = this.assemblies.get(a);
      put(moved && this.exists(moved) ? placeKey(moved) : info.parent, `f${String(a)}`, info.order);
    }
    for (let b = 0; b < this.bodyHome.length; b++) {
      const home = this.bodyHome[b];
      if (home === undefined) continue;
      const moved = this.bodies.get(b);
      put(
        moved && this.exists(moved) ? placeKey(moved) : home,
        `b${String(b)}`,
        this.bodyOrder[b] ?? 0,
      );
    }
    for (const list of children.values()) list.sort((x, y) => x.sort - y.sort);

    const seen = new Set<string>();
    const build = (key: string): TreeNode | undefined => {
      if (seen.has(key)) return undefined; // guard: a cycle the edits should never make
      seen.add(key);
      if (key.startsWith('b')) return { kind: 'body', body: Number(key.slice(1)) };
      const kids = (children.get(key) ?? []).flatMap((c) => build(c.key) ?? []);
      const bodies = kids
        .flatMap((n) => (n.kind === 'body' ? [n.body] : n.bodies))
        .sort((x, y) => x - y);
      const place = keyPlace(key);
      if (place !== 'top' && 'assembly' in place) {
        const info = this.stepFolders.get(place.assembly);
        const node: Folder = {
          kind: 'folder',
          key,
          assembly: place.assembly,
          name: info?.name ?? '',
          children: kids,
          bodies,
        };
        return node;
      }
      const id = key.slice(1);
      const node: Folder = {
        kind: 'folder',
        key,
        assembly: -1,
        userId: id,
        name: this.folder(id)?.name ?? '',
        children: kids,
        bodies,
      };
      return node;
    };
    const roots = (children.get('top') ?? []).flatMap((c) => build(c.key) ?? []);
    // Rows caught in a cycle (never reached from the top) still show, at the top level.
    for (const list of children.values())
      for (const c of list) {
        const node = seen.has(c.key) ? undefined : build(c.key);
        if (node) roots.push(node);
      }
    return roots;
  }

  /** Every folder in list order, with its path, for "Move to folder ▸". */
  choices(roots: readonly TreeNode[] = this.tree()): FolderChoice[] {
    const out: FolderChoice[] = [];
    const walk = (nodes: readonly TreeNode[], path: string): void => {
      for (const n of nodes) {
        if (n.kind !== 'folder') continue;
        const label = path ? `${path} › ${n.name}` : n.name;
        out.push({ key: n.key, place: keyPlace(n.key), label });
        walk(n.children, label);
      }
    };
    walk(roots, '');
    return out;
  }

  /** Container key a row sits in now. */
  parentOf(key: string): string {
    if (key.startsWith('b')) {
      const b = Number(key.slice(1));
      const moved = this.bodies.get(b);
      return moved && this.exists(moved) ? placeKey(moved) : (this.bodyHome[b] ?? 'top');
    }
    const place = keyPlace(key);
    if (place === 'top') return 'top';
    if ('assembly' in place) {
      const moved = this.assemblies.get(place.assembly);
      if (moved && this.exists(moved)) return placeKey(moved);
      return this.stepFolders.get(place.assembly)?.parent ?? 'top';
    }
    const f = this.folder(place.folder);
    return f && this.exists(f.parent) ? placeKey(f.parent) : 'top';
  }

  private moveRows(keys: readonly string[], target: TreePlace): number {
    let moved = 0;
    const to = placeKey(target);
    for (const key of new Set(keys)) {
      if (!this.canMove(key, target) || this.parentOf(key) === to) continue;
      const place = keyPlace(key);
      if (key.startsWith('b')) this.setBodyPlace(Number(key.slice(1)), target);
      else if (place !== 'top' && 'assembly' in place)
        this.setAssemblyPlace(place.assembly, target);
      else if (place !== 'top') {
        const f = this.folder(place.folder);
        if (!f) continue;
        f.parent = copyPlace(target);
      }
      moved++;
    }
    return moved;
  }

  /** Back home = no entry (keeps the sidecar small and follows the STEP if it is re-read). */
  private setBodyPlace(b: number, p: TreePlace): void {
    if (placeKey(p) === this.bodyHome[b]) this.bodies.delete(b);
    else this.bodies.set(b, copyPlace(p));
  }

  private setAssemblyPlace(a: number, p: TreePlace): void {
    if (placeKey(p) === this.stepFolders.get(a)?.parent) this.assemblies.delete(a);
    else this.assemblies.set(a, copyPlace(p));
  }

  private exists(p: TreePlace): boolean {
    if (p === 'top') return true;
    if ('assembly' in p) return this.stepFolders.has(p.assembly);
    return this.folders.some((f) => f.id === p.folder);
  }

  /** True when walking up from place `from` meets folder row `key` (or `from` is it). */
  private reaches(from: TreePlace, key: string): boolean {
    let at = placeKey(from);
    for (
      let steps = 0;
      at !== 'top' && steps <= this.folders.length + this.stepFolders.size + 1;
      steps++
    ) {
      if (at === key) return true;
      at = this.parentOf(at);
    }
    return at === key;
  }

  private edited(kind: FolderEditKind, before: FolderState): void {
    this.onChange?.();
    this.onEdit?.({ kind, before, after: this.state() });
  }
}

function copyPlace(p: TreePlace): TreePlace {
  if (p === 'top') return 'top';
  return 'assembly' in p ? { assembly: p.assembly } : { folder: p.folder };
}

function cleanName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH);
}
