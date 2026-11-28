/**
 * Toolbar fit: the toolbar stays one row from the 960 px minimum window up. When it
 * doesn't fit, it gets more compact step by step (like SolidWorks dropping button text):
 *   1 — Select / Brush / Smart fill and the Pick filters as icons only (tooltips name them)
 *   2 — Open folder, Add file, Parts ▾ and Versions ▾ as icons only (they keep their labels
 *       longer: their icons say less than the tools')
 *   3 — no "Pick" / "Size" / "Angle" labels, "Add ▾", "Whole face", a shorter marker name,
 *       tighter gaps
 * The level is the one the widest tool needs, so switching tools never moves anything.
 */

export const MAX_FIT_LEVEL = 3;

/** Smallest level at which nothing overflows (the last level when none fits). */
export function fitLevel(overflows: (level: number) => boolean, max = MAX_FIT_LEVEL): number {
  for (let level = 0; level < max; level++) if (!overflows(level)) return level;
  return max;
}

/** Classes for a level; they add up (level 3 = fit-1 fit-2 fit-3). */
export function fitClasses(level: number): string[] {
  const out: string[] = [];
  for (let l = 1; l <= Math.min(level, MAX_FIT_LEVEL); l++) out.push(`fit-${String(l)}`);
  return out;
}

/**
 * Picks and applies the level for `toolbar`. `showTool(i)` shows the options of tool `i` (all
 * tools in turn are measured), `restore()` shows the current tool's again. Runs in one frame,
 * so the measuring never paints.
 */
export function fitToolbar(
  toolbar: HTMLElement,
  toolCount: number,
  showTool: (i: number) => void,
  restore: () => void,
): number {
  const apply = (level: number): void => {
    toolbar.classList.remove(...fitClasses(MAX_FIT_LEVEL));
    toolbar.classList.add(...fitClasses(level));
  };
  const level = fitLevel((l) => {
    apply(l);
    for (let i = 0; i < toolCount; i++) {
      showTool(i);
      if (toolbar.scrollWidth > toolbar.clientWidth) return true;
    }
    return false;
  });
  apply(level);
  restore();
  toolbar.dataset['fit'] = String(level);
  return level;
}
