/**
 * Brush size and Smart fill angle: `[` / `]`, Alt + scroll and the toolbar's second row, remembered.
 */
import {
  DEFAULT_BRUSH_RADIUS_MM,
  type ToolId,
  DEFAULT_TOOL,
  brushInfo,
  formatBrushRadius,
  BRUSH_RADII_MM,
  stepBrushRadius,
} from '../tools.js';
import { MAX_FILL_ANGLE_DEG, DEFAULT_FILL_ANGLE_DEG, stepFillAngle } from '../smart-fill.js';
import { byId, isTypingTarget, loadSetting, markers, saveSetting, viewport } from '../main.js';

// --- Brush size / fill angle: [ / ] and Alt + scroll, remembered ----------
const BRUSH_RADIUS_KEY = 'third-wheel.brush-radius';
const isRadiusText = (v: unknown): v is string =>
  typeof v === 'string' && Number(v) > 0 && Number(v) <= 1000;
export let brushRadius = Number(
  loadSetting(BRUSH_RADIUS_KEY, isRadiusText, String(DEFAULT_BRUSH_RADIUS_MM)),
);
const brushInfoEl = byId('brush-info');
export let currentTool: ToolId = DEFAULT_TOOL;
/** Sets `currentTool` from another module (an import can't be assigned). */
export function setCurrentTool(value: typeof currentTool): void {
  currentTool = value;
}
const FILL_ANGLE_KEY = 'third-wheel.fill-angle';
const FILL_WHOLE_FACE_KEY = 'third-wheel.fill-whole-face';
const isAngleText = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && Number(v) >= 0 && Number(v) <= MAX_FILL_ANGLE_DEG;
export let fillAngle = Number(
  loadSetting(FILL_ANGLE_KEY, isAngleText, String(DEFAULT_FILL_ANGLE_DEG)),
);
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
/** Toolbar options follow the tool: Pick for Select, marker + size / angle for paint. */
export function showToolOptions(tool: ToolId): void {
  const painting = tool !== 'select';
  filterGroupEl.hidden = painting;
  paintMarkerEl.hidden = !painting;
  brushOptionsEl.hidden = tool !== 'brush';
  fillOptionsEl.hidden = tool !== 'smart-fill';
}

/** Shift held with a paint tool: the readout says it erases (the circle turns red). */
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

export function applyBrushInfo(): void {
  const erase = { marker: markers.active()?.name, on: shiftHeld };
  brushInfoEl.textContent = brushInfo(
    currentTool,
    brushRadius,
    { angleDeg: fillAngle, wholeFace: fillWholeFace },
    erase,
  );
  brushInfoEl.classList.toggle('erasing', shiftHeld && brushInfoEl.textContent !== '');
}

export function applyBrushRadius(): void {
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
export function stepToolSize(steps: number): void {
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
