/**
 * Viewport tools (cursor modes), pure: switching tools and their cursors. Painting tools: Brush
 * and Smart fill (Shift erases in both; there is no separate Erase tool). Box select is part of
 * Select (a left drag).
 */
export type ToolId = 'select' | 'brush' | 'smart-fill';

/**
 * What the pointer looks like over the model: `pick` = arrow + hover highlight (Select);
 * `circle` = brush circle lying on the surface, sized to the brush radius; `crosshair` = a
 * crosshair only (the tool acts on what is under the point, size doesn't matter).
 */
export type ToolCursor = 'pick' | 'circle' | 'crosshair';

export interface ToolDef {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor: ToolCursor;
  /** Tooltip text after the name and shortcut. */
  readonly hint: string;
}

export const TOOLS: readonly ToolDef[] = [
  {
    id: 'select',
    label: 'Select',
    shortcut: 'V',
    cursor: 'pick',
    hint: 'pick vertices, edges, faces, bodies',
  },
  {
    id: 'brush',
    label: 'Brush',
    shortcut: 'B',
    cursor: 'circle',
    hint: 'paint the surface; Shift + drag erases the active marker',
  },
  {
    id: 'smart-fill',
    label: 'Smart fill',
    shortcut: 'F',
    cursor: 'crosshair',
    hint: 'fill a connected surface; Shift + click erases the active marker',
  },
];

export const DEFAULT_TOOL: ToolId = 'select';

/** Default brush radius in mm. Fixed mm, not relative to the model. */
export const DEFAULT_BRUSH_RADIUS_MM = 3;

/** Brush radii in mm that `[` / `]` and Alt + scroll step through. */
export const BRUSH_RADII_MM: readonly number[] = [
  0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50,
];
export const BRUSH_SMALLER_KEY = '[';
export const BRUSH_LARGER_KEY = ']';

/**
 * Radius `steps` entries up (+) or down (−) the `BRUSH_RADII_MM` list from `mm` (a value between
 * two entries first snaps to the nearest one); stops at the ends.
 */
export function stepBrushRadius(mm: number, steps: number): number {
  const list = BRUSH_RADII_MM;
  let nearest = 0;
  for (let i = 1; i < list.length; i++) {
    if (Math.abs((list[i] ?? 0) - mm) < Math.abs((list[nearest] ?? 0) - mm)) nearest = i;
  }
  const i = Math.min(list.length - 1, Math.max(0, nearest + Math.trunc(steps)));
  return list[i] ?? DEFAULT_BRUSH_RADIUS_MM;
}

/** Radius as shown to the user, e.g. "0.75 mm", "3 mm". */
export function formatBrushRadius(mm: number): string {
  return `${String(Math.round(mm * 100) / 100)} mm`;
}

/** Tool for a keyboard key (case-insensitive), if any. */
export function toolForKey(key: string): ToolId | undefined {
  const k = key.toUpperCase();
  return TOOLS.find((t) => t.shortcut === k)?.id;
}

export function toolDef(id: ToolId): ToolDef {
  const def = TOOLS.find((t) => t.id === id);
  if (!def) throw new Error(`unknown tool ${id}`);
  return def;
}

/** Tooltip of a toolbar button, e.g. "Brush (B) — paint the surface". */
export function toolTitle(def: ToolDef): string {
  return `${def.label} (${def.shortcut}) — ${def.hint}`;
}

/** Smart fill settings: angle in degrees, or exactly the clicked B-rep face. */
export interface FillSettings {
  readonly angleDeg: number;
  readonly wholeFace: boolean;
}

/** What Shift-erase would remove: the active marker's paint; `on` while Shift is held. */
export interface EraseInfo {
  readonly marker?: string | undefined;
  readonly on?: boolean;
}

/**
 * Readout under the view while a paint tool is active, e.g.
 * "Brush 3 mm · [ ] or Alt + scroll: size · Shift: erase Marker 1",
 * "Smart fill 30° · [ ] or Alt + scroll: angle · Shift: erase Marker 1"; while Shift is held
 * "Erasing Marker 1 — release Shift to paint" (replaces the toolbar's erase hint);
 * '' for Select.
 */
export function brushInfo(
  tool: ToolId,
  mm: number,
  fill?: FillSettings,
  erase: EraseInfo = {},
): string {
  const target = erase.marker ?? '';
  const painting =
    (tool === 'smart-fill' && fill !== undefined) || toolDef(tool).cursor === 'circle';
  if (!painting) return '';
  if (erase.on) return `Erasing ${target || 'paint'} — release Shift to paint`;
  const shift = target ? `Shift: erase ${target}` : 'Shift: erase';
  if (tool === 'smart-fill' && fill) {
    return fill.wholeFace
      ? `Smart fill · whole CAD face · ${shift}`
      : `Smart fill ${String(fill.angleDeg)}° · ${BRUSH_SMALLER_KEY} ${BRUSH_LARGER_KEY} or Alt + scroll: angle · ${shift}`;
  }
  const size = `${BRUSH_SMALLER_KEY} ${BRUSH_LARGER_KEY} or Alt + scroll: size`;
  return `${toolDef(tool).label} ${formatBrushRadius(mm)} · ${size} · ${shift}`;
}
