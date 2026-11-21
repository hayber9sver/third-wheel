/** Renderer entry: wires the layout, tools, theme and viewport. */
import './styles.css';
import { isThemeMode, resolveTheme, THEME_MODES, type ThemeMode } from '../../shared/theme.js';
import { BODY, BRUSH, BUCKET, EDGE, FACE, icon, POINTER, VERTEX } from './icons.js';
import { fitToolbar } from './toolbar-fit.js';
import { getCatalogue } from './library/catalogue-load.js';
import { initLibraryPanel } from './library/library-panel.js';
import { searchParts } from './library/search.js';
import {
  DEFAULT_NAVIGATION_STYLE,
  DEFAULT_ORBIT_STYLE,
  getNavigationStyle,
  isNavigationStyleId,
  isOrbitStyle,
  NAVIGATION_STYLES,
  ORBIT_STYLES,
  type NavigationStyleId,
} from './navigation.js';
import type { LoadRequest, ModelFile, ModelVersionFile, SaveResult } from '../../shared/ipc.js';
import {
  annotationsParamsSchema,
  chainAfter,
  confirmsParent,
  editChain,
  makesCircle,
  removalPlan,
  sameVersion,
  walkEarlier,
  type ChainRead,
  type VersionKey,
  earlierVersions,
  relocated,
  fromRuns,
  formatJson,
  nextVersionName,
  sameOverallSize,
  modelIdOf,
  parseParams,
  renderParamsSchema,
  requestReviewParamsSchema,
  setCommentStatusParamsSchema,
  replyCommentParamsSchema,
  searchPartsParamsSchema,
  customBodyNames,
  lostBodyNames,
  lostBodyNamesWarning,
  waitReviewParamsSchema,
  type BodyFingerprint,
  type CommentStatus,
  type LoadResult,
  type RevisionInfo,
  parseAnnotationsJson,
  type Annotations,
  type MeshCoverage,
  type TransferSummary,
  type RenderResult,
  type RenderView,
  type RequestReviewResult,
  type ReviewModelCount,
  type SetCommentStatusResult,
  type ReplyCommentResult,
  type StatusResult,
  type VersionCandidate,
  type VersionChain,
  type VersionLink,
  versionChainSchema,
} from '@third-wheel/core';
import {
  bodyFingerprints,
  entityFingerprints,
  filterReviewPayload,
  isEmptyExactRequest,
  meshFormatOf,
  meshHash,
  placeGhost,
  reviewPayload,
  reviewPayloadText,
  transferAnnotations,
  transferMeshAnnotations,
  type TransferResult,
  type ReviewPayload,
  type ExactRequest,
  type StepModel,
} from '@third-wheel/geometry';
import { BodyList, stepTreeOf } from './body-list.js';
import { BodyFolders, type FolderEditKind } from './body-folders.js';
import {
  dictationLabel,
  isMacPlatform,
  isPrimaryShortcut,
  undoRedoLabels,
  undoRedoShortcut,
  listClickMode,
  shortcutLabel,
} from '../../shared/shortcuts.js';
import { ModelLoader } from './model-loader.js';
import { PerfProbe, perfModeFromUrl } from './perf-probe.js';
import {
  BRUSH_LARGER_KEY,
  BRUSH_RADII_MM,
  BRUSH_SMALLER_KEY,
  brushInfo,
  DEFAULT_BRUSH_RADIUS_MM,
  DEFAULT_TOOL,
  formatBrushRadius,
  stepBrushRadius,
  TOOLS,
  toolForKey,
  toolTitle,
  type ToolId,
} from './tools.js';
import { PaintLayer, PaintRecord } from './paint.js';
import { Autosave, type SaveState } from './autosave.js';
import { setupAiConnect } from './ai-connect.js';
import { ShortcutOnce } from '../../shared/menu-commands.js';
import { setupAbout } from './about.js';
import { saveStatusView } from '../../shared/ai-status.js';
import {
  applyPaint,
  checkSidecar,
  emptyNotesFor,
  fromAnnotations,
  merge as mergePieces,
  toAnnotations,
  type SidecarInput,
} from './sidecar.js';
import { sidecarFileName } from '../../shared/sidecar-path.js';
import {
  carriedText,
  hasNotes,
  keptOwnText,
  movedText,
  meshMovedText,
  meshQuestion,
  ownNotesQuestion,
  revisionResult,
  sameGeometry,
  transferSummary,
  versionQuestionText,
  waitingText,
  type PreviousAnnotations,
} from './revision.js';
import { UndoHistory } from './undo.js';
import { DEFAULT_FILL_ANGLE_DEG, MAX_FILL_ANGLE_DEG, stepFillAngle } from './smart-fill.js';
import { FIT_KEY, viewForKey } from './camera-views.js';
import { DEFAULT_PICK_RADIUS, Viewport, type ContactSheet, type RegionImage } from './viewport.js';
import { regionRequest } from './region-view.js';
import { ReviewRequests, type ReviewModel } from './review-request.js';
import { ReviewedFiles, sendToAiMessage } from './send-to-ai.js';
import { hoverLabel } from './hover-label.js';
import { cheatSheet, HELP_KEY, type HelpRow } from './help.js';
import { Selection, selectionBodies, selectionSummary } from './selection.js';
import {
  COLLAPSED_STORAGE_KEY,
  makeCollapsible,
  parseCollapsed,
  serializeCollapsed,
} from './collapsible.js';
import { approxRequest, describeSelection, ExactValues } from './info-format.js';
import { INFO_MESH_HINT, InfoPanel } from './info-panel.js';
import { colorToHex, Markers, shownEntities } from './markers.js';
import { ContextMenu, type MenuEntry } from './context-menu.js';
import type { SelectionItem } from './selection.js';
import { NO_MARKER_COLOR, SurfaceRaycaster } from './brush-cursor.js';
import { MarkersPanel } from './markers-panel.js';
import { ghostShapes } from './ghosts.js';
import { versionDiff, type VersionDiff } from './version-diff.js';
import { versionDetail, versionLabel, versionRows, type VersionRow } from './version-list.js';
import {
  COMMENT_EDIT_LABELS,
  Comments,
  commentsOnMarkers,
  liveMarkerIds,
  nextCommentMarkerName,
} from './comments.js';
import { CommentsPanel } from './comments-panel.js';
import { pinSpecs } from './comment-pins.js';
import {
  DEFAULT_FILTER,
  FILTER_KINDS,
  FILTER_STORAGE_KEY,
  parseFilter,
  serializeFilter,
  toggleFilter,
} from './selection-filter.js';

const THEME_STORAGE_KEY = 'third-wheel.theme';
const NAV_STYLE_STORAGE_KEY = 'third-wheel.navigation-style';
const ORBIT_STYLE_STORAGE_KEY = 'third-wheel.orbit-style';
const THEME_LABEL: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
}

// localStorage may be unavailable (or throw); settings then just don't persist.
function loadSetting<T>(key: string, isValid: (v: unknown) => v is T, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return isValid(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted.
  }
}

// --- Viewport ---------------------------------------------------------------
const viewport = new Viewport(byId('viewport'));

// --- Theme ------------------------------------------------------------------
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
// Status bar menu next to Orbit / Navigation (T10.1: off the toolbar).
const themeSelect = byId('theme-mode') as HTMLSelectElement;
for (const mode of THEME_MODES) themeSelect.add(new Option(THEME_LABEL[mode], mode));
themeSelect.title = 'Theme: Auto follows the system appearance';

let themeMode = loadSetting(THEME_STORAGE_KEY, isThemeMode, 'system');

function applyTheme(): void {
  const resolved = resolveTheme(themeMode, systemDark.matches);
  document.documentElement.dataset['theme'] = resolved;
  themeSelect.value = themeMode;
  viewport.setTheme(resolved);
}

function setThemeMode(mode: ThemeMode): void {
  themeMode = mode;
  saveSetting(THEME_STORAGE_KEY, mode);
  window.thirdWheel?.setThemeSource(mode);
  applyTheme();
}

themeSelect.addEventListener('change', () => {
  if (isThemeMode(themeSelect.value)) setThemeMode(themeSelect.value);
});
// With an explicit light/dark source, Electron reports that as the media query, so this only
// changes the result in system mode — but it must re-run then.
systemDark.addEventListener('change', applyTheme);
window.thirdWheel?.setThemeSource(themeMode);
applyTheme();

// --- Help / cheat sheet (T2.7) -----------------------------------------------------
// "?" button or ? key; content follows the navigation style. Stays open while the user tries
// things out; closes with ×, the button, ? or Esc.
const isMac = isMacPlatform(navigator.userAgent);
const helpSheet = byId('help-sheet');
const helpToggle = byId('help-toggle');
helpToggle.title = `Controls and shortcuts (${HELP_KEY})`;

function renderHelp(): void {
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = 'Controls';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'help-close';
  close.textContent = '×';
  close.title = `Close (${HELP_KEY} or Esc)`;
  close.setAttribute('aria-label', 'Close help');
  close.addEventListener('click', () => {
    setHelpOpen(false);
  });
  header.append(title, close);
  const hint = document.createElement('p');
  hint.className = 'help-hint';
  hint.textContent = `${HELP_KEY} or Esc closes · stays open while you try things`;
  const groups = document.createElement('div');
  groups.className = 'help-groups';
  const list = (rows: readonly HelpRow[]): HTMLDListElement => {
    const dl = document.createElement('dl');
    for (const row of rows) {
      const dt = document.createElement('dt');
      dt.textContent = row.input;
      const dd = document.createElement('dd');
      dd.textContent = row.action;
      dl.append(dt, dd);
    }
    return dl;
  };
  for (const section of cheatSheet(getNavigationStyle(navStyleId), isMac)) {
    const group = document.createElement('section');
    group.className = 'help-group';
    const h3 = document.createElement('h3');
    h3.textContent = section.title;
    group.append(h3, list(section.rows));
    if (section.more.length > 0) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'More';
      details.append(summary, list(section.more));
      group.append(details);
    }
    groups.append(group);
  }
  const parts: HTMLElement[] = [header, hint, groups];
  helpSheet.replaceChildren(...parts);
}

function isHelpOpen(): boolean {
  return !helpSheet.hidden;
}

function setHelpOpen(open: boolean): void {
  helpSheet.hidden = !open;
  helpToggle.setAttribute('aria-expanded', String(open));
  helpToggle.setAttribute('aria-pressed', String(open));
}
helpToggle.addEventListener('click', () => {
  setHelpOpen(!isHelpOpen());
});

// --- Navigation (mouse/trackpad style) --------------------------------------
const navSelect = byId('nav-style') as HTMLSelectElement;
for (const style of NAVIGATION_STYLES) {
  navSelect.add(new Option(style.label, style.id));
}
let navStyleId: NavigationStyleId = loadSetting(
  NAV_STYLE_STORAGE_KEY,
  isNavigationStyleId,
  DEFAULT_NAVIGATION_STYLE,
);

function applyNavigation(): void {
  const style = getNavigationStyle(navStyleId);
  navSelect.value = navStyleId;
  navSelect.title = `${style.mouseHelp}\n${style.trackpadHelp}`;
  viewport.setNavigation(style);
  renderHelp();
}

navSelect.addEventListener('change', () => {
  if (!isNavigationStyleId(navSelect.value)) return;
  navStyleId = navSelect.value;
  saveSetting(NAV_STYLE_STORAGE_KEY, navStyleId);
  applyNavigation();
});
applyNavigation();

// --- Orbit style (turntable / free) -------------------------------------------
const orbitSelect = byId('orbit-style') as HTMLSelectElement;
for (const style of ORBIT_STYLES) orbitSelect.add(new Option(style.label, style.id));
orbitSelect.title =
  'Turntable: Z stays upright, orbit stops at the top and bottom.\nFree: tumble in any direction (0 or Iso straightens the view).';
orbitSelect.value = loadSetting(ORBIT_STYLE_STORAGE_KEY, isOrbitStyle, DEFAULT_ORBIT_STYLE);
if (isOrbitStyle(orbitSelect.value)) viewport.setOrbitStyle(orbitSelect.value);
orbitSelect.addEventListener('change', () => {
  if (!isOrbitStyle(orbitSelect.value)) return;
  saveSetting(ORBIT_STYLE_STORAGE_KEY, orbitSelect.value);
  viewport.setOrbitStyle(orbitSelect.value);
});

// --- Info overlay, bottom left of the view (T2.7) ------------------------------
const modelInfo = byId('model-info');
const selectionInfo = byId('selection-info');
let modelStatus = 'No model loaded';
let selectionStatus = '';
function renderStatus(): void {
  modelInfo.textContent = modelStatus;
  modelInfo.title = modelStatus;
  selectionInfo.textContent = selectionStatus;
}

// --- Hover readout (the viewport draws the highlight) -------------------------
// Pick radius in CSS px; no UI yet (setting key reserved for the selection toolbar / settings).
const PICK_RADIUS_KEY = 'third-wheel.pick-radius';
const isRadius = (v: unknown): v is string => typeof v === 'string' && /^\d{1,2}(\.\d+)?$/.test(v);
viewport.setPickRadius(Number(loadSetting(PICK_RADIUS_KEY, isRadius, String(DEFAULT_PICK_RADIUS))));
const hoverInfo = byId('hover-info');
let shownModel: StepModel | undefined;
/** The shown model's sidecar has been read (before that its comments are not all there). */
let annotationsReady = false;
/** The shown model's load finished: drawn, panels filled, first frame out (test hook, T12.1). */
let loadFinished = false;
let shownPath: string | undefined;
/** The shown model file, as the app bridge reports it (`status`, T7.1). */
let shownFile: StatusResult['model'] = null;
viewport.onHover = (hit) => {
  hoverInfo.textContent = hit && shownModel ? hoverLabel(hit, shownModel) : '';
};

