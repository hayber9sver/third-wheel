/**
 * Markers, comments, dimensions in the view and 3D comment pins; autosave of the notes.
 */
import { Markers, shownEntities, colorToHex, type Marker } from '../markers.js';
import { Autosave } from '../autosave.js';
import type { SaveResult } from '../../../shared/ipc.js';
import { PaintLayer } from '../paint.js';
import { MarkersPanel } from '../markers-panel.js';
import { ghostShapes } from '../ghosts.js';
import type { SelectionItem } from '../selection.js';
import { hoverLabel } from '../hover-label.js';
import type { StepModel } from '@third-wheel/geometry';
import { NO_MARKER_COLOR } from '../brush-cursor.js';
import { Comments, liveMarkerIds, resolvedMarkerIds } from '../comments.js';
import { dimensionOf } from '../info-format.js';
import { pinSpecs } from '../comment-pins.js';
import {
  applyActiveMarkerButton,
  applyBrushInfo,
  byId,
  commentsPanel,
  exactValues,
  forgetShownPart,
  lookUpShownPart,
  partMayChange,
  placeMarkerGhost,
  selection,
  setPartMayChange,
  shownFile,
  shownModel,
  showNotice,
  shownPart,
  viewport,
} from '../main.js';

// --- Markers -------------------------------------------------------------
// Right panel under Info. Brush paints with the active marker; its colour is the circle's.
export const markers = new Markers();
/** Comments on the shown model (made here, before the panels: resolved markers read them). */
export const comments = new Comments();
/** Saves the shown model's annotations next to it; every change below calls `changed()`. */
export const autosave = new Autosave({
  write: async (path, text) => {
    const api = window.thirdWheel;
    if (!api) return { ok: false, error: 'No file access' };
    return afterWrite(path, await api.saveSidecar(path, text, path === backupBeforeWrite));
  },
  writeSync: (path, text) => {
    const api = window.thirdWheel;
    if (!api) return { ok: false, error: 'No file access' };
    return afterWrite(path, api.saveSidecarSync(path, text, path === backupBeforeWrite));
  },
});
/**
 * Model whose sidecar is copied to a `.bak.json` before the next write: its load dropped data
 * (unknown fields, items that didn't fit), which that write would lose.
 */
export let backupBeforeWrite: string | undefined;
/** Sets `backupBeforeWrite` from another module (an import can't be assigned). */
export function setBackupBeforeWrite(value: typeof backupBeforeWrite): void {
  backupBeforeWrite = value;
}
function afterWrite(path: string, result: SaveResult): SaveResult {
  // The first save lists the file in the project; a link may move it to another part.
  if (result.ok && path === shownFile?.path && (!shownPart || partMayChange)) {
    setPartMayChange(false);
    forgetShownPart();
    lookUpShownPart();
  }
  if (result.ok && path === backupBeforeWrite) {
    backupBeforeWrite = undefined;
    if (result.backup !== undefined) {
      showNotice(`Saved. The annotations file as it was before is kept as ${result.backup}.`);
    }
  }
  return result;
}
/** Paint of the shown model: marker per triangle; replaced when a model loads. */
export let paint: PaintLayer | undefined;
/** Sets `paint` from another module (an import can't be assigned). */
export function setPaint(value: typeof paint): void {
  paint = value;
}
export const markersPanel = new MarkersPanel(byId('markers'), markers, {
  addSelection: (id) => {
    addSelectionTo(id);
  },
  label: (item) => entityLabel(item),
  hover: (item) => {
    viewport.setListHover(item ? [item] : []);
  },
  select: (item) => {
    if (!selection.has(item)) selection.addAll([item]);
  },
  placeTransfer: (id) => {
    placeMarkerGhost(id);
  },
  hoverMarker: (id) => {
    hoveredMarker = id;
    applyGhostBold();
  },
  resolved: () => resolvedMarkers(),
  bare: () => bareMarkers(),
  notice: (text) => {
    showNotice(text);
  },
});
/** Marker row under the pointer: its ghost is drawn bold. */
let hoveredMarker: string | undefined;
/** Body visibility from the body list (ghosts on hidden bodies are left out). */
export let bodyVisible: readonly boolean[] = [];
/** Sets `bodyVisible` from another module (an import can't be assigned). */
export function setBodyVisible(value: typeof bodyVisible): void {
  bodyVisible = value;
}
/** Ghosts of markers the revision transfer could not place. */
export function applyGhosts(): void {
  viewport.setGhosts(ghostShapes(drawnMarkers(resolvedMarkers()), bodyVisible));
  applyGhostBold();
}
/** Bold ghosts: the hovered marker row and the highlighted comment's markers. */
function applyGhostBold(): void {
  const ids = new Set(commentTargets(commentsPanel.focusedId).markerIds);
  if (hoveredMarker !== undefined) ids.add(hoveredMarker);
  viewport.setGhostBold(ids);
}
/** e.g. "Face 12 (cylinder Ø6 hole) · Bracket" — like the hover readout. */
function entityLabel(item: SelectionItem): string {
  const model = shownModel;
  const kind = item.kind.charAt(0).toUpperCase() + item.kind.slice(1);
  if (!model) return `${kind} ${String(item.id)}`;
  const body = item.kind === 'body' ? item.id : bodyOfEntity(model, item);
  if (body === undefined) return `${kind} ${String(item.id)}`;
  return hoverLabel({ ...item, body }, model);
}
function bodyOfEntity(model: StepModel, item: SelectionItem): number | undefined {
  if (item.kind === 'face') return model.faceBody[item.id];
  if (item.kind === 'edge') return model.edgeBody[item.id];
  if (item.kind === 'vertex') return model.vertexBody[item.id];
  return item.id;
}
/**
 * Adds the selection to a marker; a hidden marker is shown, else nothing would change.
 * The selection is used up (like a finished Fusion / SolidWorks command), so it doesn't ride along
 * into the next marker or comment.
 */
