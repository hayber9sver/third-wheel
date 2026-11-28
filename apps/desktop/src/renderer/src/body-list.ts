/**
 * Left-panel body list: the STEP assemblies as collapsible folders, one row per body with a
 * show/hide eye, the name and a zoom button; folders add a chevron that opens/closes them. Clicking
 * a name adds/removes the body or everything in the folder, Shift adds a range (same as
 * clicks in the view); hovering a row reports its bodies (the viewport highlights them). Plus
 * "Show all / Hide all".
 *
 * User folders (SolidWorks / Blender convention): "+ Folder" in the heading, right-click → "Move to new folder" /
 * "Move to folder ▸"; drag rows onto a folder (or onto empty space = top level); double-click or
 * F2 renames a user folder; right-click → "Delete folder" (or Delete) moves its contents out. The
 * arrangement itself lives in `BodyFolders`.
 */
import type { TreePlace } from '@third-wheel/core';
import type { ListClickMode } from '../../shared/shortcuts.js';
import { BodyFolders, keyPlace, placeKey } from './body-folders.js';
import {
  buildBodyTree,
  folderVisibility,
  initiallyOpen,
  rangeBodies,
  rowBodies,
  rowKey,
  visibleRows,
  type AssemblyRef,
  type TreeNode,
  type TreeRow,
} from './body-tree.js';
import type { ContextMenu, MenuEntry } from './context-menu.js';
import { CHEVRON, EYE, EYE_OFF, FOLDER, icon, TARGET } from './icons.js';

/** What the list needs from a loaded model (`StepModel` fits). */
export interface BodyListModel {
  /** Display name per body. */
  readonly bodyNames: readonly string[];
  /** Enclosing assemblies per body, shown as a tooltip. */
  readonly bodyPaths?: readonly string[];
  readonly assemblies?: readonly AssemblyRef[];
  readonly bodyAssembly?: ArrayLike<number>;
  readonly hasLooseBody?: boolean;
}

/** The model's own STEP tree (before user folders). */
export function stepTreeOf(model: BodyListModel): TreeNode[] {
  const bodyCount = model.bodyNames.length;
  return buildBodyTree(
    bodyCount,
    model.assemblies ?? [],
    model.bodyAssembly ?? [],
    model.hasLooseBody ? bodyCount - 1 : -1,
  );
}

export interface BodyListFolders {
  /** The arrangement (user folders, moved rows); the caller resets / loads it per model. */
  readonly arrangement: BodyFolders;
  /** Shared right-click menu. */
  readonly menu: ContextMenu;
}

export class BodyList {
  private visible: boolean[] = [];
  private names: readonly string[] = [];
  private paths: readonly string[] = [];
  private roots: TreeNode[] = [];
  /** Folder row key → every body inside. */
  private folders = new Map<string, readonly number[]>();
  private open = new Set<string>();
  private selected: ReadonlySet<number> = new Set();
  private involved: ReadonlySet<number> = new Set();
  /** Rows as currently shown (for Shift ranges and hover). */
  private rows: TreeRow[] = [];
  /** Row of the last plain click: where a Shift range starts. */
  private anchor: string | undefined;
  private hoveredRow: string | undefined;
  /** User folder being renamed (its row shows an input). */
  private renaming: string | undefined;
  /** Rows being dragged. */
  private dragKeys: string[] = [];
  private readonly list = document.createElement('ul');
  private readonly allToggle = document.createElement('button');
  private readonly folderButton = document.createElement('button');
  private readonly empty: HTMLElement;
  private readonly arrangement: BodyFolders;
  private readonly menu: ContextMenu | undefined;