// --- Collapsible panel sections + Info panel (T2.5) ----------------------------------
const isAnyText = (v: unknown): v is string => typeof v === 'string';
const collapsed = parseCollapsed(loadSetting(COLLAPSED_STORAGE_KEY, isAnyText, '[]'));
const infoPanel = new InfoPanel(byId('info-body'));
/** Exact values from OpenCascade for the shown model (T2.8); reset when a model loads. */
let exactValues = new ExactValues();
/** An "Exact values" request is running; text = progress. */
let exactBusy: string | undefined;
let exactError: string | undefined;
/** Last load time, for the re-read estimate. */
let lastLoadMs = 0;
/** Info is only worked out while its section is open (face areas need a pass over the mesh). */
function renderInfo(): void {
  if (collapsed.has('info')) return;
  if (!shownModel) {
    infoPanel.render([]);
    return;
  }
  const model = shownModel;
  if (model.meshFormat) {
    infoPanel.render([], undefined, INFO_MESH_HINT);
    return;
  }
  const items = selection.list();
  const request = approxRequest(model, items, exactValues);
  const showButton = exactBusy !== undefined || !isEmptyExactRequest(request);
  infoPanel.render(
    describeSelection(model, items, exactValues),
    showButton
      ? {
          busy: exactBusy !== undefined,
          note: exactBusy ?? exactError ?? (loader.exactNeedsReread ? rereadNote() : undefined),
          onClick: () => {
            void computeExact(model, request);
          },
        }
      : undefined,
  );
}
function rereadNote(): string {
  const s = Math.max(1, Math.round(lastLoadMs / 1000));
  const time = s < 90 ? `${String(s)} s` : `${String(Math.round(s / 60))} min`;
  return `To save memory on this large model, the file is read again first (about ${time}).`;
}
async function computeExact(model: StepModel, request: ExactRequest): Promise<void> {
  if (exactBusy !== undefined) return;
  exactBusy = '';
  exactError = undefined;
  renderInfo();
  try {
    const result = await loader.exact(request, (p) => {
      exactBusy = `${p.label}… ${String(Math.round(p.fraction * 100))} %`;
      infoPanel.setNote(exactBusy);
    });
    if (result && shownModel === model) exactValues.add(request, result);
  } catch (err) {
    if (shownModel === model)
      exactError = `Could not get exact values: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    exactBusy = undefined;
    renderInfo();
  }
}
for (const section of document.querySelectorAll<HTMLElement>('.panel-section[data-section]')) {
  const id = section.dataset['section'] ?? '';
  makeCollapsible(section, collapsed.has(id), (isCollapsed) => {
    if (isCollapsed) collapsed.add(id);
    else collapsed.delete(id);
    saveSetting(COLLAPSED_STORAGE_KEY, serializeCollapsed(collapsed));
    if (id === 'info' && !isCollapsed) renderInfo();
  });
}

// --- Markers (T3.2) -------------------------------------------------------------
// Right panel under Info. Brush paints with the active marker; its colour is the circle's.
const markers = new Markers();
/** Saves the shown model's annotations next to it (T5.1); every change below calls `changed()`. */
const autosave = new Autosave({
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
 * (unknown fields, items that didn't fit), which that write would lose (T5.2).
 */
let backupBeforeWrite: string | undefined;
function afterWrite(path: string, result: SaveResult): SaveResult {
  if (result.ok && path === backupBeforeWrite) {
    backupBeforeWrite = undefined;
    if (result.backup !== undefined) {
      showNotice(`Saved. The annotations file as it was before is kept as ${result.backup}.`);
    }
  }
  return result;
}
/** Paint of the shown model (T3.3): marker per triangle; replaced when a model loads. */
let paint: PaintLayer | undefined;
const markersPanel = new MarkersPanel(byId('markers'), markers, {
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
});
/** Marker row under the pointer (T8.3): its ghost is drawn bold. */
let hoveredMarker: string | undefined;
/** Body visibility from the body list (ghosts on hidden bodies are left out). */
let bodyVisible: readonly boolean[] = [];
/** Ghosts of markers the revision transfer could not place (T8.3). */
function applyGhosts(): void {
  viewport.setGhosts(ghostShapes(markers.list(), bodyVisible));
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
 * Adds the selection to a marker (T3.7); a hidden marker is shown, else nothing would change.
 * The selection is used up (like a finished Fusion / SolidWorks command), so it doesn't ride along
 * into the next marker or comment.
 */
function addSelectionTo(id: string): void {
  if (markers.addEntities(id, selection.list()) > 0) {
    if (markers.get(id)?.visible === false) markers.setVisible(id, true);
  }
  selection.clear();
}
/** False until the tools below are set up (applyMarkers runs once before them). */
let toolsReady = false;
function applyMarkers(): void {
  markersPanel.render();
  applyActiveMarkerButton();
  const active = markers.active();
  viewport.setMarkerEntities(shownEntities(markers.list(), active?.id));
  viewport.setBrushColor(active ? colorToHex(active.color) : NO_MARKER_COLOR);
  if (toolsReady) applyBrushInfo(); // the readout names the marker Shift erases
  const list = markers.list();
  paint?.retainMarkers(list.map((m) => m.id)); // a deleted marker loses its paint
  viewport.setMarkerStyles(
    list.map((m) => ({ id: m.id, color: colorToHex(m.color), visible: m.visible })),
  );
  commentsPanel.render(); // chip names / colours, deleted markers
  applyCommentFocus();
  applyGhosts();
  autosave.changed();
}
markers.onChange = applyMarkers;

// --- Comments (T4.2) -----------------------------------------------------------
// A comment points at markers only. Clicking one highlights it: its markers' entities like a
// hover, its markers' paint in full colour, every other marker faded. Zoom is separate.
const comments = new Comments();
const COMMENTS_SHOW_CLOSED_KEY = 'third-wheel.comments-show-closed';
/** A comment's (existing) markers and the entities they hold. */
function commentTargets(id: string | undefined): {
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
function applyCommentFocus(): void {
  const t = commentTargets(commentsPanel.focusedId);
  viewport.setCommentFocus(t.items, t.markerIds);
  applyGhostBold();
  queuePins();
}

// --- 3D pins (T4.3) ------------------------------------------------------------
// One numbered pin per shown comment with a visible marker, anchored on its markers' entities +
// paint. Rebuilt once per task after any change (comments, markers, paint, focus, visibility).
let pinsQueued = false;
function queuePins(): void {
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

/** Hidden markers' paint is never painted over or erased (T3.3). */
function lockedMarkers(): Set<string> {
  return new Set(
    markers
      .list()
      .filter((m) => !m.visible)
      .map((m) => m.id),
  );
}
/**
 * Shift-erase removes only the active marker's paint (like a layer eraser):
 * every other marker is locked, and so is the active one while hidden.
 */
function eraseLocks(activeId: string): Set<string> {
  return new Set(
    markers
      .list()
      .filter((m) => m.id !== activeId || !m.visible)
      .map((m) => m.id),
  );
}
/** Painting with a hidden marker would be invisible: show it when a paint stroke starts. */
function showActiveIfHidden(): void {
  const active = markers.active();
  if (active && !active.visible) markers.setVisible(active.id, true);
}
// --- Undo / redo (T3.5) ------------------------------------------------------
// One paint stroke = one step; marker add / delete / rename / recolour = one step each.
// Selection and hiding are not undoable (CAD convention / view state).
const history = new UndoHistory();
comments.onEdit = (edit) => {
  // T10.2: undo is the user's own steps; the AI's replies / status changes are never undone, and
  // undoing a user step keeps whatever the AI changed since (`apply`, not `restore`).
  if (edit.by === 'ai') return;
  history.push({
    label: COMMENT_EDIT_LABELS[edit.kind],
    undo: () => {
      comments.apply(edit.after, edit.before);
    },
    redo: () => {
      comments.apply(edit.before, edit.after);
    },
  });
};
const commentsPanel = new CommentsPanel(
  byId('comments'),
  comments,
  markers,
  {
    dropdown: (anchor, entries) => {
      openDropdown(anchor, entries);
    },
    focus: (id) => {
      const t = commentTargets(id);
      viewport.setCommentFocus(t.items, t.markerIds);
      queuePins();
    },
    zoom: (id) => {
      const t = commentTargets(id);
      viewport.frameFocus(t.items, paint?.trianglesOf(t.markerIds) ?? []);
    },
    postOnSelection: (text, markerIds, linkedModels) => {
      const items = pendingCommentSelection;
      pendingCommentSelection = [];
      if (items.length === 0) return;
      history.group('Comment on selection', () => {
        const marker = markers.add(items, nextCommentMarkerName(markers.list().map((m) => m.name)));
        comments.add(text, [marker.id, ...markerIds], 'human', linkedModels);
      });
      selection.clear(); // used up (Cancel keeps it), as in addSelectionTo
    },
    otherModels: () => otherSessionModels().map((m) => m.name),
    canOpenModel: (name) => otherSessionModels().some((m) => m.name === name),
    openModel: (name) => {
      const m = otherSessionModels().find((o) => o.name === name);
      if (m) void reopenModel(m.path);
    },
    showClosedChanged: (show) => {
      saveSetting(COMMENTS_SHOW_CLOSED_KEY, show ? '1' : '0');
      queuePins();
    },
    postKeyLabel: isMac ? '⌘ Enter' : 'Ctrl+Enter',
    dictationLabel: dictationLabel(isMac),
  },
  loadSetting(COMMENTS_SHOW_CLOSED_KEY, (v): v is string => v === '1' || v === '0', '0') === '1',
);
comments.onChange = () => {
  commentsPanel.render();
  applyCommentFocus();
  autosave.changed();
  renderSendToAi();
};
/** Selection when "Comment on selection" opened the writing box (the marker is made on post). */
let pendingCommentSelection: SelectionItem[] = [];
function commentOnSelection(): void {
  const items = selection.list();
  if (items.length === 0) return;
  pendingCommentSelection = [...items];
  const section = byId('comments');
  if (section.classList.contains('collapsed')) section.querySelector<HTMLElement>('h2')?.click();
  commentsPanel.openOnSelection(
    nextCommentMarkerName(markers.list().map((m) => m.name)),
    items.length,
  );
}
commentsPanel.hooksSelection = commentOnSelection;
applyMarkers();
/** Changes of the stroke in progress; becomes one undo step when it ends. */
let strokeRecord: { record: PaintRecord; label: string } | undefined;

const MARKER_EDIT_LABELS = {
  add: 'Add marker',
  remove: 'Delete marker',
  rename: 'Rename marker',
  color: 'Marker colour',
  'add-entities': 'Add to marker',
  'remove-entities': 'Remove from marker',
  confirm: 'Marker looks right',
  place: 'Place marker here',
} as const;
/** Paint set by "✓ Place here" just before its marker edit: undone / redone with it. */
let placedPaint: PaintRecord | undefined;
/**
 * "✓ Place here" on a "? Check" marker (T8.5): its ghost — the dots at the
 * mirrored place — becomes paint and held items there; one undo step.
 */
function placeMarkerGhost(id: string): void {
  const marker = markers.get(id);
  const ghost = marker?.transfer?.ghost;
  const model = shownModel;
  const layer = paint;
  if (!marker || !model || !layer) return;
  if (!ghost) {
    markers.confirmTransfer(id);
    return;
  }
  const placed = placeGhost(ghost, model);
  const rec = new PaintRecord();
  for (const f of placed.paint) {
    for (const t of fromRuns(f.triangles))
      if (model.triangleFace[t] === f.faceId) rec.note(t, layer.stateAt(t), id);
    for (const p of f.pieces ?? []) {
      const was = layer.stateAt(p.triangle);
      rec.note(p.triangle, was, mergePieces(was, p.tree, id));
    }
  }
  rec.seal();
  layer.restore(rec, 'after');
  viewport.paintChanged();
  placedPaint = rec;
  try {
    markers.placeTransfer(id, placed.entities, placed.ghost);
  } finally {
    placedPaint = undefined;
  }
  if (placed.ghost)
    showNotice(
      `Part of ${marker.name} couldn't be placed: it is still shown as dots (✕ Lost). Paint it again or dismiss it.`,
    );
}
markers.onEdit = (edit) => {
  const layer = paint;
  // A deleted marker loses its paint (applyMarkers runs right after this): keep it for undo.
  const lost = edit.kind === 'remove' ? layer?.recordMarker(edit.id).seal() : undefined;
  const placed = edit.kind === 'place' ? placedPaint : undefined;
  const takeActive = edit.kind === 'add' || edit.kind === 'remove';
  history.push(
    {
      label:
        edit.kind === 'add' && markers.get(edit.id)?.entities.length
          ? 'New marker from selection'
          : MARKER_EDIT_LABELS[edit.kind],
      undo: () => {
        markers.restore(edit.before, takeActive);
        if (lost && layer && lost.size > 0) {
          layer.restore(lost, 'before');
          viewport.paintChanged();
        }
        if (placed && layer) {
          layer.restore(placed, 'before');
          viewport.paintChanged();
        }
      },
      redo: () => {
        markers.restore(edit.after, takeActive);
        if (placed && layer) {
          layer.restore(placed, 'after');
          viewport.paintChanged();
        }
      },
    },
    // The system colour picker sends a change per drag step: those become one undo step.
    edit.live ? { mergeKey: `color:${edit.id}` } : {},
  );
};

/** One key press that reaches both the page and the app menu runs once (T13.2). */
const shortcutOnce = new ShortcutOnce();

function undoRedo(which: 'undo' | 'redo'): void {
  if (strokeRecord) return; // finish the stroke first
  if (which === 'undo') history.undo();
  else history.redo();
}

const undoButton = byId('undo') as HTMLButtonElement;
const redoButton = byId('redo') as HTMLButtonElement;
const undoKeys = undoRedoLabels(isMac);
function renderUndoButtons(): void {
  const u = history.undoLabel();
  const r = history.redoLabel();
  undoButton.disabled = u === undefined;
  redoButton.disabled = r === undefined;
  undoButton.title = u ? `Undo ${u} (${undoKeys.undo})` : `Nothing to undo (${undoKeys.undo})`;
  redoButton.title = r ? `Redo ${r} (${undoKeys.redo})` : `Nothing to redo (${undoKeys.redo})`;
}
history.onChange = () => {
  renderUndoButtons();
  queuePins(); // a paint stroke / undo moves the paint pins sit on
  autosave.changed(); // paint strokes and undo / redo (marker and comment edits also land here)
};
renderUndoButtons();
undoButton.addEventListener('click', () => {
  undoRedo('undo');
});
redoButton.addEventListener('click', () => {
  undoRedo('redo');
});
window.addEventListener('keydown', (e) => {
  const which = undoRedoShortcut(e, isMac);
  // In a text field (renaming a marker) the keys undo typing, as everywhere.
  if (!which || isTextField(e.target)) return;
  e.preventDefault();
  if (shortcutOnce.take(which, 'key', performance.now())) undoRedo(which);
});

const STROKE_LABELS = { brush: 'Brush stroke', erase: 'Erase', fill: 'Smart fill' } as const;
viewport.onStrokeStart = (erase) => {
  if (!erase) showActiveIfHidden();
  const kind = currentTool === 'smart-fill' ? 'fill' : erase ? 'erase' : 'brush';
  strokeRecord = { record: new PaintRecord(), label: STROKE_LABELS[kind] };
};
viewport.onStroke = (triangles, erase, spheres) => {
  if (!paint) return;
  const active = markers.active();
  const record = strokeRecord?.record;
  const changed = erase
    ? active
      ? paint.erase(triangles, eraseLocks(active.id), record, spheres)
      : 0
    : active
      ? paint.paint(triangles, active.id, lockedMarkers(), record, spheres)
      : 0; // no marker → Brush / erase do nothing
  if (changed > 0) viewport.paintChanged();
};
viewport.onStrokeEnd = () => {
  const done = strokeRecord;
  strokeRecord = undefined;
  const layer = paint;
  if (!done || !layer || done.record.size === 0) return;
  // A committed paint action ends the selection (switching tools alone keeps it, so a wrong
  // tool pick costs nothing). Selection isn't undoable, so undo doesn't bring it back.
  selection.clear();
  const record = done.record.seal();
  history.push({
    label: done.label,
    undo: () => {
      layer.restore(record, 'before');
      viewport.paintChanged();
    },
    redo: () => {
      layer.restore(record, 'after');
      viewport.paintChanged();
    },
  });
};

// --- Brush size (T3.3) / fill angle (T3.4): [ / ] and Alt + scroll, remembered ----------
const BRUSH_RADIUS_KEY = 'third-wheel.brush-radius';
const isRadiusText = (v: unknown): v is string =>
  typeof v === 'string' && Number(v) > 0 && Number(v) <= 1000;
let brushRadius = Number(
  loadSetting(BRUSH_RADIUS_KEY, isRadiusText, String(DEFAULT_BRUSH_RADIUS_MM)),
);
const brushInfoEl = byId('brush-info');
let currentTool: ToolId = DEFAULT_TOOL;
const FILL_ANGLE_KEY = 'third-wheel.fill-angle';
const FILL_WHOLE_FACE_KEY = 'third-wheel.fill-whole-face';
const isAngleText = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && Number(v) >= 0 && Number(v) <= MAX_FILL_ANGLE_DEG;
let fillAngle = Number(loadSetting(FILL_ANGLE_KEY, isAngleText, String(DEFAULT_FILL_ANGLE_DEG)));
let fillWholeFace =
  loadSetting(FILL_WHOLE_FACE_KEY, (v): v is string => v === '1' || v === '0', '0') === '1';
const fillOptionsEl = byId('fill-options');
const fillAngleEl = byId('fill-angle');
const fillAngleDown = byId('fill-angle-down') as HTMLButtonElement;
const fillAngleUp = byId('fill-angle-up') as HTMLButtonElement;
const fillWholeFaceEl = byId('fill-whole-face') as HTMLInputElement;
const filterGroupEl = byId('selection-filter');
const paintMarkerEl = byId('paint-marker');
const brushOptionsEl = byId('brush-options');
const brushSizeEl = byId('brush-size');
const brushSizeDown = byId('brush-size-down') as HTMLButtonElement;
const brushSizeUp = byId('brush-size-up') as HTMLButtonElement;
brushSizeDown.addEventListener('click', () => {
  stepBrush(-1);
});
brushSizeUp.addEventListener('click', () => {
  stepBrush(1);
});
/** Toolbar options follow the tool (T3.8): Pick for Select, marker + size / angle for paint. */
function showToolOptions(tool: ToolId): void {
  const painting = tool !== 'select';
  filterGroupEl.hidden = painting;
  paintMarkerEl.hidden = !painting;
  brushOptionsEl.hidden = tool !== 'brush';
  fillOptionsEl.hidden = tool !== 'smart-fill';
}

/** Shift held with a paint tool: the readout says it erases (T10.1; the circle turns red). */
let shiftHeld = false;
function setShiftHeld(down: boolean): void {
  if (down === shiftHeld) return;
  shiftHeld = down;
  applyBrushInfo();
}
window.addEventListener('keydown', (e) => {
  // Not while typing: a capital letter in a comment isn't an erase.
  if (e.key === 'Shift' && !isTypingTarget(e.target)) setShiftHeld(true);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') setShiftHeld(false);
});
window.addEventListener('blur', () => {
  setShiftHeld(false);
});

function applyBrushInfo(): void {
  const erase = { marker: markers.active()?.name, on: shiftHeld };
  brushInfoEl.textContent = brushInfo(
    currentTool,
    brushRadius,
    { angleDeg: fillAngle, wholeFace: fillWholeFace },
    erase,
  );
  brushInfoEl.classList.toggle('erasing', shiftHeld && brushInfoEl.textContent !== '');
}

