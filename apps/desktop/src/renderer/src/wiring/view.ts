/**
 * The 3D view and what sits around it: theme, help sheet, navigation / orbit style, the info
 * overlay, hover readout and the Info panel. Also the shown model's state (`shownModel` …).
 */
import { Viewport } from '../viewport.js';
import { THEME_MODES, isThemeMode, resolveTheme, type ThemeMode } from '../../../shared/theme.js';
import { isMacPlatform } from '../../../shared/shortcuts.js';
import { HELP_KEY, type HelpRow, cheatSheet } from '../help.js';
import {
  getNavigationStyle,
  NAVIGATION_STYLES,
  type NavigationStyleId,
  isNavigationStyleId,
  DEFAULT_NAVIGATION_STYLE,
  ORBIT_STYLES,
  isOrbitStyle,
  DEFAULT_ORBIT_STYLE,
} from '../navigation.js';
import { type StepModel, isEmptyExactRequest, type ExactRequest } from '@third-wheel/geometry';
import type { StatusResult } from '@third-wheel/core';
import { hoverLabel } from '../hover-label.js';
import {
  parseCollapsed,
  COLLAPSED_STORAGE_KEY,
  makeCollapsible,
  serializeCollapsed,
} from '../collapsible.js';
import { InfoPanel, INFO_MESH_HINT } from '../info-panel.js';
import { ExactValues, approxRequest, describeSelection } from '../info-format.js';
import {
  applyDimensions,
  byId,
  loader,
  loadSetting,
  NAV_STYLE_STORAGE_KEY,
  ORBIT_STYLE_STORAGE_KEY,
  saveSetting,
  selection,
  THEME_LABEL,
  THEME_STORAGE_KEY,
} from '../main.js';

// --- Viewport ---------------------------------------------------------------
export const viewport = new Viewport(byId('viewport'));

// --- Theme ------------------------------------------------------------------
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
// Status bar menu next to Orbit / Navigation (off the toolbar).
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

// --- Help / cheat sheet -----------------------------------------------------
// "?" button or ? key; content follows the navigation style. Stays open while the user tries
// things out; closes with ×, the button, ? or Esc.
export const isMac = isMacPlatform(navigator.userAgent);
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

export function isHelpOpen(): boolean {
  return !helpSheet.hidden;
}

export function setHelpOpen(open: boolean): void {
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

// --- Info overlay, bottom left of the view ------------------------------
const modelInfo = byId('model-info');
const selectionInfo = byId('selection-info');
export let modelStatus = 'No model loaded';
/** Sets `modelStatus` from another module (an import can't be assigned). */
export function setModelStatus(value: typeof modelStatus): void {
  modelStatus = value;
}
export let selectionStatus = '';
/** Sets `selectionStatus` from another module (an import can't be assigned). */
export function setSelectionStatus(value: typeof selectionStatus): void {
  selectionStatus = value;
}
export function renderStatus(): void {
  modelInfo.textContent = modelStatus;
  modelInfo.title = modelStatus;
  selectionInfo.textContent = selectionStatus;
}

// --- Hover readout (the viewport draws the highlight) -------------------------
const hoverInfo = byId('hover-info');
export let shownModel: StepModel | undefined;
/** Sets `shownModel` from another module (an import can't be assigned). */
export function setShownModel(value: typeof shownModel): void {
  shownModel = value;
}
/** The shown model's sidecar has been read (before that its comments are not all there). */
export let annotationsReady = false;
/** Sets `annotationsReady` from another module (an import can't be assigned). */
export function setAnnotationsReady(value: typeof annotationsReady): void {
  annotationsReady = value;
}
/** The shown model's load finished: drawn, panels filled, first frame out (test hook). */
export let loadFinished = false;
/** Sets `loadFinished` from another module (an import can't be assigned). */
export function setLoadFinished(value: typeof loadFinished): void {
  loadFinished = value;
}
export let shownPath: string | undefined;
/** Sets `shownPath` from another module (an import can't be assigned). */
export function setShownPath(value: typeof shownPath): void {
  shownPath = value;
}
/** The shown model file, as the app bridge reports it (`status`). */
export let shownFile: StatusResult['model'] = null;
/** Sets `shownFile` from another module (an import can't be assigned). */
export function setShownFile(value: typeof shownFile): void {
  shownFile = value;
}
viewport.onHover = (hit) => {
  hoverInfo.textContent = hit && shownModel ? hoverLabel(hit, shownModel) : '';
};

// --- Collapsible panel sections + Info panel ----------------------------------
const isAnyText = (v: unknown): v is string => typeof v === 'string';
const collapsed = parseCollapsed(loadSetting(COLLAPSED_STORAGE_KEY, isAnyText, '[]'));
const infoPanel = new InfoPanel(byId('info-body'));
/** Exact values from OpenCascade for the shown model; reset when a model loads. */
export let exactValues = new ExactValues();
/** Sets `exactValues` from another module (an import can't be assigned). */
export function setExactValues(value: typeof exactValues): void {
  exactValues = value;
}
/** An "Exact values" request is running; text = progress. */
let exactBusy: string | undefined;
export let exactError: string | undefined;
/** Sets `exactError` from another module (an import can't be assigned). */
export function setExactError(value: typeof exactError): void {
  exactError = value;
}
/** Last load time, for the re-read estimate. */
export let lastLoadMs = 0;
/** Sets `lastLoadMs` from another module (an import can't be assigned). */
export function setLastLoadMs(value: typeof lastLoadMs): void {
  lastLoadMs = value;
}
/** Info is only worked out while its section is open (face areas need a pass over the mesh). */
export function renderInfo(): void {
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
    applyDimensions();
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
