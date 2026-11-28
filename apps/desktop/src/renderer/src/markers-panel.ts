/**
 * Markers section in the right panel, layer-list style: one row per marker with
 * [eye] [colour swatch] [name] [×]. Clicking a row makes it the active marker (what Brush paints
 * with); double-click or F2 renames; the swatch opens 8 fixed colours + "Custom…"; "+ Add" in the
 * heading adds the next marker. Delete doesn't ask: it can be undone.
 *
 * Markers also hold exact entities. The active row has "+ Selection" (adds the current
 * selection); a row holding entities shows "N items ▸", which opens the list under the row
 * (closed by default): hover highlights an entity in the view, click selects it, × removes it.
 */
import { CROSS, EYE, EYE_OFF, icon } from './icons.js';
import {
  DEFAULT_MARKER_COLOR,
  entityKey,
  MARKER_COLORS,
  type Marker,
  type MarkerEntity,
  type Markers,
} from './markers.js';
import type { SelectionItem } from './selection.js';

/** What the panel needs from the rest of the app for marker entities. */
export interface MarkerEntityHooks {
  /** Adds the current selection to the marker. */
  addSelection(markerId: string): void;
  /** Row text for an entity, e.g. "Face 12 (cylinder Ø6 hole) · Bracket". */
  label(item: SelectionItem): string;
  /** Pointer over an entity row (undefined = left it). */
  hover(item: SelectionItem | undefined): void;
  /** Entity row clicked: select it in the view. */
  select(item: SelectionItem): void;
  /** "✓ Place here" on a "? Check" marker: paint / hold its ghost where it is drawn. */
  placeTransfer?(markerId: string): void;
  /** Pointer over a marker's rows (undefined = left the list): its ghost is drawn bold. */
  hoverMarker?(markerId: string | undefined): void;
  /** Resolved markers (every comment on them closed): dimmed row, "✓ Resolved", can't be added to. */
  resolved?(): ReadonlySet<string>;
  /**
   * Markers that hold nothing on the shown version but a comment uses (comments are shared by all
   * versions): faded row, so they don't look like markers painted here.
   */
  bare?(): ReadonlySet<string>;
  /** A short message in the status area (a rename left with a taken name). */
  notice?(text: string): void;
}

/** A rename refused: another marker of the project has the name (case ignored). */
export function takenNameText(name: string): string {
  return `There's already a marker called "${name}" — pick another name.`;
}

const NO_HOOKS: MarkerEntityHooks = {
  addSelection: () => undefined,
  label: (i) => `${i.kind} ${String(i.id)}`,
  hover: () => undefined,
  select: () => undefined,
};

/** "1 item", "3 items". */
export function itemCount(n: number): string {
  return `${String(n)} ${n === 1 ? 'item' : 'items'}`;
}

const TRANSFER_TEXT = {
  changed: {
    label: '⚠ Changed',
    ok: '✓ Looks right',
    tip: (from: string) =>
      `Moved or resized in this version (was on ${from}). Check where it landed, then click: looks right.`,
  },
  lost: {
    label: '✕ Lost',
    ok: '✕ Dismiss',
    tip: (from: string) =>
      `Not found in this version (was on ${from}); the dots show where it was. Its comments are kept: paint it again or add the right items, then click to dismiss the old place.`,
  },
  check: {
    label: '? Check',
    ok: '✓ Place here',
    tip: (from: string) =>
      `Its part looks mirrored in this version (was on ${from}), so it was not placed; the dots show where it would go. Click to place it there, or ✕ Drop to remove it.`,
  },
} as const;

/** "? Check" only: removes the marker's unplaced part (its ghost) instead of placing it. */
function dropButton(m: Marker): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'marker-row-btn transfer-drop';
  b.dataset.action = 'transfer-drop';
  b.textContent = '✕ Drop';
  b.title = 'Remove the mirrored part instead of placing it (undo brings it back)';
  b.setAttribute('aria-label', `${m.name}: drop the unplaced part`);
  return b;
}