function applyBrushRadius(): void {
  viewport.setBrushRadius(brushRadius);
  viewport.setFill(fillAngle, fillWholeFace);
  applyBrushInfo();
  showToolOptions(currentTool);
  brushSizeEl.textContent = formatBrushRadius(brushRadius);
  brushSizeDown.disabled = brushRadius <= (BRUSH_RADII_MM[0] ?? 0);
  brushSizeUp.disabled = brushRadius >= (BRUSH_RADII_MM[BRUSH_RADII_MM.length - 1] ?? Infinity);
  fillAngleEl.textContent = `${String(fillAngle)}°`;
  fillAngleEl.classList.toggle('disabled', fillWholeFace);
  fillAngleDown.disabled = fillWholeFace || fillAngle <= 0;
  fillAngleUp.disabled = fillWholeFace || fillAngle >= MAX_FILL_ANGLE_DEG;
  fillWholeFaceEl.checked = fillWholeFace;
}
function stepFill(steps: number): void {
  if (fillWholeFace) return;
  const next = stepFillAngle(fillAngle, steps);
  if (next === fillAngle) return;
  fillAngle = next;
  saveSetting(FILL_ANGLE_KEY, String(fillAngle));
  applyBrushRadius();
}
fillAngleDown.addEventListener('click', () => {
  stepFill(-1);
});
fillAngleUp.addEventListener('click', () => {
  stepFill(1);
});
fillWholeFaceEl.addEventListener('change', () => {
  fillWholeFace = fillWholeFaceEl.checked;
  saveSetting(FILL_WHOLE_FACE_KEY, fillWholeFace ? '1' : '0');
  applyBrushRadius();
  fillWholeFaceEl.blur(); // keep tool keys (V, B, …) working right after the click
});
/** `[` / `]` and Alt + scroll: fill angle in Smart fill, brush size otherwise. */
function stepToolSize(steps: number): void {
  if (currentTool === 'smart-fill') stepFill(steps);
  else stepBrush(steps);
}
function stepBrush(steps: number): void {
  const next = stepBrushRadius(brushRadius, steps);
  if (next === brushRadius) return;
  brushRadius = next;
  saveSetting(BRUSH_RADIUS_KEY, String(brushRadius));
  applyBrushRadius();
}
viewport.onSizeStep = stepToolSize;