export function addSelectionTo(id: string): void {
  const marker = markers.get(id);
  if (marker && resolvedMarkers().has(id)) {
    showNotice(resolvedMarkerNotice(marker.name)); // greyed out in the menus; kept as a guard
    return;
  }
  if (markers.addEntities(id, selection.list()) > 0) {
    if (markers.get(id)?.visible === false) markers.setVisible(id, true);
  }
  selection.clear();
}
/** False until the tools below are set up (applyMarkers runs once before them). */
export let toolsReady = false;
/** Sets `toolsReady` from another module (an import can't be assigned). */
export function setToolsReady(value: typeof toolsReady): void {
  toolsReady = value;
}
/**
 * Resolved markers: every comment on them is closed (`resolvedMarkerIds`). Hidden in the view
 * (faded with "Show resolved"), never painted, erased or added to; the eye stays the user's own.
 */
export function resolvedMarkers(): Set<string> {
  return resolvedMarkerIds(comments.list());
}
/**
 * Markers a comment uses that hold nothing on the shown version (no paint, entities or unplaced
 * part): comments are the part's, so an earlier version's marker is listed here too.
 */
export function bareMarkers(): Set<string> {
  const named = new Set(comments.list().flatMap((c) => c.markerIds));
  return new Set(
    markers
      .list()
      .filter(
        (m) =>
          named.has(m.id) &&
          m.entities.length === 0 &&
          m.transfer?.ghost === undefined &&
          (paint?.count(m.id) ?? 0) === 0,
      )
      .map((m) => m.id),
  );
}
/** Bare set the panel was last drawn with. */
let drawnBare = '';
/** After a paint change: redraws the Markers list when a marker got its first paint or lost its last. */
export function applyBareMarkers(): void {
  const key = [...bareMarkers()].sort().join(' ');
  if (key === drawnBare) return;
  drawnBare = key;
  markersPanel.render();
}
/** Markers as the view draws them: resolved ones hidden unless "Show resolved" is on. */
function drawnMarkers(resolved: ReadonlySet<string>): Marker[] {
  const show = commentsPanel.showsClosed;
  return markers
    .list()
    .map((m) => (m.visible && !show && resolved.has(m.id) ? { ...m, visible: false } : m));
}
/** Resolved set the view was last drawn with (comment changes redraw only when it changes). */
let drawnResolved = '';
/**
 * Redraws the markers when a comment change (or "Show resolved") changed what is resolved.
 * Returns whether it did (that also re-rendered the comments panel and the focus).
 */
export function applyResolvedMarkers(force = false): boolean {
  const key = [...resolvedMarkers()].sort().join(' ');
  if (!force && key === drawnResolved) return false;
  applyMarkers();
  return true;
}
export function applyMarkers(): void {
  const resolved = resolvedMarkers();
  drawnResolved = [...resolved].sort().join(' ');
  drawnBare = [...bareMarkers()].sort().join(' ');
  markersPanel.render();
  applyActiveMarkerButton();
  const active = markers.active();
  const drawn = drawnMarkers(resolved);
  viewport.setMarkerEntities(
    shownEntities(drawn, active?.id).map((e) =>
      resolved.has(e.markerId) ? { ...e, fade: true } : e,
    ),
  );
  viewport.setBrushColor(active ? colorToHex(active.color) : NO_MARKER_COLOR);
  if (toolsReady) applyBrushInfo(); // the readout names the marker Shift erases
  paint?.retainMarkers(drawn.map((m) => m.id)); // a deleted marker loses its paint
  viewport.setMarkerStyles(
    drawn.map((m) => ({
      id: m.id,
      color: colorToHex(m.color),
      visible: m.visible,
      ...(resolved.has(m.id) ? { fade: true } : {}),
    })),
  );
  commentsPanel.render(); // chip names / colours, deleted markers
  applyCommentFocus();
  applyGhosts();
  autosave.changed();
}
markers.onChange = applyMarkers;

