/**
 * Tool switching, view buttons, toolbar fitting, and region pictures for the AI.
 */
import {
  type ToolId,
  TOOLS,
  toolTitle,
  BRUSH_SMALLER_KEY,
  BRUSH_LARGER_KEY,
  toolForKey,
  DEFAULT_TOOL,
} from '../tools.js';
import { icon } from '../icons.js';
import { viewForKey, FIT_KEY } from '../camera-views.js';
import { HELP_KEY } from '../help.js';
import { fitToolbar } from '../toolbar-fit.js';
import type { RegionImage, ContactSheet } from '../viewport.js';
import { regionRequest } from '../region-view.js';
import {
  applyBrushRadius,
  byId,
  currentTool,
  isHelpOpen,
  markers,
  selection,
  setCurrentTool,
  setHelpOpen,
  setToolsReady,
  showToolOptions,
  stepToolSize,
  TOOL_ICONS,
  toolbarLabel,
  viewport,
} from '../main.js';

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

export function setActiveTool(id: ToolId): void {
  for (const [toolId, btn] of toolButtons) {
    btn.setAttribute('aria-pressed', String(toolId === id));
  }
  document.documentElement.dataset['tool'] = id;
  viewport.setTool(id);
  setCurrentTool(id);
  applyBrushRadius();
}

/** Where Cmd/Ctrl+Z undoes typing (not checkboxes, colour inputs, selects). */
export function isTextField(t: EventTarget | null): boolean {
  if (t instanceof HTMLInputElement) {
    return ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(t.type);
  }
  return t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

export function isTypingTarget(t: EventTarget | null): boolean {
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
setToolsReady(true);

// --- Toolbar fit ------------------------------------------------------------
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
  // Text changes (marker name, Send review count) change the widths too.
  new MutationObserver(queueRefit).observe(toolbarEl, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  void document.fonts.ready.then(refitToolbar);
}

// --- Region picture for the AI (`render_region` calls this) --------------
export function renderRegion(
  markerIds: readonly string[],
  size?: number,
): Promise<RegionImage | undefined> {
  return viewport.renderRegion(regionRequest(markers.list(), markerIds), size);
}

/** Contact sheet: up to 4 regions, each a list of marker ids, in one picture. */
export function renderContactSheet(
  regions: readonly (readonly string[])[],
): Promise<ContactSheet | undefined> {
  const list = markers.list();
  return viewport.renderContactSheet(regions.map((ids) => regionRequest(list, ids)));
}
