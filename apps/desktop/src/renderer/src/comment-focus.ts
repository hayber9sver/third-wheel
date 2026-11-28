/**
 * Focused comment look: the comment's markers keep their own
 * colour at full strength (shown even when hidden or resolved), every other marker's paint and
 * entities fade toward the face colour. Resolved markers shown by "Show resolved" are faded the
 * same way. Pure — the viewport applies it to what it draws.
 */
import type { MarkerStyle } from './paint-overlay.js';
import type { ShownEntity } from './markers.js';

/** How far other markers fade toward the face colour (0 = not at all, 1 = gone). */
export const FOCUS_FADE = 0.7;

/** 0xrrggbb mixed toward `to` by `t`. */
export function mixColor(from: number, to: number, t: number): number {
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    out |= Math.round(a + (b - a) * t) << shift;
  }
  return out;
}

/** `#rrggbb` mixed toward 0xrrggbb `to`. */
function mixHex(from: string, to: number, t: number): string {
  const n = mixColor(Number.parseInt(from.slice(1), 16), to, t);
  return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * Paint styles with a focus: focused markers drawn (even hidden) in full colour, others faded.
 * Without a focus only resolved markers shown by "Show resolved" (`fade`) are faded.
 */
export function focusedStyles(
  styles: readonly MarkerStyle[],
  focus: ReadonlySet<string> | undefined,
  faceColor: number,
): readonly MarkerStyle[] {
  const focused = focus !== undefined && focus.size > 0;
  if (!focused && !styles.some((s) => s.fade === true)) return styles;
  return styles.map((s) => {
    if (focused && focus.has(s.id)) return s.visible ? s : { ...s, visible: true };
    return focused || s.fade === true
      ? { ...s, color: mixColor(s.color, faceColor, FOCUS_FADE) }
      : s;
  });
}

/** Marker entities with a focus: other markers' entities faded (and resolved ones without one). */
export function focusedEntities(
  entities: readonly ShownEntity[],
  focus: ReadonlySet<string> | undefined,
  faceColor: number,
): readonly ShownEntity[] {
  const focused = focus !== undefined && focus.size > 0;
  if (!focused && !entities.some((e) => e.fade === true)) return entities;
  return entities.map((e) =>
    (focused && focus.has(e.markerId)) || (!focused && e.fade !== true)
      ? e
      : { ...e, color: mixHex(e.color, faceColor, FOCUS_FADE) },
  );
}
