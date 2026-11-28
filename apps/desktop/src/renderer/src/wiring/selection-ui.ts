/**
 * Selection in the view (click, box, double-click, right-click menu), Add to marker, toolbar
 * icons and the selection filter.
 */
import { edgesInChain } from '@third-wheel/geometry';
import { Selection, selectionBodies, selectionSummary, type SelectionItem } from '../selection.js';
import { commentsOnMarkers } from '../comments.js';
import { ContextMenu, type MenuEntry } from '../context-menu.js';
import type { ToolId } from '../tools.js';
import { POINTER, BRUSH, BUCKET, VERTEX, EDGE, FACE, BODY, icon } from '../icons.js';
import {
  parseFilter,
  FILTER_STORAGE_KEY,
  serializeFilter,
  DEFAULT_FILTER,
  FILTER_KINDS,
  toggleFilter,
} from '../selection-filter.js';
import {
  addSelectionTo,
  applyDimensions,
  bodyList,
  byId,
  commentOnSelection,
  comments,
  commentsPanel,
  loadSetting,
  markers,
  markersPanel,
  paint,
  renderInfo,
  renderStatus,
  resolvedMarkers,
  saveSetting,
  setExactError,
  setSelectionStatus,
  shownModel,
  viewport,
} from '../main.js';

// --- Selection ---------------------------------------------------------
export const selection = new Selection();
selection.onChange = (items) => {
  setExactError(undefined);
  renderInfo();
  applyDimensions();
  viewport.setSelection(items);
  const whole = new Set(items.filter((i) => i.kind === 'body').map((i) => i.id));
  const involved = shownModel
    ? selectionBodies(items, {
        face: shownModel.faceBody,
        edge: shownModel.edgeBody,
        vertex: shownModel.vertexBody,
      })
    : whole;
  bodyList.setSelectedBodies(whole, involved);
  markersPanel.setSelectionSize(items.length);
  commentsPanel.setSelectionSize(items.length);
  applyAddToMarkerButton(items.length);
  setSelectionStatus(selectionSummary(items));
  renderStatus();
};
// Multi-select by default: a click adds the entity or removes it again; modifier keys
// make no difference; a click on empty space does nothing.
viewport.onClick = (hit, triangle) => {
  showCommentsAt(hit, triangle);
  if (!hit) return;
  selection.toggle({ kind: hit.kind, id: hit.id });
  bodyList.revealBody(hit.body);
};
/** Comments whose markers hold the clicked entity / its body or paint the clicked triangle. */
function showCommentsAt(
  hit: { kind: SelectionItem['kind']; id: number; body: number } | undefined,
  triangle: number | undefined,
): void {
  const ids = new Set<string>();
  if (hit) {
    const items: SelectionItem[] = [{ kind: hit.kind, id: hit.id }];
    if (hit.kind !== 'body') items.push({ kind: 'body', id: hit.body });
    for (const m of markers.holding(items)) ids.add(m.id);
  }
  if (triangle !== undefined && paint) for (const id of paint.markersAt(triangle)) ids.add(id);
  commentsPanel.setHere(new Set(commentsOnMarkers(comments.list(), ids).map((c) => c.id)));
}
// Right-click menu: add the selection to a marker or remove it from one. Right-clicking
// an item that isn't selected selects it first, like Fusion; a right-drag still navigates.
export const contextMenu = new ContextMenu();
viewport.onContextMenu = (hit, at) => {
  if (hit && !selection.has(hit)) {
    selection.addAll([{ kind: hit.kind, id: hit.id }]);
    bodyList.revealBody(hit.body);
  }
  contextMenu.open(markerMenu(selection.list()), at);
};
function markerMenu(items: readonly SelectionItem[]): MenuEntry[] {
  const none = items.length === 0;
  const holders = markers.holding(items);
  const entries: MenuEntry[] = [];
  if (none) entries.push({ label: 'Select something first', disabled: true }, 'separator');
  entries.push(
    {
      label: 'Comment on selection',
      action: 'comment-on-selection',
      disabled: none,
      onSelect: commentOnSelection,
    },
    'separator',
    { label: 'Add to marker', action: 'add-to-marker', disabled: none, submenu: addToEntries() },
    {
      label: 'Remove from marker',
      action: 'remove-from-marker',
      disabled: holders.length === 0,
      ...(holders.length === 0 && !none ? { title: 'No marker holds the selected items' } : {}),
      submenu: holders.map((m) => ({
        label: m.name,
        swatch: m.color,
        action: `remove-from:${m.id}`,
        onSelect: () => {
          markers.removeEntities(m.id, selection.list());
        },
      })),
    },
  );
  return entries;
}
/** "[markers] / New marker" — right-click "Add to marker ▸" and the toolbar button. */
function addToEntries(): MenuEntry[] {
  const list = markers.list();
  const resolved = resolvedMarkers();
  return [
    ...list.map((m) => ({
      label: m.name,
      swatch: m.color,
      action: `add-to:${m.id}`,
      // Resolved = its comments are closed: greyed out until one is reopened.
      ...(resolved.has(m.id)
        ? { disabled: true, title: 'All comments on this marker are closed — reopen one first' }
        : {}),
      onSelect: () => {
        addSelectionTo(m.id);
      },
    })),
    ...(list.length ? (['separator'] as const) : []),
    {
      label: 'New marker',
      action: 'new-marker',
      onSelect: () => {
        markers.add(selection.list());
        selection.clear(); // used up, as in addSelectionTo
      },
    },
  ];
}
/** Opens `entries` as a dropdown under toolbar button `btn`; a second click closes it. */
export function openDropdown(btn: HTMLElement, entries: readonly MenuEntry[]): void {
  if (contextMenu.justClosedBy(btn)) return;
  const r = btn.getBoundingClientRect();
  contextMenu.open(entries, { x: r.left, y: r.bottom + 2 }, btn);
}
// Select row: "Add to marker ▾" — the same choices as the right-click menu.
const addToMarkerBtn = byId('add-to-marker') as HTMLButtonElement;
addToMarkerBtn.addEventListener('click', () => {
  openDropdown(addToMarkerBtn, addToEntries());
});
function applyAddToMarkerButton(count: number): void {
  addToMarkerBtn.disabled = count === 0;
  addToMarkerBtn.title =
    count === 0
      ? 'Select something first'
      : `Add the selection (${String(count)}) to a marker — also on right-click`;
}
applyAddToMarkerButton(0);
// Brush / Smart fill row: the marker they paint with; the dropdown switches it.
const activeMarkerBtn = byId('active-marker') as HTMLButtonElement;
activeMarkerBtn.addEventListener('click', () => {
  const active = markers.active();
  const list = markers.list();
  openDropdown(activeMarkerBtn, [
    ...list.map((m) => ({
      label: m.name,
      swatch: m.color,
      checked: m.id === active?.id,
      action: `paint-with:${m.id}`,
      onSelect: () => {
        markers.setActive(m.id);
      },
    })),
    ...(list.length ? (['separator'] as const) : []),
    {
      label: 'New marker',
      action: 'new-marker',
      onSelect: () => {
        markers.add();
      },
    },
  ]);
});
export function applyActiveMarkerButton(): void {
  const active = markers.active();
  byId('active-marker-name').textContent = active ? active.name : 'No marker';
  byId('active-marker').title = active
    ? `Marker to paint with: ${active.name}`
    : 'Marker to paint with';
  byId('active-marker-dot').style.setProperty('--swatch', active ? active.color : 'transparent');
  byId('active-marker').classList.toggle('none', !active); // runs before the const above is set
}
// Box: left→right adds, right→left removes. Selected items of hidden bodies are left
// alone, so "select, hide, box what was behind, show" keeps both.
viewport.onBoxSelect = (items, action) => {
  if (action === 'add') selection.addAll(items);
  else selection.removeAll(items);
};
// Double click: its two single clicks toggled the entity on and off again, so this just adds
// or removes more. On an edge = its tangent chain (all selected → remove, else add, like a
// click); elsewhere on a part = the whole body, whatever the filter; on empty space = clear.
viewport.onDoubleClick = (hit, body) => {
  if (body === undefined) selection.clear();
  else if (hit?.kind === 'edge') toggleEdgeChain(hit.id);
  else selection.toggle({ kind: 'body', id: body });
};
function toggleEdgeChain(edge: number): void {
  const chain = shownModel?.edgeChain;
  const ids = chain ? edgesInChain(chain, edge) : [edge];
  selection.toggleAll(ids.map((id) => ({ kind: 'edge' as const, id })));
}