// --- Comments -----------------------------------------------------------
// A comment points at markers only. Clicking one highlights it: its markers' entities like a
// hover, its markers' paint in full colour, every other marker faded. Zoom is separate.
export const COMMENTS_SHOW_CLOSED_KEY = 'third-wheel.comments-show-closed';
/** A comment's (existing) markers and the entities they hold. */
export function commentTargets(id: string | undefined): {
  items: SelectionItem[];
  markerIds: string[];
} {
  const c = id === undefined ? undefined : comments.get(id);
  if (!c) return { items: [], markerIds: [] };
  const ids = liveMarkerIds(c, (m) => markers.get(m) !== undefined);
  const seen = new Set<string>();
  const items: SelectionItem[] = [];
  for (const mid of ids) {
    for (const e of markers.get(mid)?.entities ?? []) {
      const key = `${e.kind}:${String(e.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ kind: e.kind, id: e.id });
    }
  }
  return { items, markerIds: ids };
}
/** Re-draws the focused comment's highlight (its markers or the comment changed). */
export function applyCommentFocus(): void {
  const t = commentTargets(commentsPanel.focusedId);
  viewport.setCommentFocus(t.items, t.markerIds);
  applyGhostBold();
  queuePins();
  applyDimensions();
}

// --- Dimensions in the view ----------------------------------------------------
// One dimension for the selection and one for the highlighted comment, each only with 1–2
// entities (3+ = nothing, like Info). Never stored: drawn while selected / highlighted.
export function applyDimensions(focusedId = commentsPanel.focusedId): void {
  const model = shownModel;
  if (!model || model.meshFormat) {
    viewport.setDimensions([]);
    return;
  }
  const own = dimensionOf(model, selection.list(), exactValues);
  const focused = dimensionOf(model, commentTargets(focusedId).items, exactValues);
  // The same pair picked in the other order swaps the line's ends: still the same dimension.
  const same =
    own &&
    focused &&
    own.label === focused.label &&
    ((String(own.from) === String(focused.from) && String(own.to) === String(focused.to)) ||
      (String(own.from) === String(focused.to) && String(own.to) === String(focused.from)));
  viewport.setDimensions([own, same ? undefined : focused].filter((d) => d !== undefined));
}

// --- 3D pins ------------------------------------------------------------
// One numbered pin per shown comment with a visible marker, anchored on its markers' entities +
// paint. Rebuilt once per task after any change (comments, markers, paint, focus, visibility).
let pinsQueued = false;
export function queuePins(): void {
  if (pinsQueued) return;
  pinsQueued = true;
  queueMicrotask(() => {
    pinsQueued = false;
    updatePins();
  });
}
function updatePins(): void {
  const specs = pinSpecs(
    comments.list(),
    (id) => markers.get(id)?.visible,
    commentsPanel.showsClosed,
    commentsPanel.focusedId,
  );
  const painted = paint?.trianglesByMarker(new Set(specs.flatMap((p) => p.markerIds)));
  viewport.setCommentPins(
    specs.map((spec) => {
      const t = commentTargets(spec.id);
      const triangles: number[] = [];
      for (const id of spec.markerIds)
        for (const tri of painted?.get(id) ?? []) triangles.push(tri);
      return { spec, items: t.items, triangles };
    }),
  );
}
viewport.onPinClick = (id, detail) => {
  const section = byId('comments');
  if (section.classList.contains('collapsed')) section.querySelector<HTMLElement>('h2')?.click();
  commentsPanel.pinClicked(id, detail);
};

/** Hidden and resolved markers' paint is never painted over or erased. */
export function lockedMarkers(): Set<string> {
  const resolved = resolvedMarkers();
  return new Set(
    markers
      .list()
      .filter((m) => !m.visible || resolved.has(m.id))
      .map((m) => m.id),
  );
}
/**
 * Shift-erase removes only the active marker's paint (like a layer eraser):
 * every other marker is locked, and so is the active one while hidden or resolved.
 */
export function eraseLocks(activeId: string): Set<string> {
  const resolved = resolvedMarkers();
  return new Set(
    markers
      .list()
      .filter((m) => m.id !== activeId || !m.visible || resolved.has(m.id))
      .map((m) => m.id),
  );
}
/**
 * The active marker when it is resolved: Brush / Smart fill / erase do nothing with it
 * (its slot is taken and gone until one of its comments is reopened).
 */
export function resolvedActiveMarker(): Marker | undefined {
  const active = markers.active();
  return active && resolvedMarkers().has(active.id) ? active : undefined;
}
export function resolvedMarkerNotice(name: string): string {
  return `${name} belongs to resolved comments — reopen one or pick another marker.`;
}
/** Painting with a hidden marker would be invisible: show it when a paint stroke starts. */
export function showActiveIfHidden(): void {
  const active = markers.active();
  if (active && !active.visible) markers.setVisible(active.id, true);
}