/**
 * Status of a marker moved from the previous version; click = looks right (⚠ Changed),
 * dismiss (✕ Lost) or place here (? Check).
 */
function transferBadge(m: Marker): HTMLButtonElement {
  const t = m.transfer;
  const b = document.createElement('button');
  b.type = 'button';
  if (!t) return b;
  const text = TRANSFER_TEXT[t.status];
  b.className = `marker-row-btn marker-transfer ${t.status}`;
  b.dataset.action = 'transfer';
  b.title = text.tip(t.from);
  b.setAttribute('aria-label', `${m.name}: ${text.label.slice(2)}. ${b.title}`);
  const status = document.createElement('span');
  status.className = 'transfer-status';
  status.textContent = text.label;
  const ok = document.createElement('span');
  ok.className = 'transfer-ok';
  ok.textContent = text.ok;
  b.append(status, ok);
  return b;
}

/** "✓ Resolved" on a marker whose comments are all closed. */
function resolvedTag(): HTMLSpanElement {
  const tag = document.createElement('span');
  tag.className = 'marker-resolved-tag';
  tag.textContent = '✓ Resolved';
  tag.title =
    'All comments on this marker are closed: hidden in the view. Tick “Show resolved” under Comments to see it faded; reopen a comment to use it again.';
  return tag;
}

export class MarkersPanel {
  /** Resolved markers at the last render. */
  private resolved: ReadonlySet<string> = new Set();
  private bare: ReadonlySet<string> = new Set();
  private readonly list = document.createElement('ul');
  private readonly empty: HTMLElement;
  private readonly menu = document.createElement('div');
  private readonly customInput = document.createElement('input');
  /** Marker whose colour menu is open. */
  private menuFor: string | undefined;
  /** Marker being renamed (its row shows an input). */
  private renaming: string | undefined;
  /** Row pressed while renaming: the rename's blur redraws the rows, so its click is lost. */
  private activateAfterRename: string | undefined;
  /** Markers whose entity list is open. */
  private readonly expanded = new Set<string>();
  private selectionSize = 0;
  /** STL / 3MF shown: no entities to add, so no "+ Selection". */
  private meshOnly = false;
  /** Entity row under the pointer (key), so a redraw can end the view hover. */
  private hoveredEntity: string | undefined;
  /** Marker whose rows are under the pointer (its ghosts are emphasised). */
  private hoveredMarker: string | undefined;

