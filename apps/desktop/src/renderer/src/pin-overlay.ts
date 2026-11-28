/**
 * Comment pins drawn over the 3D view: one HTML element per pin, kept between frames (so a
 * double click reaches the same element) and moved to its anchor's screen point every frame.
 * Look follows the comment cards: panel colour + number; the highlighted one is accent
 * blue and larger; AI comments get the "AI" tag's purple; closed ones are dimmed. Each pin has
 * several spots (`pinSpots`, preferred first): after a camera move it sits on the first one the
 * camera can see; while the camera moves it stays put. With no spot in
 * sight it goes back to the preferred one and fades, still clickable. Pins on the same spot
 * (comments on the same markers) fan out sideways so each can be clicked.
 */
import type { Vec3 } from './camera-views.js';
import type { PinSpec } from './comment-pins.js';

export interface PlacedPin extends PinSpec {
  /** Where the pin may sit, preferred first (never empty). */
  readonly spots: readonly Vec3[];
}

/** Sideways step between pins sharing an anchor (CSS px; a pin is 24 px wide). */
export const PIN_STACK_STEP_PX = 16;

/** Per anchor: how many earlier anchors are the same point (0 = first). */
export function stackIndices(anchors: readonly (readonly number[])[]): number[] {
  const seen = new Map<string, number>();
  return anchors.map((a) => {
    const key = a.join(',');
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  });
}

/** Where an anchor lands on screen (CSS px, canvas-relative); undefined = behind the camera. */
export type ProjectFn = (p: Vec3) => { x: number; y: number } | undefined;

export class PinOverlay {
  readonly el = document.createElement('div');
  private pins: readonly PlacedPin[] = [];
  /** Spot each pin sits on (index into its `spots`). */
  private chosen: number[] = [];
  private readonly elements = new Map<string, HTMLButtonElement>();
  /** Pin clicked; `detail` = the click count (2 = second click of a double click). */
  onClick: ((id: string, detail: number) => void) | undefined;

  constructor() {
    this.el.className = 'comment-pins';
  }

  set(pins: readonly PlacedPin[]): void {
    // Keep a pin's spot while its spots stay the same (a redraw mustn't make it jump back).
    const before = new Map(this.pins.map((p, i) => [p.id, { p, spot: this.chosen[i] ?? 0 }]));
    this.chosen = pins.map((p) => {
      const old = before.get(p.id);
      return old && sameSpots(old.p.spots, p.spots) ? old.spot : 0;
    });
    this.pins = pins;
    const keep = new Set(pins.map((p) => p.id));
    for (const [id, el] of this.elements) {
      if (!keep.has(id)) {
        el.remove();
        this.elements.delete(id);
      }
    }
    for (const p of pins) {
      let el = this.elements.get(p.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'comment-pin';
        el.dataset.pin = p.id;
        el.addEventListener('click', (e) => {
          this.onClick?.(p.id, e.detail);
          (e.currentTarget as HTMLElement).blur(); // keep tool keys working
        });
        this.elements.set(p.id, el);
      }
      el.textContent = String(p.number);
      el.title = p.title;
      el.setAttribute('aria-label', `Comment ${p.title}`);
      el.classList.toggle('focused', p.focused);
      el.classList.toggle('closed', p.closed);
      el.classList.toggle('ai', p.ai);
    }
    // Focused pin last = drawn on top of others; otherwise list order (higher numbers on top).
    const order = [...pins].sort((a, b) => Number(a.focused) - Number(b.focused));
    this.el.replaceChildren(...order.flatMap((p) => this.elements.get(p.id) ?? []));
  }

  get count(): number {
    return this.pins.length;
  }

  /**
   * Moves every pin to its spot; a pin whose spot is `occluded` fades. `settle` (the camera has
   * stopped at a new place, or the pins changed): first pick each pin's first visible spot —
   * preferably one inside the view (`size`, CSS px), so a zoomed-in pin doesn't jump off-screen.
   */
  place(
    project: ProjectFn,
    occluded: (p: Vec3) => boolean,
    settle: boolean,
    size: { readonly w: number; readonly h: number },
  ): void {
    const hidden = new Map<Vec3, boolean>();
    const isHidden = (p: Vec3): boolean => {
      let h = hidden.get(p);
      if (h === undefined) hidden.set(p, (h = occluded(p)));
      return h;
    };
    if (settle) {
      const onScreen = (p: Vec3): boolean => {
        const q = project(p);
        return q !== undefined && q.x >= 0 && q.y >= 0 && q.x <= size.w && q.y <= size.h;
      };
      this.chosen = this.pins.map((p) => {
        const inView = p.spots.findIndex((s) => onScreen(s) && !isHidden(s));
        return Math.max(0, inView >= 0 ? inView : p.spots.findIndex((s) => !isHidden(s)));
      });
    }
    const anchors = this.pins.map(
      (p, i): Vec3 => p.spots[this.chosen[i] ?? 0] ?? p.spots[0] ?? [0, 0, 0],
    );
    const stack = stackIndices(anchors);
    this.pins.forEach((p, i) => {
      const el = this.elements.get(p.id);
      const anchor = anchors[i];
      if (!el || !anchor) return;
      const s = project(anchor);
      el.hidden = s === undefined;
      if (!s) return;
      const x = s.x + (stack[i] ?? 0) * PIN_STACK_STEP_PX;
      el.style.transform = `translate(${x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      el.classList.toggle('behind', isHidden(anchor));
    });
  }

  dispose(): void {
    this.el.remove();
    this.elements.clear();
  }
}

function sameSpots(a: readonly Vec3[], b: readonly Vec3[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i];
      return q !== undefined && p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
    })
  );
}