  constructor(
    section: HTMLElement,
    private readonly onChange: (visible: readonly boolean[]) => void,
    private readonly onZoom: (bodies: readonly number[]) => void = () => undefined,
    /** A name was clicked: add/remove these bodies (`toggle`) or add a Shift range (`range`). */
    private readonly onSelect: (bodies: readonly number[], mode: ListClickMode) => void = () =>
      undefined,
    /** Turns a click's modifier keys into toggle / range. */
    private readonly clickMode: (e: MouseEvent) => ListClickMode = () => 'toggle',
    /** The pointer moved onto a row (its bodies) or off the list (empty). */
    private readonly onHover: (bodies: readonly number[]) => void = () => undefined,
    folders?: BodyListFolders,
  ) {
    const heading = section.querySelector('h2');
    const empty = section.querySelector<HTMLElement>('.empty');
    if (!heading || !empty) throw new Error('body list section needs an h2 and .empty');
    this.empty = empty;
    this.arrangement = folders?.arrangement ?? new BodyFolders();
    this.menu = folders?.menu;
    this.arrangement.onChange = () => {
      this.rebuild();
    };

    const header = document.createElement('div');
    header.className = 'panel-heading';
    heading.replaceWith(header);
    this.allToggle.type = 'button';
    this.allToggle.className = 'link-btn';
    this.allToggle.hidden = true;
    this.allToggle.addEventListener('click', () => {
      const show = !this.visible.every(Boolean);
      this.visible.fill(show);
      this.update();
    });
    // "+ Folder": always an empty folder at the top level, ready to name.
    this.folderButton.type = 'button';
    this.folderButton.className = 'link-btn';
    this.folderButton.dataset.action = 'add-folder';
    this.folderButton.textContent = '+ Folder';
    this.folderButton.title = 'New folder — drag bodies into it (or right-click a body)';
    this.folderButton.hidden = true;
    this.folderButton.addEventListener('click', () => {
      this.newFolder('top', []);
    });
    const actions = document.createElement('span');
    actions.className = 'panel-heading-actions';
    actions.append(this.folderButton, this.allToggle);
    header.append(heading, actions);

    this.list.className = 'body-list';
    this.list.hidden = true;
    this.list.addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button');
      if (!button) return;
      const { zoom, zoomFolder, body, select, folderEye, folderOpen } = button.dataset;
      if (select !== undefined) {
        this.selectRow(select, this.clickMode(e));
      } else if (zoom !== undefined) {
        this.onZoom([Number(zoom)]);
      } else if (zoomFolder !== undefined) {
        this.onZoom(this.folders.get(zoomFolder) ?? []);
      } else if (body !== undefined) {
        const id = Number(body);
        this.visible[id] = !this.visible[id];
        this.update();
      } else if (folderEye !== undefined) {
        const bodies = this.folders.get(folderEye) ?? [];
        const show = folderVisibility(bodies, this.visible) !== 'shown';
        for (const b of bodies) this.visible[b] = show;
        this.update();
      } else if (folderOpen !== undefined) {
        if (!this.open.delete(folderOpen)) this.open.add(folderOpen);
        this.render();
        this.list
          .querySelector<HTMLButtonElement>(`button[data-folder-open="${folderOpen}"]`)
          ?.focus();
      }
    });
    // Double-click a user folder's name = rename (its two clicks select and unselect: no change).
    this.list.addEventListener('dblclick', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('button[data-select]')?.dataset.select;
      if (key?.startsWith('u')) this.startRename(key.slice(1));
    });
    this.list.addEventListener('keydown', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('button[data-select]')?.dataset.select;
      if (!key?.startsWith('u') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'F2') {
        e.preventDefault();
        e.stopPropagation();
        this.startRename(key.slice(1));
      } else if (e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        this.arrangement.deleteFolder(key.slice(1));
      }
    });
    this.list.addEventListener('pointerover', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('li[data-row]')?.dataset.row;
      if (key === this.hoveredRow) return;
      this.hoveredRow = key;
      const row = this.rows.find((r) => rowKey(r.node) === key);
      this.onHover(row ? rowBodies(row.node) : []);
    });
    this.list.addEventListener('pointerleave', () => {
      this.hoveredRow = undefined;
      this.onHover([]);
    });
    section.append(this.list);

    // The whole panel takes right-clicks and drops: empty space below the rows = top level.
    const panel = section.parentElement ?? section;
    panel.addEventListener('contextmenu', (e) => {
      if (!this.menu || this.list.hidden) return;
      if ((e.target as Element).closest('input')) return;
      e.preventDefault();
      const key = (e.target as Element).closest<HTMLElement>('li[data-row]')?.dataset.row;
      this.menu.open(this.rowMenu(key), { x: e.pageX, y: e.pageY });
    });
    this.list.addEventListener('dragstart', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('li[data-row]')?.dataset.row;
      if (!key || this.renaming !== undefined) return;
      this.dragKeys = this.rowsToMove(key);
      e.dataTransfer?.setData('text/plain', this.dragKeys.join(' '));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    panel.addEventListener('dragover', (e) => {
      const target = this.dropTarget(e.target as Element);
      this.markDrop(target);
      if (target === undefined) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    panel.addEventListener('dragleave', (e) => {
      if (!panel.contains(e.relatedTarget as Node | null)) this.markDrop(undefined);
    });
    panel.addEventListener('drop', (e) => {
      const target = this.dropTarget(e.target as Element);
      this.markDrop(undefined);
      if (target === undefined) return;
      e.preventDefault();
      const keys = this.dragKeys;
      this.dragKeys = [];
      const into = placeKey(target);
      if (this.arrangement.move(keys, target) > 0 && into !== 'top') this.open.add(into);
      this.render();
    });
    this.list.addEventListener('dragend', () => {
      this.dragKeys = [];
      this.markDrop(undefined);
    });
  }

  private selectRow(key: string, mode: ListClickMode): void {
    const row = this.rows.find((r) => rowKey(r.node) === key);
    if (!row) return;
    if (mode === 'range') {
      this.onSelect(rangeBodies(this.rows, this.anchor, key), 'range');
      return;
    }
    this.anchor = key;
    this.onSelect(rowBodies(row.node), mode);
  }

  /** Show a fresh list for a newly loaded model; every body starts visible. Folders: `arrangement`. */
  setModel(model: BodyListModel): void {
    const bodyCount = model.bodyNames.length;
    this.names = model.bodyNames;
    this.paths = model.bodyPaths ?? [];
    this.visible = new Array<boolean>(bodyCount).fill(true);
    this.anchor = undefined;
    this.hoveredRow = undefined;
    this.renaming = undefined;
    this.list.hidden = bodyCount === 0;
    this.empty.hidden = bodyCount > 0;
    this.allToggle.hidden = bodyCount < 2;
    this.folderButton.hidden = bodyCount === 0 || this.menu === undefined;
    this.roots = this.arrangement.tree();
    this.open = initiallyOpen(this.roots);
    this.rebuild();
  }

  clear(): void {
    this.arrangement.reset([]);
    this.setModel({ bodyNames: [] });
  }

  /**
   * Mark rows: `selected` = bodies selected as a whole; `involved` = bodies holding anything
   * selected (a face, edge or vertex of them, or the body itself).
   */
  setSelectedBodies(selected: ReadonlySet<number>, involved: ReadonlySet<number> = selected): void {
    this.selected = selected;
    this.involved = involved;
    this.markSelected();
  }

  /** Scroll the body's row into view if it is shown (its folders open). */
  revealBody(body: number): void {
    const li = this.list.querySelector(`li[data-row="b${String(body)}"]`);
    li?.scrollIntoView({ block: 'nearest' });
  }

  /** The arrangement changed (or a new model): new tree, same open folders. */
  private rebuild(): void {
    this.roots = this.arrangement.tree();
    this.folders.clear();
    const collect = (nodes: readonly TreeNode[]): void => {
      for (const n of nodes)
        if (n.kind === 'folder') {
          this.folders.set(n.key, n.bodies);
          collect(n.children);
        }
    };
    collect(this.roots);
    this.list.classList.toggle('has-folders', this.folders.size > 0);
    this.render();
  }

  /**
   * Rows a drag or "Move to…" takes: a selected body brings every selected body (like a file
   * manager); anything else only itself.
   */
  private rowsToMove(key: string): string[] {
    if (key.startsWith('b') && this.selected.has(Number(key.slice(1)))) {
      return [...this.selected].sort((a, b) => a - b).map((b) => `b${String(b)}`);
    }
    return [key];
  }

  /** Where a drop on `el` would go: a folder row = into it; a body row = its folder; else top. */
  private dropTarget(el: Element): TreePlace | undefined {
    if (this.dragKeys.length === 0) return undefined;
    const key = el.closest<HTMLElement>('li[data-row]')?.dataset.row;
    const into =
      key === undefined ? 'top' : key.startsWith('b') ? this.arrangement.parentOf(key) : key;
    const place = keyPlace(into);
    return this.dragKeys.some(
      (k) => this.arrangement.canMove(k, place) && this.arrangement.parentOf(k) !== into,
    )
      ? place
      : undefined;
  }

  private markDrop(target: TreePlace | undefined): void {
    const key = target === undefined ? undefined : placeKey(target);
    for (const li of this.list.querySelectorAll('li.drop-into')) {
      if ((li as HTMLElement).dataset.row !== key) li.classList.remove('drop-into');
    }
    if (key && key !== 'top')
      this.list.querySelector(`li[data-row="${key}"]`)?.classList.add('drop-into');
    this.list.classList.toggle('drop-top', key === 'top');
  }

  /** Right-click menu for a row (or the empty panel when `key` is undefined). */
  private rowMenu(key: string | undefined): MenuEntry[] {
    const a = this.arrangement;
    if (key === undefined) {
      return [
        {
          label: 'New folder',
          action: 'new-folder',
          onSelect: () => {
            this.newFolder('top', []);
          },
        },
      ];
    }
    // Right-clicking a body that isn't selected selects it first (like the view).
    if (key.startsWith('b')) {
      const b = Number(key.slice(1));
      if (!this.selected.has(b)) this.onSelect([b], 'toggle');
    }
    const rows = this.rowsToMove(key);
    const here = keyPlace(a.parentOf(key));
    const what = rows.length > 1 ? `${String(rows.length)} bodies` : 'this row';
    const targets = (): MenuEntry[] => {
      const can = (p: TreePlace): boolean =>
        rows.some((r) => a.canMove(r, p) && a.parentOf(r) !== placeKey(p));
      return [
        {
          label: 'Top level',
          action: 'move-to:top',
          disabled: !can('top'),
          onSelect: () => {
            this.moveTo(rows, 'top');
          },
        },
        ...a.choices(this.roots).map((c): MenuEntry => ({
          label: c.label,
          action: `move-to:${c.key}`,
          disabled: !can(c.place),
          onSelect: () => {
            this.moveTo(rows, c.place);
          },
        })),
      ];
    };
    const entries: MenuEntry[] = [
      {
        label: 'Move to new folder',
        action: 'move-to-new-folder',
        title: `Put ${what} in a new folder`,
        onSelect: () => {
          this.newFolder(here, rows);
        },
      },
      { label: 'Move to folder', action: 'move-to-folder', submenu: targets() },
    ];
    if (!key.startsWith('b')) {
      entries.push('separator', {
        label: 'New folder inside',
        action: 'new-folder-inside',
        onSelect: () => {
          this.newFolder(keyPlace(key), []);
        },
      });
    }
    if (key.startsWith('u')) {
      const id = key.slice(1);
      entries.push(
        'separator',
        {
          label: 'Rename',
          action: 'rename-folder',
          onSelect: () => {
            this.startRename(id);
          },
        },
        {
          label: 'Delete folder',
          action: 'delete-folder',
          title: 'Delete the folder; what it holds moves out of it',
          onSelect: () => a.deleteFolder(id),
        },
      );
    }
    return entries;
  }

  private moveTo(rows: readonly string[], target: TreePlace): void {
    const into = placeKey(target);
    if (this.arrangement.move(rows, target) > 0 && into !== 'top') {
      this.open.add(into);
      this.render();
    }
  }

  /** New folder in `parent` holding `rows`, opened and in rename mode. */
  private newFolder(parent: TreePlace, rows: readonly string[]): void {
    const parentKey = placeKey(parent);
    if (parentKey !== 'top') this.open.add(parentKey);
    this.renaming = undefined;
    const id = this.arrangement.newFolder(parent, rows);
    if (id === undefined) return;
    this.open.add(`u${id}`);
    this.startRename(id);
  }

  private startRename(id: string): void {
    if (!this.arrangement.folder(id)) return;
    this.renaming = id;
    this.render();
  }

  /**
   * A row is selected when all its bodies are (a folder: everything inside). Otherwise it gets a
   * lighter "has selection" tint when its body holds part of the selection — for a folder only
   * while it is closed (an open folder shows it on the rows inside).
   */
  private markSelected(): void {
    const items = this.list.querySelectorAll<HTMLElement>('[data-select]');
    for (const button of items) {
      const row = this.rows.find((r) => rowKey(r.node) === button.dataset.select);
      const bodies = row ? rowBodies(row.node) : [];
      const on = bodies.length > 0 && bodies.every((b) => this.selected.has(b));
      const closedOrBody = row?.node.kind === 'body' || (row && !this.open.has(row.node.key));
      const partly = !on && !!closedOrBody && bodies.some((b) => this.involved.has(b));
      button.setAttribute('aria-pressed', String(on));
      button.parentElement?.classList.toggle('selected', on);
      button.parentElement?.classList.toggle('has-selection', partly);
    }
  }

  /** Rebuild the rows (after a model load, an arrangement change or opening/closing a folder). */
  private render(): void {
    this.rows = visibleRows(this.roots, this.open);
    const items = this.rows.map(({ node, depth }) => {
      const li = document.createElement('li');
      li.style.setProperty('--depth', String(depth));
      li.dataset.row = rowKey(node);
      li.draggable = this.menu !== undefined && this.renaming === undefined;
      if (node.kind === 'body') li.append(...this.bodyRow(node.body));
      else li.append(...this.folderRow(node));
      return li;
    });
    this.list.replaceChildren(...items);
    this.update();
    const input = this.list.querySelector<HTMLInputElement>('input.folder-name-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  private bodyRow(id: number): HTMLElement[] {
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'eye-btn';
    eye.dataset.body = String(id);
    eye.append(icon());
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'body-row';
    row.dataset.select = `b${String(id)}`;
    const name = document.createElement('span');
    name.className = 'body-name';
    const label = this.names[id] ?? '';
    const path = this.paths[id] ?? '';
    name.textContent = label;
    const where = path ? `${path} › ${label}` : label;
    row.title = `${where}\nClick to add/remove · Shift-click: add range · Drag into a folder`;
    row.append(name);
    return [eye, row, zoomButton(label, 'zoom', id)];
  }

  private folderRow(node: TreeNode & { kind: 'folder' }): HTMLElement[] {
    const { key, name: label } = node;
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'eye-btn';
    eye.dataset.folderEye = key;
    eye.append(icon());
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'folder-chevron';
    toggle.dataset.folderOpen = key;
    toggle.setAttribute('aria-expanded', String(this.open.has(key)));
    toggle.title = this.open.has(key) ? 'Collapse folder' : 'Expand folder';
    toggle.setAttribute('aria-label', toggle.title);
    const chevron = icon(CHEVRON);
    chevron.classList.add('chevron');
    toggle.append(chevron);
    const user = node.userId !== undefined;
    const n = document.createElement('span');
    n.className = 'folder-count';
    n.textContent = String(node.bodies.length);
    if (user && node.userId === this.renaming) {
      return [eye, toggle, this.renameBox(node.userId, label, n)];
    }
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'folder-row';
    select.dataset.select = key;
    select.title = user
      ? `Your folder ${label}: click to add/remove everything in it · double-click or F2 to rename · right-click for more`
      : `Click to add/remove everything in ${label} · Shift-click: add range`;
    const name = document.createElement('span');
    name.className = 'body-name';
    name.textContent = label;
    if (user) select.append(icon(FOLDER));
    select.append(name, n);
    return [eye, toggle, select, zoomButton(label, 'zoomFolder', key)];
  }

  /** The name input of a user folder being renamed: Enter / leaving keeps it, Esc cancels. */
  private renameBox(id: string, label: string, count: HTMLElement): HTMLElement {
    const box = document.createElement('div');
    box.className = 'folder-row renaming';
    box.dataset.select = `u${id}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'folder-name-input';
    input.value = label;
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Folder name');
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      this.renaming = undefined;
      if (!commit || !this.arrangement.rename(id, input.value)) this.render();
      this.list.querySelector<HTMLElement>(`button[data-select="u${id}"]`)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing never reaches the app shortcuts
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      // Focus moves to the folder button: Enter's default action must not "click" it.
      e.preventDefault();
      finish(e.key === 'Enter');
    });
    input.addEventListener('blur', () => {
      finish(true);
    });
    box.append(icon(FOLDER), input, count);
    return box;
  }

  private update(): void {
    for (const eye of this.list.querySelectorAll<HTMLButtonElement>('button[data-body]')) {
      const shown = this.visible[Number(eye.dataset.body)] ?? true;
      eye.setAttribute('aria-pressed', String(shown));
      eye.title = shown ? 'Hide body' : 'Show body';
      eye.setAttribute('aria-label', eye.title);
      eye.querySelector('path')?.setAttribute('d', shown ? EYE : EYE_OFF);
      eye.parentElement?.classList.toggle('body-hidden', !shown);
    }
    this.markSelected();
    for (const eye of this.list.querySelectorAll<HTMLButtonElement>('button[data-folder-eye]')) {
      const state = folderVisibility(
        this.folders.get(eye.dataset.folderEye ?? '') ?? [],
        this.visible,
      );
      eye.setAttribute('aria-pressed', state === 'mixed' ? 'mixed' : String(state === 'shown'));
      eye.title =
        state === 'shown' ? 'Hide everything in this folder' : 'Show everything in this folder';
      eye.setAttribute('aria-label', eye.title);
      eye.querySelector('path')?.setAttribute('d', state === 'hidden' ? EYE_OFF : EYE);
      eye.parentElement?.classList.toggle('folder-hidden', state === 'hidden');
    }
    this.allToggle.textContent = this.visible.every(Boolean) ? 'Hide all' : 'Show all';
    this.onChange(this.visible);
  }
}

function zoomButton(
  label: string,
  key: 'zoom' | 'zoomFolder',
  id: number | string,
): HTMLButtonElement {
  const zoom = document.createElement('button');
  zoom.type = 'button';
  zoom.className = 'zoom-btn';
  zoom.dataset[key] = String(id);
  zoom.title = `Zoom to ${label}`;
  zoom.setAttribute('aria-label', `Zoom to ${label}`);
  zoom.append(icon(TARGET));
  return zoom;
}