  constructor(
    section: HTMLElement,
    private readonly markers: Markers,
    private readonly hooks: MarkerEntityHooks = NO_HOOKS,
  ) {
    const heading = section.querySelector('h2');
    const empty = section.querySelector<HTMLElement>('.empty');
    if (!heading || !empty) throw new Error('markers section needs an h2 and .empty');
    this.empty = empty;
    empty.textContent = 'No markers. Add one to paint.';

    const header = document.createElement('div');
    header.className = 'panel-heading';
    heading.replaceWith(header);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'link-btn';
    add.id = 'marker-add';
    add.textContent = '+ Add';
    add.title = 'Add a marker (a new paint colour)';
    add.addEventListener('click', () => {
      this.markers.add();
    });
    header.append(heading, add);

    this.list.className = 'marker-list';
    this.list.setAttribute('aria-label', 'Markers');
    this.list.addEventListener('pointerover', (e) => {
      const id = (e.target as Element).closest<HTMLElement>('[data-marker]')?.dataset.marker;
      if (id !== this.hoveredMarker) {
        this.hoveredMarker = id;
        this.hooks.hoverMarker?.(id);
      }
    });
    this.list.addEventListener('pointerleave', () => {
      if (this.hoveredMarker === undefined) return;
      this.hoveredMarker = undefined;
      this.hooks.hoverMarker?.(undefined);
    });
    this.list.addEventListener('click', (e) => {
      this.onListClick(e);
    });
    this.list.addEventListener('pointerdown', (e) => {
      const target = e.target as Element;
      const id = target.closest<HTMLElement>('li[data-marker]')?.dataset.marker;
      this.activateAfterRename =
        this.renaming !== undefined && id !== this.renaming && !target.closest('button')
          ? id
          : undefined;
    });
    this.list.addEventListener('dblclick', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('li[data-marker]');
      if (row && !(e.target as Element).closest('button.marker-icon-btn, input')) {
        this.startRename(row.dataset.marker ?? '');
      }
    });
    this.list.addEventListener('keydown', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('li[data-marker]');
      if (!row || e.target instanceof HTMLInputElement) return;
      if (e.key === 'F2') {
        e.preventDefault();
        this.startRename(row.dataset.marker ?? '');
      } else if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
        e.preventDefault();
        this.markers.setActive(row.dataset.marker ?? '');
      } else if (e.key === 'Delete' && e.target === row) {
        // Delete only, not Backspace. Focus moves to the next row so
        // Delete can be pressed again; undoable like the × button.
        e.preventDefault();
        this.deleteFocused(row.dataset.marker ?? '');
      }
    });

    this.menu.className = 'color-menu';
    this.menu.hidden = true;
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', 'Marker colour');
    for (const c of MARKER_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'color-choice';
      b.dataset.color = c.hex;
      b.style.setProperty('--swatch', c.hex);
      b.title = c.name;
      b.setAttribute('aria-label', c.name);
      b.setAttribute('role', 'menuitemradio');
      this.menu.append(b);
    }
    const custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'link-btn color-custom';
    custom.textContent = 'Custom…';
    custom.setAttribute('role', 'menuitem');
    this.customInput.type = 'color';
    this.customInput.className = 'color-input';
    this.customInput.tabIndex = -1;
    this.customInput.setAttribute('aria-hidden', 'true');
    this.menu.append(custom, this.customInput);
    this.menu.addEventListener('click', (e) => {
      const target = (e.target as Element).closest<HTMLButtonElement>('button');
      if (!target || !this.menuFor) return;
      if (target === custom) {
        this.customInput.value = this.markers.get(this.menuFor)?.color ?? DEFAULT_MARKER_COLOR.hex;
        this.customInput.click();
        return;
      }
      if (target.dataset.color) {
        this.markers.setColor(this.menuFor, target.dataset.color);
        this.closeMenu(true);
      }
    });
    // Live preview while the system picker is open; it closes the menu when done.
    this.customInput.addEventListener('input', () => {
      if (this.menuFor) this.markers.setColor(this.menuFor, this.customInput.value, true);
    });
    this.customInput.addEventListener('change', () => {
      if (this.menuFor) this.markers.setColor(this.menuFor, this.customInput.value, true);
      this.closeMenu(true);
    });
    this.menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // don't also clear the selection
        this.closeMenu(true);
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.menuFor === undefined) return;
      const t = e.target as Element;
      if (!this.menu.contains(t) && !t.closest('.marker-swatch')) this.closeMenu(false);
    });

    section.append(this.list, this.menu);
    this.render();
  }

  /** Redraws the rows from the markers' current state (call from `Markers.onChange`). */
  render(): void {
    const items = this.markers.list();
    const active = this.markers.active()?.id;
    this.resolved = this.hooks.resolved?.() ?? new Set();
    this.bare = this.hooks.bare?.() ?? new Set();
    this.empty.hidden = items.length > 0;
    this.list.hidden = items.length === 0;
    if (this.renaming !== undefined && !this.markers.get(this.renaming)) this.renaming = undefined;
    if (this.menuFor !== undefined && !this.markers.get(this.menuFor)) this.closeMenu(false);
    const focused = document.activeElement as HTMLElement | null;
    const focusedId = focused?.closest<HTMLElement>('li[data-marker]')?.dataset.marker;
    const focusedAction = focused?.dataset.action;
    for (const id of this.expanded)
      if (!this.markers.get(id)?.entities.length) this.expanded.delete(id);
    this.list.replaceChildren(
      ...items.flatMap((m) => {
        const row = this.row(m, m.id === active);
        return this.expanded.has(m.id) ? [row, this.entityList(m)] : [row];
      }),
    );
    if (this.hoveredEntity !== undefined) {
      this.hoveredEntity = undefined;
      this.hooks.hover(undefined);
    }
    // Keep keyboard focus on the same row/control across redraws.
    if (focusedId && this.renaming === undefined) {
      const row = this.list.querySelector<HTMLElement>(`li[data-marker="${focusedId}"]`);
      const again = focusedAction
        ? row?.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`)
        : undefined;
      (again ?? row)?.focus();
    }
    this.updateMenuChecks();
  }

  private row(m: Marker, isActive: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.dataset.marker = m.id;
    li.tabIndex = 0;
    li.className = 'marker-row';
    li.classList.toggle('active', isActive);
    const resolved = this.resolved.has(m.id);
    li.classList.toggle('marker-hidden', !m.visible || resolved);
    const bare = !resolved && this.bare.has(m.id);
    li.classList.toggle('marker-bare', bare);
    if (isActive) li.setAttribute('aria-current', 'true');
    li.title = resolved
      ? `${m.name} — all its comments are closed, so it is hidden and can't be painted`
      : bare
        ? `${m.name} — no paint on this version. A comment uses it; it may be painted on another version.`
        : isActive
          ? `${m.name} — Brush paints with this marker`
          : `${m.name} — click to paint with it, double-click to rename`;

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'marker-icon-btn marker-eye';
    eye.dataset.action = 'eye';
    eye.setAttribute('aria-pressed', String(m.visible));
    eye.title = m.visible ? 'Hide this marker’s paint' : 'Show this marker’s paint';
    eye.setAttribute('aria-label', eye.title);
    eye.append(icon(m.visible ? EYE : EYE_OFF));

    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'marker-icon-btn marker-swatch';
    swatch.dataset.action = 'color';
    swatch.style.setProperty('--swatch', m.color);
    swatch.title = 'Change colour';
    swatch.setAttribute('aria-label', `Colour of ${m.name}`);
    swatch.setAttribute('aria-haspopup', 'menu');
    swatch.setAttribute('aria-expanded', String(this.menuFor === m.id));

    let name: HTMLElement;
    if (this.renaming === m.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'marker-name-input';
      input.value = m.name;
      input.maxLength = 60;
      input.setAttribute('aria-label', 'Marker name');
      let done = false;
      let error: HTMLLIElement | undefined;
      const finish = (commit: boolean, viaEnter = false): void => {
        if (done) return;
        // Names are unique in the project (Finder-style): Enter on a taken name keeps the field
        // open with the reason under it; leaving the field keeps the old name and says why.
        const taken = commit ? this.markers.takenBy(input.value, m.id) : undefined;
        if (taken !== undefined && viaEnter) {
          input.setAttribute('aria-invalid', 'true');
          if (!error) {
            error = document.createElement('li');
            error.className = 'marker-name-error';
            error.setAttribute('role', 'alert');
            error.id = `marker-name-error-${m.id}`;
            input.setAttribute('aria-describedby', error.id);
            li.after(error);
          }
          error.textContent = takenNameText(taken);
          input.select();
          return;
        }
        if (taken !== undefined) {
          this.hooks.notice?.(`Name not changed. ${takenNameText(taken)}`);
          commit = false;
        }
        done = true;
        this.renaming = undefined;
        if (!commit || !this.markers.rename(m.id, input.value)) this.render();
        const next = this.activateAfterRename;
        this.activateAfterRename = undefined;
        if (next !== undefined) this.markers.setActive(next);
        const focusId = next ?? m.id;
        this.list.querySelector<HTMLElement>(`li[data-marker="${focusId}"]`)?.focus();
      };
      input.addEventListener('input', () => {
        if (!error) return;
        error.remove();
        error = undefined;
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true, true);
        else if (e.key === 'Escape') {
          e.stopPropagation(); // Esc cancels the rename only
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        finish(true);
      });
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      name = input;
    } else {
      name = document.createElement('span');
      name.className = 'marker-name';
      name.textContent = m.name;
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'marker-icon-btn marker-delete';
    del.dataset.action = 'delete';
    del.title = 'Delete marker';
    del.setAttribute('aria-label', `Delete ${m.name}`);
    del.append(icon(CROSS));

    li.append(eye, swatch, name);
    if (resolved) li.append(resolvedTag());
    if (m.transfer) li.append(transferBadge(m));
    if (m.transfer?.status === 'check') li.append(dropButton(m));
    const n = m.entities.length;
    if (n > 0) {
      const open = this.expanded.has(m.id);
      const count = document.createElement('button');
      count.type = 'button';
      count.className = 'marker-row-btn marker-count';
      count.dataset.action = 'expand';
      count.textContent = `${itemCount(n)} ${open ? '▾' : '▸'}`;
      count.title = open ? 'Hide the list of selected items' : 'Show the selected items it holds';
      count.setAttribute('aria-expanded', String(open));
      li.append(count);
    }
    if (isActive && !this.meshOnly) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'marker-row-btn marker-add-selection';
      add.dataset.action = 'add-selection';
      add.textContent = '+ Selection';
      add.dataset.resolved = String(resolved);
      this.updateAddSelection(add);
      li.append(add);
    }
    li.append(del);
    return li;
  }

  /** Mesh-only mode: rows have no "+ Selection" (a mesh has no entities to hold). */
  setMeshOnly(on: boolean): void {
    if (this.meshOnly === on) return;
    this.meshOnly = on;
    this.render();
  }

  /** Current selection size: "+ Selection" is greyed out while nothing is selected. */
  setSelectionSize(n: number): void {
    this.selectionSize = n;
    const add = this.list.querySelector<HTMLButtonElement>('.marker-add-selection');
    if (add) this.updateAddSelection(add);
  }

  private updateAddSelection(add: HTMLButtonElement): void {
    const resolved = add.dataset.resolved === 'true';
    add.disabled = this.selectionSize === 0 || resolved;
    add.title = resolved
      ? 'All comments on this marker are closed: reopen one to add to it, or pick another marker'
      : this.selectionSize === 0
        ? 'Select vertices, edges, faces or bodies first, then add them to this marker'
        : 'Add the selected items to this marker (or right-click them in the view)';
  }

  private entityList(m: Marker): HTMLLIElement {
    const holder = document.createElement('li');
    holder.className = 'marker-entities-holder';
    holder.setAttribute('role', 'none');
    const ul = document.createElement('ul');
    ul.className = 'marker-entities';
    ul.dataset.markerEntities = m.id;
    ul.setAttribute('aria-label', `Items in ${m.name}`);
    ul.style.setProperty('--swatch', m.color);
    for (const entity of m.entities) ul.append(this.entityRow(m, entity));
    holder.append(ul);
    return holder;
  }

  private entityRow(m: Marker, entity: MarkerEntity): HTMLLIElement {
    const item: SelectionItem = { kind: entity.kind, id: entity.id };
    const key = entityKey(item);
    const li = document.createElement('li');
    li.className = 'marker-entity';
    li.dataset.entity = key;
    li.tabIndex = 0;
    const label = document.createElement('span');
    label.className = 'marker-entity-label';
    label.textContent = this.hooks.label(item);
    li.title = `${label.textContent} — click to select`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'marker-icon-btn marker-entity-remove';
    remove.title = `Remove from ${m.name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.append(icon(CROSS));
    li.append(label, remove);
    li.addEventListener('pointerenter', () => {
      this.hoveredEntity = key;
      this.hooks.hover(item);
    });
    li.addEventListener('pointerleave', () => {
      if (this.hoveredEntity !== key) return;
      this.hoveredEntity = undefined;
      this.hooks.hover(undefined);
    });
    li.addEventListener('click', (e) => {
      if ((e.target as Element).closest('button')) this.markers.removeEntities(m.id, [item]);
      else this.hooks.select(item);
    });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.hooks.select(item);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.markers.removeEntities(m.id, [item]);
      }
    });
    return li;
  }

  private onListClick(e: MouseEvent): void {
    const target = e.target as Element;
    const row = target.closest<HTMLElement>('li[data-marker]');
    const id = row?.dataset.marker;
    if (!id || target.closest('input')) return;
    const action = target.closest<HTMLElement>('button[data-action]')?.dataset.action;
    const marker = this.markers.get(id);
    if (!marker) return;
    if (action === 'eye') {
      this.markers.setVisible(id, !marker.visible);
    } else if (action === 'color') {
      if (this.menuFor === id) this.closeMenu(true);
      else this.openMenu(id);
    } else if (action === 'delete') {
      this.markers.remove(id);
    } else if (action === 'expand') {
      if (!this.expanded.delete(id)) this.expanded.add(id);
      this.render();
    } else if (action === 'add-selection') {
      this.hooks.addSelection(id);
    } else if (action === 'transfer') {
      if (marker.transfer?.status === 'check' && this.hooks.placeTransfer)
        this.hooks.placeTransfer(id);
      else this.markers.confirmTransfer(id);
    } else if (action === 'transfer-drop') {
      this.markers.confirmTransfer(id);
    } else {
      this.markers.setActive(id);
    }
  }

  private deleteFocused(id: string): void {
    const ids = this.markers.list().map((m) => m.id);
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1];
    if (!this.markers.remove(id)) return;
    if (next !== undefined) {
      this.list.querySelector<HTMLElement>(`li[data-marker="${next}"]`)?.focus();
    }
  }

  private startRename(id: string): void {
    if (!this.markers.get(id)) return;
    this.closeMenu(false);
    this.renaming = id;
    this.render();
  }

  private openMenu(id: string): void {
    this.menuFor = id;
    const swatch = this.list.querySelector<HTMLElement>(`li[data-marker="${id}"] .marker-swatch`);
    this.menu.hidden = false;
    if (swatch) {
      const section = this.menu.offsetParent ?? this.menu.parentElement;
      const base = section?.getBoundingClientRect();
      const r = swatch.getBoundingClientRect();
      this.menu.style.left = `${String(r.left - (base?.left ?? 0))}px`;
      this.menu.style.top = `${String(r.bottom - (base?.top ?? 0) + 4)}px`;
      swatch.setAttribute('aria-expanded', 'true');
    }
    this.updateMenuChecks();
    const current = this.menu.querySelector<HTMLElement>('.color-choice[aria-checked="true"]');
    (current ?? this.menu.querySelector<HTMLElement>('button'))?.focus();
  }

  private closeMenu(refocus: boolean): void {
    const id = this.menuFor;
    if (id === undefined) return;
    this.menuFor = undefined;
    this.menu.hidden = true;
    const swatch = this.list.querySelector<HTMLElement>(`li[data-marker="${id}"] .marker-swatch`);
    swatch?.setAttribute('aria-expanded', 'false');
    if (refocus) swatch?.focus();
  }

  private updateMenuChecks(): void {
    const color = this.menuFor ? this.markers.get(this.menuFor)?.color : undefined;
    for (const b of this.menu.querySelectorAll<HTMLElement>('.color-choice')) {
      b.setAttribute('aria-checked', String(b.dataset.color === color));
    }
  }
}
