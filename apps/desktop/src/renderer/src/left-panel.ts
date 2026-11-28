/**
 * The floating left panel over the 3D view (like Fusion's Browser): tabs Bodies | Chat,
 * ‹ folds it to the two tab buttons (a click on a tab opens it, on the open tab folds it), the
 * right edge resizes it (min 300 px). Width and folded are remembered; the tab is not (Chat opens
 * first when an agent connects, Bodies otherwise). The panel's width is published as CSS
 * variables so overlays of the 3D view can move out from under it.
 */

export const LEFT_PANEL_STORAGE_KEY = 'third-wheel.left-panel';
export const LEFT_PANEL_MIN_WIDTH = 300;
export const LEFT_PANEL_DEFAULT_WIDTH = 340;
const LEFT_PANEL_MAX_WIDTH = 640;
/** The 3D view keeps at least this much visible next to the open panel. */
const VIEW_KEEP = 200;
/** Gap between the panel and the view's edges (CSS `.panel-left` margin). */
export const LEFT_PANEL_MARGIN = 8;

export type LeftTab = 'bodies' | 'chat';

export interface LeftPanelSettings {
  readonly width: number;
  readonly folded: boolean;
}

/** Widest the panel may be in a view this wide; never under the minimum. */
export function maxPanelWidth(viewWidth: number): number {
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(LEFT_PANEL_MAX_WIDTH, viewWidth - VIEW_KEEP));
}

export function clampPanelWidth(width: number, viewWidth: number): number {
  if (!Number.isFinite(width)) return LEFT_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(maxPanelWidth(viewWidth), Math.max(LEFT_PANEL_MIN_WIDTH, width)));
}

export function parseLeftPanel(text: unknown): LeftPanelSettings {
  const fallback = { width: LEFT_PANEL_DEFAULT_WIDTH, folded: false };
  if (typeof text !== 'string') return fallback;
  try {
    const v = JSON.parse(text) as Partial<Record<keyof LeftPanelSettings, unknown>>;
    return {
      width: typeof v.width === 'number' && Number.isFinite(v.width) ? v.width : fallback.width,
      folded: v.folded === true,
    };
  } catch {
    return fallback;
  }
}

/** How much of the view's left side the panel covers (0 when folded: the tabs sit at the top). */
export function coveredWidth(settings: LeftPanelSettings): number {
  return settings.folded ? 0 : settings.width + LEFT_PANEL_MARGIN;
}

export interface LeftPanelOptions {
  readonly app: HTMLElement;
  readonly panel: HTMLElement;
  readonly view: HTMLElement;
  readonly load: () => string | null;
  readonly save: (text: string) => void;
  /** The shown tab, folded or the width changed (chat: unread bookkeeping; the view's shift). */
  readonly onChange?: () => void;
}

export class LeftPanel {
  private tabValue: LeftTab = 'bodies';
  private width: number;
  private foldedValue: boolean;
  private readonly tabs: Record<LeftTab, HTMLButtonElement>;
  private readonly bodies: Record<LeftTab, HTMLElement>;

  constructor(private readonly o: LeftPanelOptions) {
    const s = parseLeftPanel(o.load());
    this.width = s.width;
    this.foldedValue = s.folded;
    const q = (sel: string): HTMLElement => {
      const found = o.panel.querySelector<HTMLElement>(sel);
      if (!found) throw new Error(`${sel} missing from the left panel`);
      return found;
    };
    this.tabs = {
      bodies: q('#tab-bodies') as HTMLButtonElement,
      chat: q('#tab-chat') as HTMLButtonElement,
    };
    this.bodies = { bodies: q('#bodies'), chat: q('#chat') };
    for (const id of ['bodies', 'chat'] as const)
      this.tabs[id].addEventListener('click', () => {
        if (!this.foldedValue && this.tabValue === id) this.setFolded(true);
        else this.show(id);
      });
    q('#left-fold').addEventListener('click', () => {
      this.setFolded(true);
    });
    this.setupResize(q('#left-resize'));
    // Keep the width inside the view when the window shrinks.
    new ResizeObserver(() => {
      this.apply();
    }).observe(o.view);
    this.apply(false);
  }

  get tab(): LeftTab {
    return this.tabValue;
  }

  get folded(): boolean {
    return this.foldedValue;
  }

  /** Open the panel on `tab`. */
  show(tab: LeftTab): void {
    this.tabValue = tab;
    this.foldedValue = false;
    this.persist();
    this.apply();
  }

  setFolded(folded: boolean): void {
    this.foldedValue = folded;
    this.persist();
    this.apply();
  }

  /** CSS px of the view's left side the panel covers now (0 when folded). */
  get cover(): number {
    return coveredWidth({
      width: clampPanelWidth(this.width, this.viewWidth()),
      folded: this.foldedValue,
    });
  }

  /** Is `tab` open and visible? */
  isShowing(tab: LeftTab): boolean {
    return !this.foldedValue && this.tabValue === tab;
  }

  private viewWidth(): number {
    // The view spans from the window's left edge to the right panel.
    return this.o.view.clientWidth || window.innerWidth;
  }

  private apply(notify = true): void {
    const width = clampPanelWidth(this.width, this.viewWidth());
    const { app, panel } = this.o;
    app.style.setProperty('--left-w', `${String(width)}px`);
    app.style.setProperty('--left-cover', `${String(this.cover)}px`);
    panel.classList.toggle('folded', this.foldedValue);
    for (const id of ['bodies', 'chat'] as const) {
      const on = this.tabValue === id;
      this.tabs[id].setAttribute('aria-selected', String(on));
      this.tabs[id].title = on && !this.foldedValue ? 'Click to fold the panel' : '';
      this.bodies[id].hidden = this.foldedValue || !on;
    }
    if (notify) this.o.onChange?.();
  }

  private persist(): void {
    this.o.save(JSON.stringify({ width: this.width, folded: this.foldedValue }));
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = clampPanelWidth(this.width, this.viewWidth());
      const move = (ev: PointerEvent): void => {
        this.width = clampPanelWidth(startW + ev.clientX - startX, this.viewWidth());
        this.apply();
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this.persist();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    // Keyboard: arrows resize (the handle is a focusable separator).
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const cur = clampPanelWidth(this.width, this.viewWidth());
      this.width = clampPanelWidth(cur + (e.key === 'ArrowRight' ? step : -step), this.viewWidth());
      this.persist();
      this.apply();
    });
  }
}