// --- Toolbar button icons -------------------------------------------------
export const TOOL_ICONS: Record<ToolId, string> = {
  select: POINTER,
  brush: BRUSH,
  'smart-fill': BUCKET,
};
const FILTER_ICONS = { vertex: VERTEX, edge: EDGE, face: FACE, body: BODY } as const;
/** Button text the toolbar hides when narrow; the button keeps it as aria-label. */
export function toolbarLabel(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'tb-label';
  span.textContent = text;
  return span;
}

// --- Selection filter ----------------------------------------------------
const filterButtonsEl = byId('filter-buttons');
export const filterButtons = new Map<string, HTMLButtonElement>();
const isFilterText = (v: unknown): v is string => parseFilter(v) !== undefined;
let filter =
  parseFilter(loadSetting(FILTER_STORAGE_KEY, isFilterText, serializeFilter(DEFAULT_FILTER))) ??
  DEFAULT_FILTER;
const FILTER_TITLES = {
  vertex: 'Pick vertices',
  edge: 'Pick edges',
  face: 'Pick faces',
  body: 'Pick whole bodies (with Face off; or double-click a part)',
} as const;
for (const kind of FILTER_KINDS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn tb-btn filter';
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  btn.append(icon(FILTER_ICONS[kind]), toolbarLabel(label));
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', () => {
    filter = toggleFilter(filter, kind);
    saveSetting(FILTER_STORAGE_KEY, serializeFilter(filter));
    applyFilterButtons();
  });
  filterButtonsEl.appendChild(btn);
  filterButtons.set(kind, btn);
}
export function applyFilterButtons(): void {
  const onCount = FILTER_KINDS.filter((k) => filter[k]).length;
  for (const kind of FILTER_KINDS) {
    const btn = filterButtons.get(kind);
    if (!btn) continue;
    btn.setAttribute('aria-pressed', String(filter[kind]));
    btn.title =
      FILTER_TITLES[kind] + (filter[kind] && onCount === 1 ? ' — at least one stays on' : '');
  }
  viewport.setSelectionFilter(filter);
}
applyFilterButtons();