// --- Selection (T2.2) ---------------------------------------------------------
const selection = new Selection();
selection.onChange = (items) => {
  exactError = undefined;
  renderInfo();
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
  selectionStatus = selectionSummary(items);
  renderStatus();
};
// Multi-select by default (T2.6): a click adds the entity or removes it again; modifier keys
// make no difference; a click on empty space does nothing.
viewport.onClick = (hit, triangle) => {
  showCommentsAt(hit, triangle);
  if (!hit) return;
  selection.toggle({ kind: hit.kind, id: hit.id });
  bodyList.revealBody(hit.body);
};
/** Comments whose markers hold the clicked entity / its body or paint the clicked triangle (T4.2). */
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
// Right-click menu (T3.7): add the selection to a marker or remove it from one. Right-clicking
// an item that isn't selected selects it first, like Fusion; a right-drag still navigates.
const contextMenu = new ContextMenu();
viewport.onContextMenu = (hit, at) => {
  if (hit && !selection.has(hit)) {
    selection.addAll([{ kind: hit.kind, id: hit.id }]);
    bodyList.revealBody(hit.body);
  }
  contextMenu.open(
    [
      ...markerMenu(selection.list()),
      'separator',
      {
        label: 'Reload from disk',
        action: 'reload-from-disk',
        disabled: !shownFile,
        title: 'Read the model file again after it changed',
        onSelect: () => void reloadFromDisk(),
      },
    ],
    at,
  );
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
/** "[markers] / New marker" — right-click "Add to marker ▸" and the toolbar button (T3.8). */
function addToEntries(): MenuEntry[] {
  const list = markers.list();
  return [
    ...list.map((m) => ({
      label: m.name,
      swatch: m.color,
      action: `add-to:${m.id}`,
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
function openDropdown(btn: HTMLElement, entries: readonly MenuEntry[]): void {
  if (contextMenu.justClosedBy(btn)) return;
  const r = btn.getBoundingClientRect();
  contextMenu.open(entries, { x: r.left, y: r.bottom + 2 }, btn);
}
// Select row (T3.8): "Add to marker ▾" — the same choices as the right-click menu.
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
// Brush / Smart fill row (T3.8): the marker they paint with; the dropdown switches it.
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
function applyActiveMarkerButton(): void {
  const active = markers.active();
  byId('active-marker-name').textContent = active ? active.name : 'No marker';
  byId('active-marker').title = active
    ? `Marker to paint with: ${active.name}`
    : 'Marker to paint with';
  byId('active-marker-dot').style.setProperty('--swatch', active ? active.color : 'transparent');
  byId('active-marker').classList.toggle('none', !active); // runs before the const above is set
}
// Box: left→right adds, right→left removes (T2.6). Selected items of hidden bodies are left
// alone, so "select, hide, box what was behind, show" keeps both.
viewport.onBoxSelect = (items, action) => {
  if (action === 'add') selection.addAll(items);
  else selection.removeAll(items);
};
// Double click on a part = whole body, whatever the filter (T2.3). Its two single clicks toggled
// the entity on and off again, so this just adds or removes the body. On empty space = clear (T2.6).
viewport.onDoubleClick = (body) => {
  if (body === undefined) selection.clear();
  else selection.toggle({ kind: 'body', id: body });
};

// --- Toolbar button icons (T10.1) -------------------------------------------------
const TOOL_ICONS: Record<ToolId, string> = { select: POINTER, brush: BRUSH, 'smart-fill': BUCKET };
const FILTER_ICONS = { vertex: VERTEX, edge: EDGE, face: FACE, body: BODY } as const;
/** Button text the toolbar hides when narrow (T10.1); the button keeps it as aria-label. */
function toolbarLabel(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'tb-label';
  span.textContent = text;
  return span;
}

// --- Selection filter (T2.3) ----------------------------------------------------
const filterButtonsEl = byId('filter-buttons');
const filterButtons = new Map<string, HTMLButtonElement>();
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
function applyFilterButtons(): void {
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

// --- Model loading ----------------------------------------------------------
const openButton = byId('open-model');
/** Logo + Open… in the middle of the view while no model is open. */
const emptyView = byId('empty-view');
byId('empty-open').addEventListener('click', () => {
  openButton.click();
});
const reloadButton = byId('reload-model') as HTMLButtonElement;
const progressBox = byId('load-progress');
const progressBar = byId('load-progress-bar') as HTMLProgressElement;
const progressLabel = byId('load-progress-label');
openButton.title = `Open a STEP, STL or 3MF file (${shortcutLabel('o', isMac)})`;
const loader = new ModelLoader();
// User folders in the body list (T5.4): undoable, saved in the sidecar.
const bodyFolders = new BodyFolders();
const FOLDER_EDIT_LABELS: Record<FolderEditKind, string> = {
  'new-folder': 'New folder',
  move: 'Move in body list',
  'rename-folder': 'Rename folder',
  'delete-folder': 'Delete folder',
};
bodyFolders.onEdit = (edit) => {
  history.push({
    label: FOLDER_EDIT_LABELS[edit.kind],
    undo: () => {
      bodyFolders.restore(edit.before);
    },
    redo: () => {
      bodyFolders.restore(edit.after);
    },
  });
};
const bodyList = new BodyList(
  byId('bodies'),
  (visible) => {
    viewport.setBodyVisibility(visible); // re-anchors the pins too
    bodyVisible = [...visible];
    applyGhosts();
  },
  (bodies) => {
    viewport.frameBodies(bodies);
  },
  (bodies, mode) => {
    if (shownModel?.meshFormat) return; // T9.1: no selection on a mesh (show / hide / zoom stay)
    const items = bodies.map((id) => ({ kind: 'body' as const, id }));
    if (mode === 'toggle') selection.toggleAll(items);
    else selection.addAll(items);
  },
  (e) => listClickMode(e),
  (bodies) => {
    viewport.setListHover(bodies.map((id) => ({ kind: 'body' as const, id })));
  },
  { arrangement: bodyFolders, menu: contextMenu },
);
const count = new Intl.NumberFormat('en-US');
const perfProbe = new PerfProbe(
  viewport,
  perfModeFromUrl(location.search),
  (text) => {
    modelStatus = text;
    renderStatus();
  },
  (radiusMm) => {
    autosave.setTarget(undefined); // bench paint is never saved next to the model
    markers.add();
    setActiveTool('brush');
    viewport.setBrushRadius(radiusMm);
  },
);

/** Bumped per `loadModel`: an older load stops after an await when a newer one started. */
let loadTicket = 0;
/**
 * The version the shown model replaced in this session (T8.1): its annotations (T8.2 moves them
 * when the geometry changed) and its mesh while it was the shown one (T8.3 shows it). Undefined
 * when the shown model is no new version of anything.
 */
let previousVersion:
  | {
      readonly path: string;
      readonly name: string;
      readonly doc?: Annotations;
      readonly model?: StepModel;
      readonly carried: boolean;
    }
  | undefined;
/** The shown model's version chain (T8.6), saved in its notes. */
let versionChain: VersionChain | undefined;
/**
 * Set by `loadAnnotations` (T8.6): the earlier version the shown file was linked to (Import new
 * version, Bring my notes over, `revisionOf`); its notes get a "newer version" line.
 */
let linkedEarlier: EarlierFile | undefined;
/** `loadAnnotations` added a link to the chain: save at once (T8.6). */
let chainChanged = false;
/**
 * T13.4: the earlier version the shown file was linked to before it was moved to another one (the
 * user picked, or the AI's `revisionOf`): its "newer version" signpost is taken out after the load.
 */
let unlinkedParent: VersionLink | undefined;
/** T13.4: what the AI is told about a link that was moved or refused (a circle). */
let chainWarning: string | undefined;
/** What `load_model` tells the AI about the previous version (T8.1). */
let revisionInfo: RevisionInfo | undefined;
/**
 * T8.4: the AI loaded a file that looks like a newer copy of a model of this session without
 * naming it in `revisionOf`.
 */
let versionHint: { readonly modelId: string; readonly name: string } | undefined;
/**
 * Show a model file. `revisionOf` (T8.1): an earlier model this file is a new version of (the AI
 * names it); the same file with new contents is found by itself. `askVersion` (the user loaded
 * it, so questions may be asked): T8.4 — a file without notes that looks like a newer version of
 * another asks to bring that one's notes over; T13.4 — a file linked to another earlier version
 * asks which one is right.
 */
async function loadModel(
  file: ModelFile,
  revisionOf?: { readonly path: string; readonly name: string },
  askVersion = false,
): Promise<void> {
  closeVersionQuestion(); // a question about an earlier load is moot now
  const t0 = performance.now();
  const sizeMB = (file.data.byteLength / 1e6).toFixed(1);
  modelStatus = `Loading ${file.name} (${sizeMB} MB)…`;
  renderStatus();
  emptyView.hidden = true;
  progressBox.hidden = false;
  progressBar.value = 0;
  progressLabel.textContent = '';
  try {
    const loaded = await loader.load(file, (p) => {
      progressBar.value = p.fraction;
      progressLabel.textContent = `${p.label}…`;
    });
    if (!loaded) return; // a newer load replaced this one
    // Counted only from here: a newer load still importing doesn't stop this one mid-way.
    const ticket = ++loadTicket;
    const { model, ms } = loaded;
    const tBuild = performance.now();
    const before = shownFile && shownModel ? { ...shownFile, model: shownModel } : undefined;
    autosave.flushSync(); // the old model's last changes, before its state goes
    keepLeavingReview(); // T7.4: the AI can still read it after the switch
    annotationsReady = false;
    loadFinished = false;
    autosave.setTarget(undefined); // resetting below is not a change
    hideNotice();
    lastSave = undefined;
    saveFile = sidecarFileName(file.name);
    renderSaveStatus('hidden');
    shownModel = model;
    shownPath = file.path;
    shownFile = {
      path: file.path,
      name: file.name,
      contentHash: file.contentHash,
      modelId: modelIdOf(file.contentHash),
    };
    reloadButton.disabled = false;
    exactValues = new ExactValues();
    exactError = undefined;
    lastLoadMs = ms;
    selection.clear(); // ids belong to the old model
    strokeRecord = undefined;
    paint = new PaintLayer(model.triangleFace.length, model);
    viewport.setPaint(paint);
    markers.reset(); // markers belong to the old model's annotations
    comments.reset();
    commentsPanel.reset();
    sessionModels.delete(shownFile.modelId); // re-added last: latest first in `otherSessionModels`
    sessionModels.set(shownFile.modelId, {
      model: { modelId: shownFile.modelId, name: file.name, path: file.path },
      bodyNames: model.bodyNames,
    });
    // After the reset: the cancel redraws "Send to AI", which must not count the old comments.
    // Opening another model of the request (T7.4) keeps it.
    if (reviews.open() && !reviews.covers(shownFile.modelId))
      reviews.cancel(`Another model was opened (${file.name})`);
    bodyFolders.reset(stepTreeOf(model)); // the sidecar may add user folders
    pendingCommentSelection = [];
    previousVersion = undefined;
    revisionInfo = undefined;
    versionHint = undefined;
    endCompare();
    compareDiff = undefined; // lets the older meshes go
    compareFile = undefined;
    bodyVisible = [];
    const carried = await loadAnnotations(file, model, paint, { before, revisionOf, askVersion });
    if (ticket !== loadTicket) return; // a newer model took over meanwhile
    // Written before the load finishes, so reopening the earlier file at once sees the line.
    if (linkedEarlier) await tellEarlierVersion(linkedEarlier, file, model);
    if (unlinkedParent) await dropSignpost(unlinkedParent, file);
    if (ticket !== loadTicket) return;
    annotationsReady = true;
    renderSendToAi(); // open-comment count of the loaded annotations
    history.clear(); // steps belong to the old model
    const { path, name, contentHash } = file; // not `file`: keep its bytes collectable
    autosave.setTarget({
      modelPath: path,
      build: () => sidecarText(name, contentHash, model),
    });
    // Carried over from the previous version: save now, with this file's hash (T8.1). A new
    // version-chain link too (T8.6).
    if (carried || chainChanged) autosave.changed();
    viewport.showModel(model);
    applyMeshMode(model);
    renderInfo(); // mesh files show their own hint (T9.1)
    applyGhosts(); // after showModel: it clears the old model's overlays
    renderVersionsButton();
    queuePins();
    bodyList.setModel(model);
    const buildMs = performance.now() - tBuild;
    modelStatus = [
      file.name,
      ...(model.meshFormat ? [`${model.meshFormat.toUpperCase()} mesh`] : []),
      `${count.format(model.bodyCount)} bodies`,
      ...(model.meshFormat ? [] : [`${count.format(model.faceBody.length)} faces`]),
      `${count.format(model.triangleFace.length)} triangles`,
      `${(ms / 1000).toFixed(1)} s`,
    ].join(' · ');
    console.info('Model loaded', file.path, Math.round(ms), 'ms', model.stats);
    progressBox.hidden = true;
    renderStatus();
    await viewport.afterNextFrame();
    if (ticket === loadTicket) loadFinished = true;
    await perfProbe.modelShown({
      file: file.name,
      bodies: model.bodyCount,
      triangles: model.triangleFace.length,
      importMs: Math.round(ms),
      buildMs: Math.round(buildMs),
      firstPictureMs: Math.round(performance.now() - t0),
      stages: model.stats.timings,
    });
    return;
  } catch (err) {
    modelStatus = `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(modelStatus);
    perfProbe.loadFailed(file.name, modelStatus, performance.now() - t0);
  }
  emptyView.hidden = shownModel !== undefined; // a failed first open shows the start view again
  progressBox.hidden = true;
  renderStatus();
}

// --- Mesh-only mode (T9.1) -------------------------------------------------------
const meshBanner = byId('mesh-banner');
byId('mesh-banner-close').addEventListener('click', () => {
  meshBanner.hidden = true;
});
/** STL / 3MF: banner on, selection filter off (paint, smart fill and comments work as usual). */
function applyMeshMode(model: StepModel): void {
  const format = model.meshFormat;
  meshBanner.hidden = format === undefined;
  markersPanel.setMeshOnly(format !== undefined);
  byId('mesh-banner-text').textContent = format
    ? `Mesh file (${format.toUpperCase()}): brush, smart fill and comments only. ` +
      'Entity selection needs STEP: export one from your CAD to pick faces, edges and corners.'
    : '';
  for (const btn of filterButtons.values()) {
    btn.disabled = format !== undefined;
    if (format) btn.title = 'Entity selection needs STEP (this is a mesh file)';
  }
  if (!format) applyFilterButtons();
}

/** Mesh hash per model (T8.1), worked out once; written to the sidecar, compared on revisions. */
const meshHashes = new WeakMap<StepModel, string>();
async function meshHashOf(model: StepModel): Promise<string> {
  let h = meshHashes.get(model);
  if (!h) {
    h = await meshHash(model);
    meshHashes.set(model, h);
  }
  return h;
}

/** Error text without Electron's "Error invoking remote method …" prefix. */
function ipcErrorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}

/**
 * Annotations from the sidecar next to the model (T5.1). One that can't be read is renamed to a
 * backup and the model starts empty. T8.1: one made for another version of this file, or
 * the sidecar of the model named by `revisionOf`, is the previous version's: carried over when the
 * geometry is the same (returns true: save now), else kept in `previousVersion` for T8.2 (an own
 * sidecar is then backed up, as before).
 */
async function loadAnnotations(
  file: ModelFile,
  model: StepModel,
  layer: PaintLayer,
  from: {
    readonly before:
      { path: string; name: string; contentHash: string; model: StepModel } | undefined;
    readonly revisionOf: { readonly path: string; readonly name: string } | undefined;
    readonly askVersion: boolean;
  },
): Promise<boolean> {
  const name = sidecarFileName(file.name);
  backupBeforeWrite = undefined;
  versionChain = undefined;
  linkedEarlier = undefined;
  chainChanged = false;
  unlinkedParent = undefined;
  chainWarning = undefined;
  await meshHashOf(model); // for the sidecar (sync `build`) and the revision check
  // Read now, after the previous model's last save (`flushSync`): reopening the same file must
  // see what was just written, not a copy read when the import started.
  let text: string | null;
  try {
    text = (await window.thirdWheel?.readSidecar(file.path)) ?? null;
  } catch (err) {
    const why = ipcErrorText(err);
    // Keep it safe from the first auto-save: it may still be fine (e.g. only too big to read here).
    let backup: string | null = null;
    try {
      backup = (await window.thirdWheel?.backupSidecar(file.path)) ?? null;
    } catch (e) {
      console.error('Could not back up the sidecar', e);
    }
    showAlert(
      'Annotations not loaded',
      backup
        ? `Could not read ${name} (${why}). It was moved to ${backup}; the model starts without annotations.`
        : `Could not read ${name} (${why}). The model starts without annotations; changes you make will try to replace it.`,
    );
    return false;
  }
  if (model.meshFormat) {
    // T9.1: a mesh's own notes or none; notes don't move between mesh versions (yet).
    if (text === null) return false;
    const check = checkSidecar(text, file.contentHash, model);
    if (check.ok) {
      applyAnnotations(check.doc, check.droppedFields, name, model, layer, file.path);
      versionChain = check.doc.versions;
      // T9.2: its notes were brought onto a STEP.
      const newest = await newestConfirmed(file, check.doc.versions);
      if (newest) showNotice(`There's a newer version: ${newest.name}. Open it from Versions ▾.`);
      return false;
    }
    await backupUnusable(
      file.path,
      name,
      check.reason === 'other-version'
        ? 'the mesh file changed since; notes move to a new version only for STEP files'
        : check.detail,
    );
    return false;
  }
  let previous: PreviousAnnotations | undefined;
  let detail = '';
  /** This file has a sidecar for an older version of itself. */
  let ownStale = false;
  /** That sidecar's version chain. */
  let ownChain: VersionChain | undefined;
  /** T13.5: the "Which file is … a newer version of?" question was already answered. */
  let parentAsked = false;
  /** T15.2: this file's own notes (for these contents) are replaced by the earlier file's. */
  let ownReplaced = false;
  if (text !== null) {
    const check = checkSidecar(text, file.contentHash, model);
    const earlier =
      check.ok && from.revisionOf && from.revisionOf.path !== file.path
        ? from.revisionOf
        : undefined;
    let replaceOwn = false;
    let keptOwn: string | undefined;
    let prev: PreviousAnnotations | undefined;
    if (check.ok && earlier) {
      // T13.5 order: which earlier version first; "keep" = a plain open, nothing of `earlier`.
      const answer = from.askVersion
        ? await askOwnParent(earlier, check.doc.versions, file, from.before)
        : 'not-asked';
      parentAsked = answer !== 'not-asked';
      prev = answer === 'kept' ? undefined : await readPreviousSidecar(earlier, true);
      // T15.2: an empty notes file counts as none; notes of its own are kept unless the user
      // picks Replace (the AI is never asked: 'own').
      if (prev && hasNotes(prev.doc)) {
        if (!hasNotes(check.doc)) replaceOwn = true;
        else if (from.askVersion) {
          const q = ownNotesQuestion(file.name, check.doc, prev);
          replaceOwn = (await askChoice(q.title, q.text, q.keep, q.replace)) === 'second';
          if (!replaceOwn) keptOwn = keptOwnText(file.name, prev.name);
          else ownReplaced = true;
        }
      }
      if (answer === 'kept') {
        applyAnnotations(check.doc, check.droppedFields, name, model, layer, file.path);
        versionChain = check.doc.versions;
        return false;
      }
    }
    if (check.ok && replaceOwn) {
      ownChain = check.doc.versions;
      previous = prev; // read above: the earlier file's notes go onto this one
    } else if (check.ok) {
      applyAnnotations(check.doc, check.droppedFields, name, model, layer, file.path);
      versionChain = check.doc.versions;
      if (from.revisionOf) {
        previousVersion = { ...from.revisionOf, carried: false };
        revisionInfo = revisionResult(from.revisionOf, 'own');
        if (earlier) {
          // T8.6: Import / `revisionOf` links the files even when this one has notes of its own.
          const linked = await linkEarlier(earlier, prev?.doc, check.doc.versions, from.before, {
            file,
            ask: from.askVersion,
            asked: parentAsked,
          });
          if (linked === 'kept') {
            // T13.5: the user kept its earlier version: a plain open, nothing of the named file.
            previousVersion = undefined;
            revisionInfo = undefined;
          } else if (keptOwn) showNotice(keptOwn);
        }
      } else {
        const newest = await newestConfirmed(file, check.doc.versions);
        if (newest) showNotice(`There's a newer version: ${newest.name}. Open it from Versions ▾.`);
      }
      return false;
    } else if (check.reason === 'other-version') {
      ownChain = check.doc.versions;
      previous = { ...check, path: file.path, name: file.name, own: true };
      detail = check.detail;
      ownStale = true;
    } else {
      await backupUnusable(file.path, name, check.detail);
      if (!from.revisionOf) return false;
    }
  }
  const replaced = from.before?.path === file.path && from.before.contentHash !== file.contentHash;
  let named = from.revisionOf;
  if (text === null && !named && !replaced) {
    // T8.4: a new file name. The user is asked about a likely earlier version; the AI gets a hint.
    if (from.askVersion) {
      const earlier = await askEarlierVersion(file, model);
      if (earlier) {
        previous = earlier;
        named = { path: earlier.path, name: earlier.name };
      }
    } else {
      const named = await sessionEarlierVersion(file, model);
      const mesh = named ? undefined : await sameSizeMesh(file, model);
      versionHint = named ?? (mesh ? { modelId: mesh.modelId, name: mesh.name } : undefined);
    }
  } else if (named && named.path !== file.path) {
    // T13.5: this file's notes (for older contents of it) name another earlier version: ask
    // first. "Keep" = a plain open of the file (its own notes moved, T8.1), nothing of `named`.
    const answer =
      ownStale && from.askVersion
        ? await askOwnParent(named, ownChain, file, from.before)
        : 'not-asked';
    if (answer !== 'not-asked') parentAsked = true;
    if (answer === 'kept') named = undefined;
    else {
      // The AI named the previous version: its sidecar wins over a stale one of this file.
      const fromNamed = previous?.own === false ? previous : await readPreviousSidecar(named);
      if (fromNamed) previous = fromNamed;
    }
  }
  // This file's own sidecar for an older version of it, not used (or replaced by the user,
  // T15.2): back it up before any save.
  let ownBackup: string | null = null;
  if ((ownStale || ownReplaced) && previous?.own === false) {
    try {
      ownBackup = (await window.thirdWheel?.backupSidecar(file.path)) ?? null;
    } catch (err) {
      console.error('Could not back up the sidecar', err);
    }
    // Couldn't be renamed: the first save keeps a backup copy of it.
    if (ownReplaced && ownBackup === null) backupBeforeWrite = file.path;
  }
  const prevPath = previous?.path ?? named?.path ?? (replaced ? file.path : undefined);
  if (prevPath === undefined) return false; // no revision: a plain first load
  const prevName = previous?.name ?? named?.name ?? file.name;
  const prevModel = from.before?.path === prevPath ? from.before.model : undefined;
  // T8.6: the version chain. Another file named (Import, Bring my notes over, `revisionOf`) =
  // linked; the same file with new contents = its old contents recorded as overwritten.
  if (named && named.path !== file.path) {
    const base = previous && !previous.own ? previous.doc : undefined;
    await linkEarlier(named, base, ownChain, from.before, {
      file,
      ask: from.askVersion,
      asked: parentAsked,
    });
  } else {
    const oldHash = replaced ? from.before.contentHash : previous?.doc.model.contentHash;
    if (oldHash) {
      chainChanged = true;
      versionChain = chainAfter(previous?.doc.versions, {
        path: file.path,
        name: prevName,
        contentHash: oldHash,
        date: new Date().toISOString(),
        overwritten: true,
      });
    }
  }
  if (!previous) {
    previousVersion = {
      path: prevPath,
      name: prevName,
      carried: false,
      ...(prevModel ? { model: prevModel } : {}),
    };
    revisionInfo = revisionResult({ path: prevPath, name: prevName }, 'none');
    return false;
  }
  return useRevision(previous, file, model, layer, {
    prevPath,
    prevName,
    prevModel,
    before: from.before,
    detail,
    ownBackup,
  });
}

/**
 * The previous version's annotations onto the new model (T8.1 / T8.2): carried over as they are
 * when the geometry is the same, else moved by matching geometry (`transferAnnotations`). An own
 * sidecar is backed up first whenever anything had to be moved. True = save now.
 */
async function useRevision(
  previous: PreviousAnnotations,
  file: ModelFile,
  model: StepModel,
  layer: PaintLayer,
  at: {
    readonly prevPath: string;
    readonly prevName: string;
    readonly prevModel: StepModel | undefined;
    readonly before: { contentHash: string; model: StepModel } | undefined;
    readonly detail: string;
    readonly ownBackup: string | null;
  },
): Promise<boolean> {
  const { prevPath, prevName, prevModel, detail, ownBackup } = at;
  const name = sidecarFileName(file.name);
  const newHash = await meshHashOf(model);
  // Sidecars from before T8.1 have no mesh hash: the previous model, if it is still in memory and
  // the sidecar was made for it, gives one.
  const oldHash =
    prevModel && previous.doc.model.contentHash === at.before?.contentHash
      ? await meshHashOf(prevModel)
      : undefined;
  const same = sameGeometry(previous.doc, newHash, model.tessellation, oldHash);
  previousVersion = {
    path: prevPath,
    name: prevName,
    doc: previous.doc,
    carried: same,
    ...(prevModel ? { model: prevModel } : {}),
  };
  revisionInfo = revisionResult(previous, same ? 'carried' : 'waiting', previous.doc);
  if (same) {
    // Nothing is lost (only the file's hash changes), so no backup copy: the notice says what
    // happened instead of a "backup kept" one (fields this app doesn't know still get one).
    applyAnnotations(previous.doc, previous.droppedFields, name, model, layer, file.path);
    showNotice(carriedText(previous, file.name, ownBackup));
    return true;
  }
  let backup = ownBackup;
  if (previous.own) {
    try {
      backup = (await window.thirdWheel?.backupSidecar(file.path)) ?? null;
    } catch (err) {
      console.error('Could not back up the sidecar', err);
    }
  }
  // The own old sidecar couldn't be renamed: the first save keeps a backup copy of it.
  if (previous.own && backup === null) backupBeforeWrite = file.path;
  // T9.2: notes of a mesh file (STL / 3MF) go onto the STEP after lining the files up; the
  // mesh's own triangles help (read again when it's no longer in memory).
  const fromMesh = previous.doc.model.format !== 'step';
  const mesh = fromMesh ? await meshOfPrevious(prevPath, prevModel) : undefined;
  // T8.2: move them onto the new geometry. Every marker and comment comes over (lost ones with
  // their old place); a failure leaves the model empty and the annotations where they were.
  try {
    const t0 = performance.now();
    let coverage: MeshCoverage | undefined;
    let moved: TransferResult;
    if (fromMesh) {
      const r = transferMeshAnnotations(previous.doc, model, mesh);
      coverage = r.coverage;
      moved = r;
    } else moved = transferAnnotations(previous.doc, model);
    const sum: TransferSummary = {
      ...transferSummary(previous.doc, moved.status),
      ...(coverage ? { fromMesh: coverage } : {}),
    };
    console.info(
      `Revision: annotations moved in ${(performance.now() - t0).toFixed(0)} ms`,
      sum.flagged,
      coverage ?? '',
    );
    applyAnnotations(moved.annotations, previous.droppedFields, name, model, layer, file.path);
    revisionInfo = revisionResult(previous, 'moved', previous.doc, sum);
    showNotice(
      coverage
        ? meshMovedText(previous, file.name, sum, coverage, backup)
        : movedText(previous, file.name, sum, backup),
    );
    return true;
  } catch (err) {
    console.error('Revision: moving the annotations failed', err);
    // Nothing half-loaded: the model starts empty, as the pop-up says.
    markers.reset();
    comments.reset();
    commentsPanel.reset();
    bodyFolders.reset(stepTreeOf(model));
    paint = new PaintLayer(model.triangleFace.length, model);
    viewport.setPaint(paint);
  }
  revisionInfo = revisionResult(previous, 'waiting', previous.doc);
  showAlert('New version of the model', waitingText(previous, file.name, detail, backup));
  console.warn('Revision: annotations kept, not moved', previous.path, detail);
  return false;
}

/** Reads mesh files again for T9.2 (not kept: only their triangles are needed, once). */
const meshLoader = new ModelLoader();

/**
 * T9.2: the mesh whose notes go onto a STEP — in memory when it was the shown model, else read
 * again (files opened this session can be). Undefined: gone or unreadable (the notes alone are
 * then lined up, from their paint points and body boxes).
 */
async function meshOfPrevious(
  path: string,
  inMemory: StepModel | undefined,
): Promise<StepModel | undefined> {
  if (inMemory?.meshFormat) return inMemory;
  const api = window.thirdWheel;
  if (!api) return undefined;
  try {
    const file = await api.rereadModelFile(path);
    if (!meshFormatOf(file.name)) return undefined;
    return (await meshLoader.load(file, () => undefined))?.model;
  } catch (err) {
    console.warn('T9.2: could not read the mesh again; lining up from its notes only', err);
    return undefined;
  } finally {
    meshLoader.release();
  }
}

/**
 * T9.2: a mesh file of this session (latest first) with notes whose parts have the same overall
 * size as `model` — likely the same part, exported as STL / 3MF before the STEP existed. File
 * names usually differ, so T8.4's name rules can't tell.
 */
async function sameSizeMesh(
  file: ModelFile,
  model: StepModel,
): Promise<(PreviousAnnotations & { readonly modelId: string }) | undefined> {
  if (model.meshFormat || separateParts.has(file.path)) return undefined;
  const mine = fingerprintsOf(model).bodies;
  for (const [modelId, { model: m }] of [...sessionModels].reverse()) {
    if (m.path === file.path || !meshFormatOf(m.name)) continue;
    const prev = await readPreviousSidecar(m, true);
    if (!prev || prev.doc.markers.length + prev.doc.comments.length === 0) continue;
    if (prev.doc.versions?.unlinked) continue; // T13.4: removed from its chain by the user
    if (prev.doc.bodies && sameOverallSize(prev.doc.bodies, mine)) return { ...prev, modelId };
  }
  return undefined;
}

/** The earlier version a file is linked to (T8.6); `contentHash` when known without reading. */
interface EarlierFile {
  readonly path: string;
  readonly name: string;
  readonly contentHash: string;
  /** Its tessellation, for a notes file made for it (it had none). */
  readonly tessellation: StepModel['tessellation'] | undefined;
}

/**
 * T8.6: link the file being loaded to `earlier` — its chain becomes `earlier` + what `earlier`
 * came from (`base`), and `linkedEarlier` is set so `earlier`'s notes get a "newer version" line.
 * No link when `earlier`'s contents can't be told (gone). T13.4 (one parent, no circles): when the
 * file's own notes (`own`) name another earlier version, the user picks (`ask`) or, for the AI, the
 * new link wins and `chainWarning` says so; a file that is already one of `earlier`'s own earlier
 * versions is not linked (a circle).
 */
async function linkEarlier(
  earlier: { readonly path: string; readonly name: string },
  base: Annotations | undefined,
  own: VersionChain | undefined,
  before: { path: string; contentHash: string; model: StepModel } | undefined,
  opts: { readonly file: ModelFile; readonly ask: boolean; readonly asked?: boolean },
): Promise<'linked' | 'kept' | 'none'> {
  const { file } = opts;
  const shown = before?.path === earlier.path ? before : undefined;
  const contentHash = (await contentsOf(earlier, before)) ?? base?.model.contentHash;
  if (!contentHash) {
    versionChain = own;
    return 'none';
  }
  const link: VersionLink = {
    path: earlier.path,
    name: earlier.name,
    contentHash,
    date: new Date().toISOString(),
  };
  const self = { path: file.path, contentHash: file.contentHash };
  const line = [link, ...(await walkEarlier(base?.versions?.earlier, readChainOf, link))];
  if (makesCircle(self, line)) {
    versionChain = own;
    chainWarning = `${file.name} is an earlier version of ${earlier.name}, so it was not linked as a newer one (that would make a circle).`;
    console.warn('T13.4: link refused (circle)', file.path, earlier.path);
    return 'none';
  }
  const ownParent = await otherOwnParent(own, link);
  if (ownParent) {
    if (opts.ask && !opts.asked) {
      if (await askKeepParent(file, earlier, ownParent)) {
        versionChain = own;
        return 'kept';
      }
    } else if (!opts.ask)
      chainWarning = `${file.name} was linked as a newer version of ${ownParent.name}; it is now a newer version of ${earlier.name} instead.`;
    unlinkedParent = ownParent;
  }
  chainChanged = true;
  versionChain = chainAfter(base?.versions, link, own, self);
  linkedEarlier = {
    ...earlier,
    contentHash,
    tessellation: shown?.model.tessellation ?? base?.tessellation,
  };
  return 'linked';
}

/** The contents (hash) of `file`: the shown model from memory, else read on disk; undefined = gone. */
async function contentsOf(
  file: { readonly path: string },
  before: { path: string; contentHash: string } | undefined,
): Promise<string | undefined> {
  if (before?.path === file.path) return before.contentHash;
  try {
    const [state] = (await window.thirdWheel?.versionFileStates([file.path])) ?? [];
    return state?.contentHash ?? undefined;
  } catch (err) {
    console.warn('Could not check the earlier version', err);
    return undefined;
  }
}

/** T13.4: the file's own earlier version when it is another one than `link` (a removed one,
 * marked in its notes, no longer counts). */
async function otherOwnParent(
  own: VersionChain | undefined,
  link: VersionKey,
): Promise<VersionLink | undefined> {
  const ownParent = own?.earlier?.[0];
  if (!ownParent || sameVersion(ownParent, link)) return undefined;
  const parentNotes = ownParent.overwritten ? undefined : await readChainOf(ownParent);
  return parentNotes?.chain?.unlinked ? undefined : ownParent;
}

/** T13.4: "Which file is X a newer version of?" — true = keep its own earlier version. */
async function askKeepParent(
  file: ModelFile,
  earlier: { readonly name: string },
  ownParent: VersionLink,
): Promise<boolean> {
  const answer = await askChoice(
    `Which file is ${file.name} a newer version of?`,
    `${file.name} is already linked as a newer version of ${ownParent.name}. A file has one earlier version, so pick the right one. Both files keep their notes; only the link moves.`,
    earlier.name,
    `${ownParent.name} (keep)`,
  );
  return answer !== 'first';
}

/**
 * T13.5: Import onto a file whose notes are for older contents of it: ask before anything of
 * `earlier` is read. 'kept' = the user keeps the file's own earlier version, 'moved' = `earlier`
 * becomes it; no question ('not-asked') when there is no other one or `earlier`'s contents can't
 * be told (`linkEarlier` then decides as usual).
 */
async function askOwnParent(
  earlier: { readonly path: string; readonly name: string },
  own: VersionChain | undefined,
  file: ModelFile,
  before: { path: string; contentHash: string } | undefined,
): Promise<'kept' | 'moved' | 'not-asked'> {
  const contentHash = await contentsOf(earlier, before);
  if (!contentHash) return 'not-asked';
  const ownParent = await otherOwnParent(own, { path: earlier.path, contentHash });
  if (!ownParent) return 'not-asked';
  if (await askKeepParent(file, earlier, ownParent)) return 'kept';
  unlinkedParent = ownParent;
  return 'moved';
}

/** T13.4: take the shown file's old "newer version" signpost out of `parent`'s notes (best effort:
 * a signpost left behind is ignored, the newer file's parent decides). */
async function dropSignpost(parent: VersionLink, file: ModelFile): Promise<void> {
  if (parent.overwritten) return;
  try {
    await window.thirdWheel?.editVersionLinks(parent.path, parent.contentHash, {
      drop: [{ path: file.path, contentHash: file.contentHash }],
    });
  } catch (err) {
    console.warn(`Could not take ${file.name} out of the versions of ${parent.name}`, err);
  }
}

/**
 * T13.4: the version chain in the notes of `link`'s contents, for walks: undefined when they can't
 * be read (file gone or changed, no notes, notes of other contents, unreadable). The shown file
 * answers from memory (its latest chain may not be saved yet).
 */
async function readChainOf(link: VersionKey): Promise<ChainRead> {
  const api = window.thirdWheel;
  if (shownFile && sameVersion(link, shownFile)) return { chain: versionChain };
  if (!api) return undefined;
  try {
    const [state] = await api.versionFileStates([link.path]);
    if (state?.contentHash !== link.contentHash) return undefined;
    const text = await api.readSidecar(link.path);
    if (text === null) return undefined;
    const doc = JSON.parse(text) as { model?: { contentHash?: unknown }; versions?: unknown };
    if (doc.model?.contentHash !== link.contentHash) return undefined;
    const chain = versionChainSchema.safeParse(doc.versions);
    return { chain: chain.success ? chain.data : undefined };
  } catch {
    return undefined; // unreadable notes: the walk goes on with what it knows
  }
}

/**
 * T13.4: the newest "newer version" signpost that still holds — that file names `self` as its
 * earlier version, or its notes can't be read (benefit of the doubt, as before).
 */
async function newestConfirmed(
  self: VersionKey,
  chain: VersionChain | undefined,
): Promise<VersionLink | undefined> {
  for (const l of chain?.newer ?? []) {
    const got = await readChainOf(l);
    if (!got || confirmsParent(got.chain, { ...self, chain })) return l;
  }
  return undefined;
}

/**
 * T8.6: add the shown file as the newest "newer version" to the notes of the
 * earlier version it was linked to — only that field; a file without notes gets a notes file with
 * no markers, so opening it later can say "There's a newer version".
 */
async function tellEarlierVersion(
  earlier: EarlierFile,
  file: ModelFile,
  model: StepModel,
): Promise<void> {
  // T15.1: the earlier file's own format (an STL earlier version gets `stl` notes).
  const emptyNotes = formatJson(emptyNotesFor(earlier, earlier.tessellation ?? model.tessellation));
  const link: VersionLink = {
    path: file.path,
    name: file.name,
    contentHash: file.contentHash,
    date: new Date().toISOString(),
  };
  try {
    await window.thirdWheel?.addNewerVersion(earlier.path, link, emptyNotes);
  } catch (err) {
    console.warn(`Could not note the newer version in ${earlier.name}`, err);
  }
}

/** An unreadable sidecar: renamed to a backup, pop-up, the model starts empty. */
async function backupUnusable(modelPath: string, name: string, detail: string): Promise<void> {
  let backup: string | null = null;
  try {
    backup = (await window.thirdWheel?.backupSidecar(modelPath)) ?? null;
  } catch (err) {
    console.error('Could not back up the sidecar', err);
  }
  const kept = backup
    ? `They were moved to ${backup}; the model starts without annotations.`
    : `It was left as it is; changes you make now will replace it.`;
  showAlert('Annotations not loaded', `Could not read ${name} (${detail}). ${kept}`);
  console.warn('Sidecar not used:', detail);
}

/** The sidecar of the model the AI named as the previous version (`revisionOf`), if usable. */
async function readPreviousSidecar(
  prev: { readonly path: string; readonly name: string },
  quiet = false,
): Promise<PreviousAnnotations | undefined> {
  let text: string | null;
  try {
    text = (await window.thirdWheel?.readSidecar(prev.path)) ?? null;
  } catch (err) {
    if (!quiet) showNotice(`Couldn't read the annotations of ${prev.name}: ${ipcErrorText(err)}`);
    return undefined;
  }
  if (text === null) return undefined;
  const parsed = parseAnnotationsJson(text);
  if (!parsed.ok) {
    if (!quiet)
      showNotice(
        `Couldn't read the annotations of ${prev.name} (${parsed.errors[0] ?? 'unknown'}).`,
      );
    return undefined;
  }
  return { doc: parsed.data, droppedFields: parsed.droppedFields, ...prev, own: false };
}

/** Files the user said are separate parts, not new versions (T8.4): not asked again this session. */
const separateParts = new Set<string>();

/** Models of this session (and files in the folder) that may be earlier versions of `file`. */
function versionCandidates(
  file: ModelFile,
  folder: readonly ModelVersionFile[],
): VersionCandidate[] {
  const byPath = new Map<string, VersionCandidate>();
  let order = 0;
  for (const { model, bodyNames } of sessionModels.values()) {
    order++;
    if (model.path === file.path || !bodyNames) continue;
    // T9.1: notes don't move between mesh and STEP files (yet: T9.2).
    if (meshFormatOf(model.name) || meshFormatOf(file.name)) continue;
    byPath.set(model.path, { path: model.path, name: model.name, session: { bodyNames, order } });
  }
  for (const f of folder) byPath.set(f.path, { ...byPath.get(f.path), ...f });
  return [...byPath.values()];
}

/**
 * T8.4: the user opened a file without notes. When it looks like a newer version of a file with
 * notes (versioned name in its folder or this session, or same body names), ask whether to bring
 * them over. The answer's annotations, or undefined (nothing fits, or "Separate part").
 */
async function askEarlierVersion(
  file: ModelFile,
  model: StepModel,
): Promise<PreviousAnnotations | undefined> {
  const api = window.thirdWheel;
  if (!api || separateParts.has(file.path)) return undefined;
  let folder: ModelVersionFile[] = [];
  try {
    folder = await api.listModelVersions(file.path);
  } catch (err) {
    console.warn('Could not look for other versions', err);
  }
  const found = earlierVersions(
    { path: file.path, name: file.name, bodyNames: model.bodyNames },
    versionCandidates(file, folder),
  );
  // Folder files without a sidecar have nothing to bring over.
  for (const c of found.filter((f) => f.session || f.sidecarMtimeMs !== undefined).slice(0, 5)) {
    const prev = await readPreviousSidecar(c, true);
    if (!prev || prev.doc.markers.length + prev.doc.comments.length === 0) continue;
    if (prev.doc.versions?.unlinked) continue; // T13.4: removed from its chain by the user
    const answer = await askVersionQuestion(file.name, prev);
    if (answer === 'separate') separateParts.add(file.path);
    return answer === 'bring' ? prev : undefined;
  }
  // T9.2: a mesh with notes opened this session, same size.
  const mesh = await sameSizeMesh(file, model);
  if (mesh) {
    const answer = await askVersionQuestion(file.name, mesh, meshQuestion(file.name, mesh));
    if (answer === 'separate') separateParts.add(file.path);
    return answer === 'bring' ? mesh : undefined;
  }
  return undefined;
}

/**
 * T8.4, AI load without `revisionOf`: the model of this session it looks like a newer copy of —
 * not one the user removed from its version chain (T13.4).
 */
async function sessionEarlierVersion(
  file: ModelFile,
  model: StepModel,
): Promise<{ modelId: string; name: string } | undefined> {
  const found = earlierVersions(
    { path: file.path, name: file.name, bodyNames: model.bodyNames },
    versionCandidates(file, []),
  );
  for (const best of found.slice(0, 5)) {
    const prev = await readPreviousSidecar(best, true);
    if (prev?.doc.versions?.unlinked) continue;
    for (const [modelId, { model: m }] of sessionModels)
      if (m.path === best.path) return { modelId, name: m.name };
  }
  return undefined;
}

// The question "Is this a new version of …?" (T8.4). Like Google Drive's "Replace / Keep both".
const versionDialog = byId('version-dialog') as HTMLDialogElement;
versionDialog.addEventListener('keydown', (e) => {
  e.stopPropagation(); // tool shortcuts must not fire behind it
});
/** Ask; Esc or another load closing it = neither (asked again next time). */
function askVersionQuestion(
  name: string,
  prev: PreviousAnnotations,
  words?: { readonly title: string; readonly text: string },
): Promise<'bring' | 'separate' | 'none'> {
  byId('version-title').textContent = words?.title ?? `Is ${name} a new version of ${prev.name}?`;
  byId('version-text').textContent = words?.text ?? versionQuestionText(name, prev);
  versionDialog.returnValue = '';
  versionDialog.showModal();
  return new Promise((done) => {
    versionDialog.addEventListener(
      'close',
      () => {
        const v = versionDialog.returnValue;
        done(v === 'bring' || v === 'separate' ? v : 'none');
      },
      { once: true },
    );
  });
}
function closeVersionQuestion(): void {
  if (versionDialog.open) versionDialog.close('');
}

/** A checked sidecar document into the app state; reports what didn't fit. */
function applyAnnotations(
  doc: Annotations,
  droppedFields: readonly string[],
  name: string,
  model: StepModel,
  layer: PaintLayer,
  modelPath: string,
): void {
  const loaded = fromAnnotations(doc, model);
  markers.load(loaded.markers);
  applyPaint(layer, loaded.paint);
  comments.load(loaded.comments);
  const droppedRows = bodyFolders.load(doc.bodyTree);
  viewport.paintChanged();
  if (droppedFields.length > 0 || loaded.dropped + droppedRows > 0) {
    backupBeforeWrite = modelPath;
  }
  if (droppedFields.length > 0) {
    showAlert('Some annotation data will be removed', droppedFieldsText(name, droppedFields));
  }
  if (loaded.dropped + droppedRows > 0) {
    const n = count.format(loaded.dropped + droppedRows);
    showNotice(
      `Annotations loaded from ${name}, but ${n} painted triangles or items didn't fit the model and were left out. Your next change keeps a backup copy of the file first.`,
    );
  }
}

/** Body fingerprints per model (one mesh pass; the model never changes once loaded). */
const bodyPrints = new WeakMap<StepModel, BodyFingerprint[]>();
function fingerprintsOf(model: StepModel): NonNullable<SidecarInput['fingerprints']> {
  let bodies = bodyPrints.get(model);
  if (!bodies) {
    bodies = bodyFingerprints(model, model.bodyCount);
    bodyPrints.set(model, bodies);
  }
  return { bodies, entities: (refs) => entityFingerprints(model, refs, bodies) };
}

/** The shown model's annotations as sidecar JSON. */
function sidecarText(fileName: string, contentHash: string, model: StepModel): string {
  if (!paint) throw new Error('No paint layer');
  return formatJson(
    toAnnotations({
      fileName,
      contentHash,
      meshHash: meshHashes.get(model),
      model,
      markers: markers.list(),
      comments: comments.list(),
      paint,
      bodyTree: bodyFolders.data(),
      fingerprints: fingerprintsOf(model),
      versions: versionChain,
    }),
  );
}

// --- Save indicator in the status bar (T5.1) ---------------------------
// Like Google Docs / Figma: "Saving…" → "Saved"; hidden until the first change of a model.
const saveStatus = byId('save-status');
let saveFile = ''; // sidecar file name of the shown model
let lastSave: { at: Date; error: string | undefined } | undefined;
const saveStatusLabel = byId('save-status-label');
function renderSaveStatus(state: SaveState | 'hidden'): void {
  saveStatus.hidden = state === 'hidden';
  if (state === 'hidden') return;
  // Same dot + label look as the AI status (T7.6): grey Saved, amber Saving…, red Not saved.
  const view = saveStatusView(state);
  saveStatus.dataset['dot'] = view.dot;
  saveStatusLabel.textContent = view.label;
  if (state === 'pending' || state === 'saving')
    saveStatus.title = `Annotations are saved to ${saveFile} next to the model`;
  else if (state === 'saved')
    saveStatus.title = `Annotations saved to ${saveFile} at ${lastSave?.at.toLocaleTimeString() ?? ''}`;
  else
    saveStatus.title = `Could not save ${saveFile}: ${lastSave?.error ?? ''}. Trying again with the next change.`;
}

// --- AI status + "Connect an AI agent" pop-up (T7.6) ------------------------------------
const aiConnect = setupAiConnect();
setupAbout();
byId('empty-connect').addEventListener('click', () => {
  aiConnect.open();
});

// --- App menu items the window carries out (T13.2) -------------------------------------------
// Same code as the buttons and keys. Undo / Redo: the app's history, or typing in a text field.
window.thirdWheel?.onMenuCommand((command) => {
  const now = performance.now();
  // Behind an open pop-up the keys don't reach the app either (dialogs stop them).
  const modalOpen = document.querySelector('dialog[open]') !== null;
  if (modalOpen && command !== 'shortcuts' && command !== 'connect') {
    if ((command === 'undo' || command === 'redo') && isTextField(document.activeElement)) {
      window.thirdWheel?.textUndoRedo(command);
    }
    return;
  }
  switch (command) {
    case 'undo':
    case 'redo':
      if (isTextField(document.activeElement)) {
        window.thirdWheel?.textUndoRedo(command);
      } else if (shortcutOnce.take(command, 'menu', now)) {
        undoRedo(command);
      }
      return;
    case 'open':
      if (shortcutOnce.take(command, 'menu', now)) void openModelDialog();
      return;
    case 'import':
      if (shortcutOnce.take(command, 'menu', now)) void importNewVersion();
      return;
    case 'shortcuts':
      setHelpOpen(true);
      return;
    case 'connect':
      aiConnect.open();
      return;
  }
});
// onSaved runs before onState: it keeps the error message the indicator's tooltip shows.
autosave.onSaved = (error) => {
  if (error) {
    lastSave = { at: new Date(), error };
    showNotice(`Could not save the annotations: ${error}. Trying again with the next change.`);
  }
};
autosave.onState = (state) => {
  if (state === 'saved') lastSave = { at: new Date(), error: undefined };
  renderSaveStatus(state);
};
// Cmd/Ctrl+S saves now (habit from CAD tools; auto-save does it anyway).
window.addEventListener('keydown', (e) => {
  if (!isPrimaryShortcut(e, 's', isMac)) return;
  e.preventDefault();
  if (autosave.pending) void autosave.flush();
  else if (lastSave) renderSaveStatus(lastSave.error === undefined ? 'saved' : 'error');
});
// Last changes when the window closes (blocking: the page is going away).
window.addEventListener('beforeunload', () => {
  autosave.flushSync();
});

// --- Notice bar over the view (T5.1): sidecar problems ----------------------------
const notice = byId('notice');
const noticeText = byId('notice-text');
function showNotice(text: string): void {
  noticeText.textContent = text;
  notice.hidden = false;
}
function hideNotice(): void {
  notice.hidden = true;
}
byId('notice-close').addEventListener('click', hideNotice);

// --- Pop-up when annotation data is at risk (T5.2) -----------------------
// Like the slicers' "newer project file" dialog: a backup was made or fields will be dropped.
// Minor things (items that didn't fit) stay in the notice bar.
const alertDialog = byId('alert-dialog') as HTMLDialogElement;
const alertTitle = byId('alert-title');
const alertBody = byId('alert-body');
// Keys stay in the pop-up (tool shortcuts must not fire behind it); Esc / Enter still close it.
alertDialog.addEventListener('keydown', (e) => {
  e.stopPropagation();
});
/** A second message while one is open is added below it (the first title stays). */
function showAlert(title: string, text: string): void {
  if (!alertDialog.open) {
    alertTitle.textContent = title;
    alertBody.replaceChildren();
  }
  const p = document.createElement('p');
  p.textContent = text;
  alertBody.append(p);
  if (!alertDialog.open) alertDialog.showModal();
}

// A question with two answers (T13.4): `first` is the default button, Esc = neither.
const choiceDialog = byId('choice-dialog') as HTMLDialogElement;
choiceDialog.addEventListener('keydown', (e) => {
  e.stopPropagation(); // tool shortcuts must not fire behind it
});
function askChoice(
  title: string,
  text: string,
  first: string,
  second: string,
): Promise<'first' | 'second' | 'none'> {
  if (choiceDialog.open) choiceDialog.close('');
  byId('choice-title').textContent = title;
  byId('choice-text').textContent = text;
  byId('choice-first').textContent = first;
  byId('choice-second').textContent = second;
  choiceDialog.returnValue = '';
  choiceDialog.showModal();
  return new Promise((done) => {
    choiceDialog.addEventListener(
      'close',
      () => {
        const v = choiceDialog.returnValue;
        done(v === 'first' || v === 'second' ? v : 'none');
      },
      { once: true },
    );
  });
}

/** Text for fields this version doesn't know, e.g. from a newer Third Wheel. */
function droppedFieldsText(name: string, paths: readonly string[]): string {
  // `markers.0.tag`, `markers.1.tag` → one entry `markers[].tag`.
  const fields = [...new Set(paths.map((p) => p.replace(/\.\d+(?=\.|$)/g, '[]')))];
  const shown = fields.slice(0, 3).join(', ');
  const more = fields.length > 3 ? ` and ${count.format(fields.length - 3)} more` : '';
  const n = fields.length === 1 ? 'a field' : `${count.format(fields.length)} fields`;
  return `${name} has ${n} this version of Third Wheel doesn't know (${shown}${more}). The file stays as it is until your next change; that save removes them but first keeps a backup copy of the file (….bak.json). If it was saved by a newer Third Wheel, update the app to keep using them.`;
}

async function openModelDialog(): Promise<void> {
  const file = await window.thirdWheel?.openModelDialog(undefined, shownFile?.path);
  if (file) await loadModel(file, undefined, true);
}

openButton.addEventListener('click', () => {
  void openModelDialog();
});
reloadButton.addEventListener('click', () => {
  void reloadFromDisk();
});

// --- Parts library: a panel with the catalogue of ready-made parts (library/library-panel.ts) ----
initLibraryPanel({
  button: byId('library-btn') as HTMLButtonElement,
  panel: byId('library-panel'),
  markers: () => markers.list().map((m) => ({ id: m.id, name: m.name, color: m.color })),
  createRequest: (text, markerIds, parts) => {
    const c = comments.add(text, markerIds, 'human', [], parts);
    return c ? comments.numberOf(c.id) : undefined;
  },
});

// --- Versions menu: import a new version, open or compare others (T8.3 / T8.5) ----------
// Compare = overlay: the other version's changed surface see-through red, the shown one's
// changed parts tinted green. The other version is the previous one still in memory, or a file
// next to the model whose name makes it a version (T8.4), read just for this (no copies
// of model files, so an overwritten version can't be compared after a restart).
const versionsButton = byId('versions-menu') as HTMLButtonElement;
const compareLegend = byId('compare-legend');
/** The version compared with the shown one, and the legend's words for both colours. */
interface CompareTarget {
  readonly name: string;
  readonly model: StepModel;
  readonly oldKey: string;
  readonly newKey: string;
}
let compareDiff: { old: StepModel; now: StepModel; diff: VersionDiff } | undefined;
let comparing: CompareTarget | undefined;
/** A version read from disk only to compare (kept for comparing with it again). */
let compareFile: { path: string; contentHash: string; model: StepModel } | undefined;
/** Its own import worker: the shown model's kernel (exact values) stays untouched. */
const compareLoader = new ModelLoader();
/** Reading the other version or working out the difference (seconds on big models). */
let compareBusy = false;
/** Most version rows in the menu (a folder may hold many exports). */
const MAX_VERSION_ROWS = 30;
/** How far newer versions of newer versions are followed (T8.6). */
const MAX_CHAIN_DEPTH = 10;
/** Most newer versions read for the menu (T13.4 review; main checks at most 200 at once). */
const MAX_NEWER_FILES = 200;
const VERSIONS_TITLE = `Versions: import a new version (${shortcutLabel('i', isMac)}), open or compare other versions`;
versionsButton.title = VERSIONS_TITLE;
function renderVersionsButton(): void {
  // T9.2: a mesh has Import (a STEP of it) and its chain; compare is between STEP files only.
  versionsButton.disabled = !shownModel || compareBusy;
  versionsButton.title = VERSIONS_TITLE;
  // Only the label: the icon and ▾ stay (T10.1; the label hides when the toolbar is narrow).
  const versionsLabel = versionsButton.querySelector('.tb-label');
  if (versionsLabel) versionsLabel.textContent = compareBusy ? 'Comparing…' : 'Versions';
  versionsButton.setAttribute('aria-pressed', String(comparing !== undefined));
  compareLegend.hidden = !comparing;
  if (comparing) {
    byId('compare-legend-text').textContent = `Comparing with ${comparing.name}:`;
    byId('compare-key-old').textContent = comparing.oldKey;
    byId('compare-key-new').textContent = comparing.newKey;
  }
}
/** The previous version still in memory (T8.3), when its geometry differs. */
function previousTarget(): CompareTarget | undefined {
  const prev = previousVersion;
  // T9.2: no compare with a mesh (other origin, no CAD tessellation).
  if (!prev?.model || prev.carried || prev.model.meshFormat || shownModel?.meshFormat)
    return undefined;
  return {
    name: prev.path === shownPath ? `${prev.name} before reload` : prev.name,
    model: prev.model,
    oldKey: 'Previous version',
    newKey: 'New or moved',
  };
}
async function startCompare(target: CompareTarget): Promise<void> {
  const old = target.model;
  const now = shownModel;
  if (!now) return;
  if (compareDiff?.old !== old || compareDiff.now !== now) {
    // Takes seconds on big models (main thread): say so before the work blocks the window.
    compareBusy = true;
    renderVersionsButton();
    await viewport.afterNextFrame();
    compareBusy = false;
    if (shownModel !== now) {
      renderVersionsButton(); // another model was loaded meanwhile
      return;
    }
    const t0 = performance.now();
    // On the other version's surface within twice the mesh's chord error = not changed.
    const onOld = new SurfaceRaycaster(old);
    const onNew = new SurfaceRaycaster(now);
    const tol = 2 * Math.max(old.tessellation.linearDeflection, now.tessellation.linearDeflection);
    const diff = versionDiff(old, now, {
      old: (x, y, z) => onOld.near(x, y, z, tol),
      new: (x, y, z) => onNew.near(x, y, z, tol),
    });
    onOld.dispose();
    onNew.dispose();
    compareDiff = { old, now, diff };
    console.info(`Compare: diff in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  comparing = target;
  viewport.setCompare(compareDiff.diff);
  renderVersionsButton();
}
/** T8.5: compare with a version file next to the model (read and imported, not shown). */
async function compareWithFile(row: {
  readonly path: string;
  readonly name: string;
}): Promise<void> {
  const api = window.thirdWheel;
  const now = shownModel;
  const shown = shownFile;
  if (!api || !now || !shown) return;
  endCompare();
  compareBusy = true;
  renderVersionsButton();
  let model: StepModel | undefined;
  try {
    const file = await api.rereadModelFile(row.path);
    if (compareFile?.path === file.path && compareFile.contentHash === file.contentHash)
      model = compareFile.model;
    else {
      const loaded = await compareLoader.load(file, () => undefined);
      compareLoader.release(); // no exact values needed: free the kernel
      if (!loaded) return;
      compareFile = { path: file.path, contentHash: file.contentHash, model: loaded.model };
      model = loaded.model;
    }
  } catch (err) {
    if (shownModel === now)
      showNotice(`Couldn't read ${row.name} to compare: ${ipcErrorText(err)}`);
    return;
  } finally {
    compareBusy = false;
    renderVersionsButton();
  }
  if (shownModel !== now) return; // another model was opened meanwhile
  await startCompare({
    name: row.name,
    model,
    oldKey: `Only in ${row.name}`,
    newKey: `Only in ${shown.name} (shown)`,
  });
}
function endCompare(): void {
  if (!comparing) return;
  comparing = undefined;
  viewport.setCompare(undefined);
  renderVersionsButton();
}
/** T8.5 "Import new version…": the newer file of the shown model, its notes brought over. */
async function importNewVersion(): Promise<void> {
  const api = window.thirdWheel;
  const shown = shownFile;
  if (!api || !shown || compareBusy) return;
  const fromMesh = meshFormatOf(shown.name) !== undefined;
  const file = await api.openModelDialog(
    fromMesh ? `Import a STEP version of ${shown.name}` : `Import new version of ${shown.name}`,
    shown.path,
  );
  if (!file || shownFile !== shown) return; // cancelled, or another model was opened meanwhile
  if (meshFormatOf(file.name)) {
    // T9.2: mesh → STEP only (mesh → mesh: backlog).
    showAlert(
      'Not imported',
      `${file.name} is a mesh file. Notes move onto a STEP file (from a STEP or a mesh), not onto a mesh; open it with Open… instead.`,
    );
    return;
  }
  if (file.path === shown.path) {
    // The same file: Reload from disk (a changed file is a new version of itself, T8.1).
    if (file.contentHash === shown.contentHash) showNotice(`${shown.name} hasn't changed on disk.`);
    else await loadModel(file);
    return;
  }
  // T13.4: a file can't become newer than one of its own newer versions (a circle).
  const self: VersionLink = { ...shown, date: new Date().toISOString() };
  const line = [self, ...(await walkEarlier(versionChain?.earlier, readChainOf, shown))];
  if (shownFile !== shown) return;
  if (makesCircle(file, line)) {
    showAlert(
      'Not imported',
      `${file.name} is an earlier version of ${shown.name}, so it can't also be a newer one. To change the order, remove it under Versions ▾ first.`,
    );
    return;
  }
  // The user is here: a file already linked to another earlier version asks which one is right.
  await loadModel(file, { path: shown.path, name: shown.name }, true);
}
/** Open a version from the menu, like Open… (asks to bring notes over when it has none). */
async function openVersion(row: { readonly path: string; readonly name: string }): Promise<void> {
  const api = window.thirdWheel;
  if (!api) return;
  let file: ModelFile;
  try {
    file = await api.rereadModelFile(row.path, true);
  } catch (err) {
    showNotice(`Couldn't open ${row.name}: ${ipcErrorText(err)}`);
    return;
  }
  await loadModel(file, undefined, true);
}
/** The shown file as the menu sees it. */
type ShownVersion = { readonly path: string; readonly name: string; readonly contentHash: string };
/**
 * T13.4: the chain as the menu last walked it — the earlier line (nearest first) and each listed
 * newer version with the version it was made from — so Remove knows the neighbours.
 */
interface ChainView {
  readonly line: readonly VersionLink[];
  readonly newer: readonly { readonly link: VersionLink; readonly parent: VersionLink }[];
}
let chainView: ChainView | undefined;
/**
 * T8.6: the shown model's version chain as menu rows, each file checked on disk (content hash).
 * T13.4: earlier versions are walked parent by parent (`walkEarlier`); newer ones follow the
 * "newer version" signposts, each kept only when that file names its parent (or can't be read).
 */
async function chainRows(shown: ShownVersion): Promise<VersionRow[]> {
  const api = window.thirdWheel;
  const chain = versionChain;
  const self: VersionLink = { ...shown, date: new Date().toISOString() };
  const line = await walkEarlier(chain?.earlier, readChainOf, shown);
  const newer: { link: VersionLink; parent: VersionLink }[] = [];
  const levels: VersionLink[][] = [];
  const seen = new Set([`${shown.path}\n${shown.contentHash}`]);
  let level: { node: VersionLink; chain: VersionChain | undefined }[] = [{ node: self, chain }];
  let reads = 0;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && level.length > 0; depth++) {
    const next: typeof level = [];
    const found: VersionLink[] = [];
    for (const { node, chain: nodeChain } of level)
      for (const l of nodeChain?.newer ?? []) {
        const k = `${l.path}\n${l.contentHash}`;
        // Each file read costs a hash on first sight: at most MAX_NEWER_FILES in all.
        if (seen.has(k) || reads >= MAX_NEWER_FILES) continue;
        reads++; // stale signposts count too: a strict cap on files read
        const got = await readChainOf(l);
        // A stale signpost (that file was moved to another earlier version, or removed).
        if (got && !confirmsParent(got.chain, { ...node, chain: nodeChain })) continue;
        seen.add(k);
        newer.push({ link: l, parent: node });
        found.push(l);
        if (got) next.push({ node: l, chain: got.chain });
      }
    levels.push(found);
    level = next;
  }
  chainView = { line, newer };
  const states = new Map<string, string | null>();
  const paths = [...new Set([...line, ...newer.map((n) => n.link)].map((l) => l.path))];
  if (api && paths.length > 0)
    try {
      for (const st of await api.versionFileStates(paths)) states.set(st.path, st.contentHash);
    } catch (err) {
      console.warn('Could not check the versions on disk', err);
    }
  // Furthest newer versions first, then the shown file's own, the shown file, the earlier line.
  const further = levels.slice(1).reverse().flat();
  const rows = versionRows(shown, { earlier: line, newer: levels[0] ?? [] }, states, further);
  // Only links in the shown file's own notes can be located (saved there).
  const ownLinks = [...(chain?.earlier ?? []), ...(chain?.newer ?? [])];
  return rows.map((r) =>
    r.link ? { ...r, own: ownLinks.some((l) => r.link && sameVersion(l, r.link)) } : r,
  );
}
/** One version row of the menu (T8.6 states). */
function versionEntry(shown: ShownVersion, row: VersionRow): MenuEntry {
  const base = { label: versionLabel(row), detail: versionDetail(row) };
  const locate: MenuEntry[] =
    row.own && row.link
      ? [{ label: 'Locate…', action: 'locate-version', onSelect: () => void locateVersion(row) }]
      : [];
  // T13.4: every other version can be taken out of the chain (the file stays on disk).
  const remove: MenuEntry = {
    label: 'Remove from versions…',
    action: 'remove-version',
    title: 'Take this file out of the versions (for a wrong import). The file and its notes stay.',
    onSelect: () => void removeVersion(shown, row),
  };
  switch (row.state) {
    case 'shown':
      return { ...base, checked: true, disabled: true };
    case 'overwritten':
      return {
        ...base,
        action: 'version-row',
        title: 'A newer version was saved over this file, so these contents are gone from disk.',
        submenu: [remove],
      };
    case 'missing':
      return {
        ...base,
        action: 'version-row',
        title: `${row.path} is not there any more (moved, renamed or deleted). If you removed it from the versions of another file, remove it here too.`,
        submenu: [...locate, remove],
      };
    case 'changed':
      return {
        ...base,
        action: 'version-row',
        title: `${row.path} has other contents than the version linked here`,
        submenu: [
          {
            label: 'Open (as it is now)',
            action: 'open-version',
            onSelect: () => void openVersion(row),
          },
          ...locate,
          remove,
        ],
      };
    case 'found':
      return {
        ...base,
        action: 'version-row',
        title: row.path,
        submenu: [
          // T9.2: compare is between STEP files only; greyed with the reason (T11.2).
          meshFormatOf(row.name) || meshFormatOf(shown.name)
            ? {
                label: `Compare with ${shown.name}`,
                action: 'compare-version',
                disabled: true,
                title:
                  'Compare works between STEP files only: an STL / 3MF has its own position and turn, so it would show as all changed',
              }
            : {
                label: `Compare with ${shown.name}`,
                action: 'compare-version',
                onSelect: () => void compareWithFile(row),
              },
          { label: 'Open', action: 'open-version', onSelect: () => void openVersion(row) },
          'separator',
          remove,
        ],
      };
  }
}
/**
 * T13.4 "Remove from versions…": take `row`'s version out of the chain, like unlinking a node from
 * a list — its newer versions get its earlier one as their own, its earlier one gets them as newer
 * ones, and its own notes get empty lists and the "unlinked" mark (the guesses leave it out until it
 * is linked again). Its own notes decide its neighbours; the menu's walk fills in where they can't
 * be read. The model files and all markers / comments stay; no Undo (it writes other files' notes),
 * so it asks first.
 */
async function removeVersion(shown: ShownVersion, row: VersionRow): Promise<void> {
  const api = window.thirdWheel;
  const file = shownFile;
  const removed = row.link;
  if (!api || !file || !removed || file.path !== shown.path) return;
  const label = versionLabel(row);
  const answer = await askChoice(
    `Remove ${label} from the versions?`,
    `${
      row.state === 'overwritten'
        ? 'These contents are already gone from disk; only the entry goes.'
        : 'The file and its notes stay on disk.'
    } It is no longer listed as a version of ${file.name}, and Third Wheel stops suggesting it as a version. To link it again, use Versions ▾ → Import new version… on the right file.`,
    'Remove',
    'Cancel',
  );
  if (answer !== 'first' || shownFile !== file) return;
  if (compareFile && sameVersion(compareFile, removed)) endCompare();
  const view = chainView;
  const self: VersionLink = {
    path: file.path,
    name: file.name,
    contentHash: file.contentHash,
    date: new Date().toISOString(),
  };
  let parent: VersionLink | undefined;
  const children: VersionLink[] = [];
  const at = view?.line.findIndex((l) => sameVersion(l, removed)) ?? -1;
  if (view && at >= 0) {
    parent = view.line[at + 1];
    const child = at === 0 ? self : view.line[at - 1];
    if (child) children.push(child);
  } else if (view) {
    parent = view.newer.find((n) => sameVersion(n.link, removed))?.parent;
    for (const n of view.newer) if (sameVersion(n.parent, removed)) children.push(n.link);
  }
  const own = removed.overwritten ? undefined : await readChainOf(removed);
  if (own) {
    // Its own notes are the truth for its parent; its signposts that hold add children.
    parent = own.chain?.earlier?.[0];
    for (const l of own.chain?.newer ?? []) {
      const got = await readChainOf(l);
      if (got && confirmsParent(got.chain, { ...removed, chain: own.chain })) children.push(l);
    }
  }
  if (shownFile !== file) return;
  const failed: string[] = [];
  for (const step of removalPlan({ removed, parent, children, date: self.date })) {
    if (sameVersion(step, file)) {
      versionChain = editChain(versionChain, step.edit);
      autosave.changed();
      await autosave.flush(); // the newer file's parent first: the others follow it
      continue;
    }
    try {
      await api.editVersionLinks(step.path, step.contentHash, step.edit);
    } catch (err) {
      console.warn(`T13.4: could not update the notes of ${step.name}`, err);
      // The removed file itself without notes (moved, never had any) has nothing to unlink.
      if (!sameVersion(step, removed)) failed.push(step.name);
    }
  }
  if (shownFile !== file) return;
  // A stale copy in the shown file's own lists goes too.
  const cleaned = editChain(versionChain, {
    drop: [{ path: removed.path, contentHash: removed.contentHash }],
  });
  if (JSON.stringify(cleaned) !== JSON.stringify(versionChain)) {
    versionChain = cleaned;
    autosave.changed();
  }
  showNotice(
    failed.length > 0
      ? `Removed ${label} from the versions of ${file.name}. Couldn't update the notes of ${failed.join(', ')} (moved, read-only or no notes); it may still list the link.`
      : `Removed ${label} from the versions of ${file.name}. The file stays on disk.`,
  );
  renderVersionsButton();
}
/**
 * T8.6 "Locate…": the user picks where a moved / renamed version is now. Taken only when its
 * contents are the linked ones (content hash); the shown model's notes then point there.
 */
async function locateVersion(row: VersionRow): Promise<void> {
  const api = window.thirdWheel;
  const shown = shownFile;
  const link = row.link;
  if (!api || !shown || !link || !versionChain) return;
  const file = await api.openModelDialog(`Locate ${row.name}`, shown.path);
  if (!file || shownFile !== shown) return; // another model was opened meanwhile
  if (file.contentHash !== link.contentHash) {
    showNotice(
      `${file.name} is not the version linked here: its contents are different from ${row.name}.`,
    );
    return;
  }
  versionChain = relocated(versionChain, link, { path: file.path, name: file.name });
  autosave.changed();
  showNotice(`Found ${row.name} at ${file.path}.`);
}
/** The menu: import, compare with the previous version, then this model's version chain. */
async function versionEntries(shown: ShownVersion): Promise<MenuEntry[]> {
  const entries: MenuEntry[] = [
    {
      label: 'Import new version…',
      action: 'import-version',
      detail: shortcutLabel('i', isMac),
      title: meshFormatOf(shown.name)
        ? `Pick a STEP file of ${shown.name}: its paint and comments are brought onto the STEP's faces`
        : `Pick the newer file of ${shown.name}: its markers and comments are brought over`,
      onSelect: () => void importNewVersion(),
    },
  ];
  const prev = previousTarget();
  if (prev)
    entries.push({
      label: 'Compare with previous version',
      action: 'compare-previous',
      detail: prev.name,
      onSelect: () => void startCompare(prev),
    });
  if (comparing)
    entries.push({ label: 'Stop comparing', action: 'compare-stop', onSelect: endCompare });
  const rows = await chainRows(shown);
  entries.push('separator', {
    label: rows.length > 1 ? 'Versions of this model' : 'No other versions linked yet',
    disabled: true,
  });
  // The shown file always stays listed, even when many versions are cut off.
  const shownAt = rows.findIndex((r) => r.state === 'shown');
  const listed = rows.filter((_r, i) => Math.abs(i - shownAt) < MAX_VERSION_ROWS / 2);
  for (const row of listed) entries.push(versionEntry(shown, row));
  if (rows.length > listed.length)
    entries.push({
      label: `… ${count.format(rows.length - listed.length)} more`,
      disabled: true,
    });
  entries.push('separator', {
    label: 'Versions are linked by Import new version',
    title:
      'Import new version… (or "Bring my notes over" when opening a file) links the two files in their notes. Open… alone treats a file as a separate model.',
    disabled: true,
  });
  return entries;
}
versionsButton.addEventListener('click', () => {
  const shown = shownFile;
  if (!shown || contextMenu.justClosedBy(versionsButton)) return;
  void versionEntries(shown).then((entries) => {
    if (shownFile === shown) openDropdown(versionsButton, entries);
  });
});
byId('compare-end').addEventListener('click', endCompare);
window.addEventListener('keydown', (e) => {
  if (isPrimaryShortcut(e, 'o', isMac)) {
    e.preventDefault();
    if (shortcutOnce.take('open', 'key', performance.now())) void openModelDialog();
  } else if (isPrimaryShortcut(e, 'i', isMac)) {
    e.preventDefault();
    if (shortcutOnce.take('import', 'key', performance.now())) void importNewVersion();
  }
});
window.thirdWheel?.onModelFile((file) => {
  void loadModel(file, undefined, true);
});

// --- "Send to AI" button + AI message banner (T7.3) --------------------------------------
// The AI asks with `request_review` → banner + rainbow button; Send answers its `wait_for_review`.
// Without a request, Send copies a message to paste into the AI chat (all reviewed models).
const reviews = new ReviewRequests();
const reviewedFiles = new ReviewedFiles();
const aiBanner = byId('ai-banner');
const aiBannerText = byId('ai-banner-text');
const sendAiButton = byId('send-ai') as HTMLButtonElement;
const sendAiCount = byId('send-ai-count');
const openCommentCount = (): number => comments.list().filter((c) => c.status === 'open').length;
function renderSendToAi(): void {
  const open = openCommentCount();
  if (shownFile)
    reviewedFiles.update({ path: shownFile.path, name: shownFile.name, openComments: open });
  const asking = reviews.open() !== undefined;
  // A multi-model request (T7.4) sends the open comments of all its models.
  const sending = asking ? requestCounts().reduce((n, c) => n + c.openComments, 0) : open;
  sendAiButton.disabled = !shownFile;
  sendAiButton.classList.toggle('asking', asking);
  sendAiCount.hidden = !shownFile || sending === 0; // no "0" badge (T12.3)
  sendAiCount.textContent = String(sending);
  sendAiButton.setAttribute('aria-label', `Send to AI, ${String(sending)} open comments`);
  if (asking) renderBannerModels();
  sendAiButton.title = !shownFile
    ? 'Open a model first'
    : asking
      ? 'The AI is waiting for your review: send your open comments'
      : nothingToSend()
        ? 'Nothing to send yet: add a comment first'
        : 'Copy a message for your AI chat that asks it to read your comments';
}
/** No AI request and no open comments on any model of this session: nothing to copy (T12.3). */
function nothingToSend(): boolean {
  if (!shownFile) return true;
  return reviewedFiles.forMessage(shownFile.path).every((f) => f.openComments === 0);
}
const aiBannerModels = byId('ai-banner-models');
reviews.onChange = (open) => {
  aiBanner.hidden = !open;
  const several = (open?.models.length ?? 0) > 1;
  aiBannerText.textContent =
    open?.message ??
    (several
      ? 'Please review these models together and add comments.'
      : 'Please review this model and add comments.');
  renderBannerModels();
  renderSendToAi();
};
/**
 * A request for several models (T7.4): one button per model with its open comments; the shown one
 * is marked, a click on another opens it (the request stays open). Send answers for all of them.
 */
function renderBannerModels(): void {
  const open = reviews.open();
  if (!open || open.models.length < 2) {
    aiBannerModels.hidden = true;
    aiBannerModels.replaceChildren();
    return;
  }
  const counts = new Map(requestCounts().map((c) => [c.modelId, c.openComments]));
  const label = document.createElement('span');
  label.textContent = 'Models:';
  const buttons = open.models.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-banner-model';
    const shown = m.modelId === shownFile?.modelId;
    const n = counts.get(m.modelId) ?? 0;
    b.textContent = `${m.name} · ${String(n)}`;
    b.setAttribute('aria-current', String(shown));
    b.title = shown
      ? `${m.path}\nShown now · ${String(n)} open comments`
      : `${m.path}\nOpen it to mark and comment (${String(n)} open comments)`;
    if (!shown)
      b.addEventListener('click', () => {
        void reopenModel(m.path);
      });
    return b;
  });
  aiBannerModels.replaceChildren(label, ...buttons);
  aiBannerModels.hidden = false;
}
function sendToAi(): void {
  if (!shownFile) return;
  const draft = commentsPanel.postDraft(); // typed but not posted: it goes out too
  const sentNote =
    draft === 'posted'
      ? 'Posted your comment and sent.'
      : draft === 'saved'
        ? 'Saved your edit and sent.'
        : 'Sent: the AI is reading your comments.';
  void autosave.flush(); // the AI reads the app; this also keeps the sidecar up to date
  renderSendToAi(); // counts include a comment / reply just posted from the box
  if (reviews.open()) {
    // The AI asked: 0 comments is an answer too ("looks fine"), so it is sent (T12.3).
    const counts = requestCounts();
    const none = counts.every((c) => c.openComments === 0);
    reviews.send(counts);
    showNotice(none && !draft ? 'Sent: no open comments.' : sentNote);
    return;
  }
  if (nothingToSend()) {
    showNotice(
      `${draft === 'saved' ? 'Saved your edit. ' : ''}Nothing to send yet: add a comment first.`,
    );
    return;
  }
  const text = sendToAiMessage(reviewedFiles.forMessage(shownFile.path));
  navigator.clipboard.writeText(text).then(
    () => {
      showNotice(
        `${draft ? 'Comment posted. ' : ''}The AI has not asked for a review, so a message was copied. Paste it into your AI chat.`,
      );
    },
    () => {
      showNotice(`Couldn't copy. Paste this into your AI chat:\n${text}`);
    },
  );
}
sendAiButton.addEventListener('click', sendToAi);
byId('ai-banner-send').addEventListener('click', sendToAi);
byId('ai-banner-dismiss').addEventListener('click', () => {
  reviews.cancel('The user dismissed the review request');
});
renderSendToAi();

// --- App bridge (T7.1, T7.2): requests from the MCP server that the window answers ----------
window.thirdWheel?.onBridgeRequest((method, params) => {
  switch (method) {
    case 'status': {
      const model = shownModel;
      if (!shownFile || !model) return { model: shownFile } satisfies StatusResult;
      const byStatus: Record<CommentStatus, number> = { open: 0, resolved: 0, wontfix: 0 };
      for (const c of comments.list()) byStatus[c.status]++;
      return {
        model: shownFile,
        summary: {
          bodies: model.bodyCount,
          markers: markers.list().length,
          comments: byStatus,
          ...(model.meshFormat ? { mesh: model.meshFormat } : {}),
        },
      } satisfies StatusResult;
    }
    case 'search_parts':
      return getCatalogue().then((catalogue) =>
        searchParts(catalogue, parseParams(searchPartsParamsSchema, params, method)),
      );
    case 'load':
      return bridgeLoad(params as LoadRequest);
    case 'annotations': {
      const p = parseParams(annotationsParamsSchema, params, method);
      const statuses = p.statuses ?? ['open'];
      const kept = shownFile?.modelId === p.modelId ? undefined : sessionModels.get(p.modelId);
      // The file's folder goes along: the AI edits the file or writes the next version beside it.
      const withPath = (payload: ReviewPayload): ReviewPayload => {
        const path = (sessionModels.get(p.modelId) ?? kept)?.model.path ?? shownFile?.path;
        if (!path) return payload;
        const { model, ...rest } = payload;
        return { model, path, ...rest };
      };
      if (kept?.payload)
        return reviewPayloadText(withPath(filterReviewPayload(kept.payload, statuses)));
      return reviewPayloadText(withPath(shownReview(modelFor(p.modelId), statuses)));
    }
    case 'request_review': {
      const p = parseParams(requestReviewParamsSchema, params, method);
      modelFor(p.modelId);
      const others = (p.alsoModelIds ?? []).map((id) => {
        const known = sessionModels.get(id);
        if (!known)
          throw new Error(
            `Model "${id}" was not opened in this app session — call load_model on it first`,
          );
        return known.model;
      });
      const shown = sessionModels.get(p.modelId)?.model;
      if (!shown) throw new Error(NO_MODEL);
      return {
        reviewId: reviews.request([shown, ...others], p.message).id,
      } satisfies RequestReviewResult;
    }
    case 'wait_review': {
      const p = parseParams(waitReviewParamsSchema, params, method);
      return reviews.wait(p.reviewId, p.timeoutSec * 1000);
    }
    case 'render':
      return bridgeRender(params);
    case 'set_comment_status': {
      const p = parseParams(setCommentStatusParamsSchema, params, method);
      modelFor(p.modelId); // comment ids repeat across models (c1, c2, …)
      if (!shownFile) throw new Error(NO_MODEL);
      if (!comments.get(p.commentId))
        throw new Error(`No comment "${p.commentId}" on ${shownFile.name}`);
      // Part results first: an unknown part id is an error and nothing is changed.
      const partsUpdated = p.partResults
        ? comments.setPartResults(p.commentId, p.partResults)
        : undefined;
      const before = comments.get(p.commentId)?.replies?.length ?? 0;
      const changed = comments.setStatus(p.commentId, p.status, p.note, 'ai');
      const c = comments.get(p.commentId);
      const replies = c?.replies ?? [];
      const reply = replies.length > before ? replies[replies.length - 1] : undefined;
      return {
        commentId: p.commentId,
        status: c?.status ?? p.status,
        ...(reply ? { replyId: reply.id } : {}),
        changed: changed || (partsUpdated ?? 0) > 0,
        ...(partsUpdated === undefined ? {} : { partsUpdated }),
      } satisfies SetCommentStatusResult;
    }
    case 'reply_comment': {
      const p = parseParams(replyCommentParamsSchema, params, method);
      modelFor(p.modelId);
      if (!shownFile) throw new Error(NO_MODEL);
      const c = comments.get(p.commentId);
      if (!c) throw new Error(`No comment "${p.commentId}" on ${shownFile.name}`);
      const partsUpdated = p.partResults
        ? comments.setPartResults(p.commentId, p.partResults)
        : undefined;
      const reply = comments.reply(p.commentId, p.text, 'ai');
      if (!reply)
        throw new Error(`Could not reply to "${p.commentId}" (empty text or thread full)`);
      return {
        commentId: p.commentId,
        replyId: reply.id,
        status: c.status,
        ...(partsUpdated === undefined ? {} : { partsUpdated }),
      } satisfies ReplyCommentResult;
    }
    default:
      throw new Error(`The window does not answer "${method}"`);
  }
});

const NO_MODEL = 'No model is open in Third Wheel — call load_model first';

/** The shown model, if `modelId` names it. */
function modelFor(modelId: string): StepModel {
  if (!shownModel || !shownFile) throw new Error(NO_MODEL);
  if (modelId !== shownFile.modelId) {
    const kept = sessionModels.get(modelId);
    const was = kept?.payload
      ? ` (${kept.model.name} was open earlier: get_annotations still reads it)`
      : '';
    throw new Error(
      `Model "${modelId}" is not shown${was}; the app shows ${shownFile.name} (modelId "${shownFile.modelId}"). Call load_model.`,
    );
  }
  return shownModel;
}

/**
 * Models opened in this window (T7.4), by modelId: where to open them again and, once another
 * model is shown, their review payload with every status (the mesh is gone by then; a model that
 * isn't shown can't change, so the payload stays true).
 */
const sessionModels = new Map<
  string,
  { model: ReviewModel; payload?: ReviewPayload; bodyNames?: readonly string[] }
>();

/** Review payload of the shown model, live. */
function shownReview(model: StepModel, statuses?: readonly CommentStatus[]): ReviewPayload {
  if (!paint || !shownFile) throw new Error('No paint layer');
  const doc = toAnnotations({
    fileName: shownFile.name,
    contentHash: shownFile.contentHash,
    model,
    markers: markers.list(),
    comments: comments.list(),
    paint,
  });
  return reviewPayload(model, doc, statuses ? { statuses } : {});
}

/**
 * Before another model replaces the shown one: keep its payload for `get_annotations` — not while
 * its sidecar is still being read (a quick switch), which would keep too few comments.
 */
function keepLeavingReview(): void {
  if (!shownModel || !shownFile) return;
  const entry = sessionModels.get(shownFile.modelId);
  if (!entry) return;
  if (!annotationsReady) {
    delete entry.payload;
    return;
  }
  try {
    entry.payload = shownReview(shownModel);
  } catch (err) {
    delete entry.payload;
    console.warn('Could not keep the review of', shownFile.name, err);
  }
}

/** Open comments per model of the open request: shown one live, the others as kept. */
function requestCounts(): ReviewModelCount[] {
  return (reviews.open()?.models ?? []).map((m) => ({
    modelId: m.modelId,
    name: m.name,
    openComments:
      m.modelId === shownFile?.modelId
        ? openCommentCount()
        : (sessionModels.get(m.modelId)?.payload?.comments.filter((c) => c.status === 'open')
            .length ?? 0),
  }));
}

/**
 * Other model files opened in this window (not the shown file), one per name, latest first: a
 * comment links to a file by name, so a newer export under the same name replaces the older one.
 */
function otherSessionModels(): ReviewModel[] {
  const byName = new Map<string, ReviewModel>();
  for (const { model } of [...sessionModels.values()].reverse())
    if (model.path !== shownFile?.path && !byName.has(model.name)) byName.set(model.name, model);
  return [...byName.values()];
}

/** Opens a model opened before in this window again (banner switcher, linked-model chips). */
async function reopenModel(path: string): Promise<void> {
  const api = window.thirdWheel;
  if (!api) return;
  let file: ModelFile;
  try {
    file = await api.rereadModelFile(path);
  } catch (err) {
    showNotice(`Couldn't open ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await loadModel(file);
}

/**
 * Reload from disk (T8.1; slicer wording): read the shown file again. Unchanged → say so and keep
 * everything (undo too); changed → load it as a new version of itself.
 */
async function reloadFromDisk(): Promise<void> {
  const api = window.thirdWheel;
  const shown = shownFile;
  if (!api || !shown) return;
  let file: ModelFile;
  try {
    file = await api.rereadModelFile(shown.path);
  } catch (err) {
    showNotice(`Couldn't reload ${shown.name}: ${ipcErrorText(err)}`);
    return;
  }
  if (shownFile !== shown) return; // another model was opened meanwhile
  if (file.contentHash === shown.contentHash) {
    showNotice(`${shown.name} hasn't changed on disk.`);
    return;
  }
  await loadModel(file);
}

/** `load` (main read the file): show it, then tell the AI what it got. */
async function bridgeLoad(request: LoadRequest): Promise<LoadResult> {
  const { revisionOf: previousId, ...file } = request;
  let revisionOf: { path: string; name: string } | undefined;
  if (previousId !== undefined) {
    const prevName =
      shownFile?.modelId === previousId
        ? shownFile.name
        : sessionModels.get(previousId)?.model.name;
    // T9.2: notes move from a STEP or a mesh onto a STEP; never onto a mesh.
    if (meshFormatOf(file.name))
      throw new Error(
        `revisionOf needs a STEP file to load: markers and comments are not moved onto STL / 3MF files${prevName ? ` (from ${prevName})` : ''}. Load without revisionOf.`,
      );
    const prev =
      shownFile?.modelId === previousId ? shownFile : sessionModels.get(previousId)?.model;
    if (!prev)
      throw new Error(
        `revisionOf: no model ${previousId} was loaded in this session (load the previous version first)`,
      );
    revisionOf = { path: prev.path, name: prev.name };
  }
  // Names of the previous version, before the new one replaces it (to see if a round trip lost them).
  const previousNames =
    previousId === undefined
      ? undefined
      : shownFile?.modelId === previousId
        ? shownModel?.bodyNames
        : sessionModels.get(previousId)?.bodyNames;
  await loadModel(file, revisionOf);
  const model = shownModel;
  if (!model || shownFile?.path !== file.path || shownFile.contentHash !== file.contentHash)
    throw new Error(modelStatus || `Could not open ${file.name}`);
  const byStatus: Record<CommentStatus, number> = { open: 0, resolved: 0, wontfix: 0 };
  for (const c of comments.list()) byStatus[c.status]++;
  return {
    modelId: shownFile.modelId,
    name: shownFile.name,
    path: shownFile.path,
    bodies: model.bodyCount,
    faces: model.faceBody.length,
    ...(model.meshFormat ? { mesh: model.meshFormat } : {}),
    markers: markers.list().length,
    comments: byStatus,
    ...(revisionInfo ? { revision: revisionInfo } : {}),
    ...(await loadHints(file)),
    ...namesLostNote(previousNames, model.bodyNames),
  };
}

/** `namesLost` for the load result: the user's body names the new file no longer has. */
function namesLostNote(
  previous: readonly string[] | undefined,
  next: readonly string[],
): { namesLost?: string } {
  if (!previous) return {};
  const lost = lostBodyNames(previous, next);
  return lost ? { namesLost: lostBodyNamesWarning(lost, customBodyNames(previous).length) } : {};
}

/**
 * T8.4: tell the AI to keep each version under its own name. `warning` = this load replaced the
 * previous version on disk (same path, new contents); `hint` = it looks like a newer copy of a
 * model of this session and `revisionOf` was not given.
 */
async function loadHints(file: ModelFile): Promise<Pick<LoadResult, 'hint' | 'warning'>> {
  if (chainWarning) return { warning: chainWarning }; // T13.4: a link moved or refused
  const { name } = file;
  if (revisionInfo && revisionInfo.path === file.path) {
    // Suggest a name not taken in the folder.
    let taken: ModelVersionFile[] = [];
    try {
      taken = (await window.thirdWheel?.listModelVersions(file.path)) ?? [];
    } catch {
      // folder not listable: suggest the plain next name
    }
    const names = new Set(taken.map((f) => f.name.toLowerCase()));
    let next = nextVersionName(name);
    for (let i = 0; i < 100 && names.has(next.toLowerCase()); i++) next = nextVersionName(next);
    return {
      warning: `${name} was overwritten with the new version, so the previous one is gone from disk (no compare after a restart). Next time export as ${next} and pass revisionOf.`,
    };
  }
  if (versionHint)
    return {
      hint: meshFormatOf(versionHint.name)
        ? `This has the same size as the mesh ${versionHint.name} (modelId "${versionHint.modelId}"), which has notes. If it is the same part, call load_model again with revisionOf: "${versionHint.modelId}" to bring its paint and comments onto this STEP.`
        : `This looks like a new version of ${versionHint.name} (modelId "${versionHint.modelId}"). If it is, call load_model again with revisionOf: "${versionHint.modelId}" to bring its markers and comments over.`,
    };
  return {};
}

/** `render`: one picture of some markers, or a contact sheet of marker groups. */
async function bridgeRender(params: unknown): Promise<RenderResult> {
  const p = parseParams(renderParamsSchema, params, 'render');
  modelFor(p.modelId);
  const known = new Set(markers.list().map((m) => m.id));
  const asked = p.markerIds ?? (p.groups ?? []).flat();
  const unknown = [...new Set(asked.filter((id) => !known.has(id)))];
  if (unknown.length > 0) throw new Error(`Unknown marker ids: ${unknown.join(', ')}`);
  if (p.markerIds) {
    const img = await renderRegion(p.markerIds, p.size);
    if (!img) throw new Error('Nothing to draw: these markers hold no paint or entities');
    return { png: base64(img.png), width: img.size, height: img.size, view: roundView(img) };
  }
  const sheet = await renderContactSheet(p.groups ?? []);
  if (!sheet || sheet.tiles.length === 0)
    throw new Error('Nothing to draw: these markers hold no paint or entities');
  return {
    png: base64(sheet.png),
    width: sheet.width,
    height: sheet.height,
    tiles: sheet.tiles.map((t) => ({
      ...roundView(t),
      number: t.number,
      group: t.region,
      markerIds: t.markerIds,
      x: t.x,
      y: t.y,
      size: t.size,
    })),
    skipped: sheet.skipped,
  };
}

/** Camera facts rounded for the AI: directions 1e-3, positions 0.01 mm, scale 4 digits. */
function roundView(v: RegionImage | ContactSheet['tiles'][number]): RenderView {
  const r = (x: number, d: number): number => Number(x.toFixed(d)) || 0;
  const v3 = (a: readonly number[], d: number): [number, number, number] => [
    r(a[0] ?? 0, d),
    r(a[1] ?? 0, d),
    r(a[2] ?? 0, d),
  ];
  return {
    viewDir: v3(v.viewDir, 3),
    up: v3(v.up, 3),
    center: v3(v.center, 2),
    mmPerPx: Number(v.mmPerPx.toPrecision(4)),
    ghosted: v.ghosted.map((g) => ({ body: g.body, name: g.name })),
  };
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// --- Tools ------------------------------------------------------------------
const toolButtons = new Map<ToolId, HTMLButtonElement>();
const toolGroup = byId('tools');
for (const tool of TOOLS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn tb-btn tool';
  btn.append(icon(TOOL_ICONS[tool.id]), toolbarLabel(tool.label));
  btn.setAttribute('aria-label', tool.label);
  btn.title = toolTitle(tool);
  btn.addEventListener('click', () => {
    setActiveTool(tool.id);
  });
  toolGroup.appendChild(btn);
  toolButtons.set(tool.id, btn);
}

function setActiveTool(id: ToolId): void {
  for (const [toolId, btn] of toolButtons) {
    btn.setAttribute('aria-pressed', String(toolId === id));
  }
  document.documentElement.dataset['tool'] = id;
  viewport.setTool(id);
  currentTool = id;
  applyBrushRadius();
}

/** Where Cmd/Ctrl+Z undoes typing (not checkboxes, colour inputs, selects). */
function isTextField(t: EventTarget | null): boolean {
  if (t instanceof HTMLInputElement) {
    return ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(t.type);
  }
  return t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

/** Z: zoom to the selection, or to all visible bodies when nothing (visible) is selected. */
function zoomToFit(): void {
  if (selection.size === 0 || !viewport.frameItems(selection.list())) viewport.fitAll();
}

window.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    !(
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable)
    )
  ) {
    if (isHelpOpen()) setHelpOpen(false);
    else selection.clear();
    return;
  }
  // Physical [ / ] keys too: on e.g. German / French layouts the characters need AltGr / Option,
  // which the modifier check below would swallow.
  const bracket = /^Bracket(Left|Right)$/.exec(e.code)?.[1];
  if (bracket && !e.metaKey && !isTypingTarget(e.target)) {
    stepToolSize(bracket === 'Right' ? 1 : -1);
    return;
  }
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement ||
    (e.target instanceof HTMLElement && e.target.isContentEditable)
  )
    return;
  // Physical digit keys, so layouts where digits need Shift (e.g. AZERTY) work too.
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1];
  const view = viewForKey(digit ?? e.key);
  if (view) {
    viewport.setView(view.dir);
    return;
  }
  if (e.key.toLowerCase() === FIT_KEY) {
    zoomToFit();
    return;
  }
  if (e.key === HELP_KEY) {
    setHelpOpen(!isHelpOpen());
    return;
  }
  if (e.key === BRUSH_SMALLER_KEY || e.key === BRUSH_LARGER_KEY) {
    stepToolSize(e.key === BRUSH_LARGER_KEY ? 1 : -1);
    return;
  }
  const id = toolForKey(e.key);
  if (id) setActiveTool(id);
});

// --- View buttons (under the view cube) -------------------------------------
const isoView = viewForKey('0');
const isoButton = byId('view-iso');
isoButton.title = 'Isometric view (0) — 1–6: Front, Top, Right, Back, Bottom, Left';
isoButton.addEventListener('click', () => {
  if (isoView) viewport.setView(isoView.dir);
});
for (const [id, cw] of [
  ['view-roll-ccw', false],
  ['view-roll-cw', true],
] as const) {
  const btn = byId(id);
  btn.title = `Rotate view 90° ${cw ? 'clockwise' : 'counter-clockwise'}`;
  btn.addEventListener('click', () => {
    viewport.roll(cw);
  });
}
const fitButton = byId('view-fit');
fitButton.title = `Zoom to the selection, or to all visible bodies (${FIT_KEY.toUpperCase()})`;
fitButton.addEventListener('click', () => {
  zoomToFit();
});
setActiveTool(DEFAULT_TOOL);
toolsReady = true;

// --- Toolbar fit (T10.1) ------------------------------------------------------------
// One row from the 960 px minimum window up: more compact steps until the widest tool's
// options fit (`toolbar-fit.ts`), the same step for every tool so switching never moves things.
const toolbarEl = document.querySelector<HTMLElement>('.toolbar');
let refitQueued = false;
function refitToolbar(): void {
  refitQueued = false;
  if (!toolbarEl) return;
  fitToolbar(
    toolbarEl,
    TOOLS.length,
    (i) => {
      showToolOptions(TOOLS[i]?.id ?? currentTool);
    },
    () => {
      showToolOptions(currentTool);
    },
  );
}
function queueRefit(): void {
  if (refitQueued) return;
  refitQueued = true;
  requestAnimationFrame(refitToolbar);
}
if (toolbarEl) {
  new ResizeObserver(refitToolbar).observe(toolbarEl);
  // Text changes (marker name, Send to AI count) change the widths too.
  new MutationObserver(queueRefit).observe(toolbarEl, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  void document.fonts.ready.then(refitToolbar);
}

// --- Region picture for the AI (T6.3; T7.2 `render_region` calls this) ---------
function renderRegion(
  markerIds: readonly string[],
  size?: number,
): Promise<RegionImage | undefined> {
  return viewport.renderRegion(regionRequest(markers.list(), markerIds), size);
}

/** Contact sheet (T6.4): up to 4 regions, each a list of marker ids, in one picture. */
function renderContactSheet(
  regions: readonly (readonly string[])[],
): Promise<ContactSheet | undefined> {
  const list = markers.list();
  return viewport.renderContactSheet(regions.map((ids) => regionRequest(list, ids)));
}

// --- Test hook (THIRD_WHEEL_TEST=1, dev builds only; see apps/desktop/e2e) --------
if (new URLSearchParams(location.search).get('test') === '1') {
  (window as Window & { __thirdWheelTest?: unknown }).__thirdWheelTest = {
    viewport,
    selection,
    markers,
    comments,
    commentsPanel,
    paint: (): PaintLayer | undefined => paint,
    renderRegion,
    renderContactSheet,
    history,
    brushRadius: (): number => brushRadius,
    fillAngle: (): number => fillAngle,
    model: (): StepModel | undefined => shownModel,
    /** The shown model's file path (T12.8 dialog folder). */
    shownPath: (): string | undefined => shownFile?.path,
    /** The shown model is drawn and its load finished (`model()` is set earlier, T12.1). */
    loaded: (): boolean => loadFinished,
    /** The version the shown model replaced (T8.1). */
    previousVersion: () =>
      previousVersion && {
        path: previousVersion.path,
        name: previousVersion.name,
        carried: previousVersion.carried,
        markers: previousVersion.doc?.markers.length,
        comments: previousVersion.doc?.comments.length,
        inMemory: previousVersion.model !== undefined,
      },
    revisionInfo: () => revisionInfo,
    /** Opens the shown file again (sidecar reload, T5.1); `saveFirst` = save before reading it. */
    reopen: async (saveFirst = true): Promise<void> => {
      if (saveFirst) autosave.flushSync();
      const path = shownPath;
      const api = window.thirdWheel;
      if (path === undefined || !api) throw new Error('no model');
      await loadModel(await api.rereadModelFile(path));
    },
    /** Writes pending annotation changes now (like Cmd/Ctrl+S). */
    flush: (): Promise<void> => autosave.flush(),
    notice: (): string | undefined => (notice.hidden ? undefined : noticeText.textContent),
    /** Text of the open pop-up (title + messages), or undefined. */
    alert: (): string | undefined =>
      alertDialog.open ? `${alertTitle.textContent}: ${alertBody.textContent}` : undefined,
  };
}
