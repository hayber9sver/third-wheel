/**
 * Dimensions drawn over the 3D view: a line with an arrow at each end and its value, for the
 * selection (1–2 entities) and the highlighted comment. Never stored; the app sets them whenever
 * the selection or the highlighted comment changes, and this moves them with the camera every
 * frame. Screen-space, so arrows and labels keep their size at any zoom; drawn on top of the
 * model (it is what you picked). Same blue as the selection, so it isn't mistaken for paint.
 */
import type { Vec3 } from './camera-views.js';
import type { ProjectFn } from './pin-overlay.js';

export interface DimensionSpec {
  readonly from: Vec3;
  readonly to: Vec3;
  /** e.g. "40 mm", "Ø6 mm", "R5 mm", "90°"; from === to = an angle (label only, at the point). */
  readonly label: string;
}

/** Arrowhead length and half width, CSS px. */
const ARROW_LEN = 9;
const ARROW_HALF = 3.5;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Arrowhead triangle at `tip` pointing away from `tail` (screen px), as an SVG points string. */
export function arrowPoints(
  tip: { x: number; y: number },
  tail: { x: number; y: number },
): string | undefined {
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return undefined;
  const ux = dx / l;
  const uy = dy / l;
  const bx = tip.x - ux * ARROW_LEN;
  const by = tip.y - uy * ARROW_LEN;
  const f = (n: number) => n.toFixed(1);
  return `${f(tip.x)},${f(tip.y)} ${f(bx - uy * ARROW_HALF)},${f(by + ux * ARROW_HALF)} ${f(bx + uy * ARROW_HALF)},${f(by - ux * ARROW_HALF)}`;
}

/** Gap between the line and its label, CSS px. */
const LABEL_GAP = 4;

/**
 * Where the label sits from the line's middle (CSS px): beside the line, above it (or to the
 * right of a near-vertical one), so a short line isn't covered. An angle (no line): on the point.
 */
export function labelOffset(
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1) return { x: 0, y: 0 };
  let nx = -dy / l;
  let ny = dx / l;
  if (ny > 1e-6 || (Math.abs(ny) <= 1e-6 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }
  const d = Math.abs(nx) * (width / 2) + Math.abs(ny) * (height / 2) + LABEL_GAP;
  return { x: nx * d, y: ny * d };
}

export class DimensionOverlay {
  readonly el = document.createElement('div');
  private readonly svg = document.createElementNS(SVG_NS, 'svg');
  private specs: readonly DimensionSpec[] = [];
  private parts: { line: SVGLineElement; arrows: SVGPolygonElement[]; label: HTMLElement }[] = [];

  constructor() {
    this.el.className = 'dimensions';
    this.svg.classList.add('dimension-lines');
    this.el.append(this.svg);
  }

  get count(): number {
    return this.specs.length;
  }

  set(specs: readonly DimensionSpec[]): void {
    this.specs = specs;
    for (const p of this.parts) p.label.remove();
    this.svg.replaceChildren();
    this.parts = specs.map((s) => {
      const line = document.createElementNS(SVG_NS, 'line');
      const arrows = [0, 1].map(() => document.createElementNS(SVG_NS, 'polygon'));
      this.svg.append(line, ...arrows);
      const label = document.createElement('span');
      label.className = 'dimension-label';
      label.textContent = s.label;
      this.el.append(label);
      return { line, arrows, label };
    });
  }

  /** Moves everything to the current camera (call every frame). */
  place(project: ProjectFn): void {
    this.specs.forEach((s, i) => {
      const part = this.parts[i];
      if (!part) return;
      const a = project(s.from);
      const b = project(s.to);
      const shown = a !== undefined && b !== undefined;
      part.label.hidden = !shown;
      const isLine = shown && Math.hypot(a.x - b.x, a.y - b.y) >= 1;
      for (const el of [part.line, ...part.arrows]) el.style.display = isLine ? '' : 'none';
      if (!shown) return;
      if (isLine) {
        part.line.setAttribute('x1', a.x.toFixed(1));
        part.line.setAttribute('y1', a.y.toFixed(1));
        part.line.setAttribute('x2', b.x.toFixed(1));
        part.line.setAttribute('y2', b.y.toFixed(1));
        const [ta, tb] = part.arrows;
        ta?.setAttribute('points', arrowPoints(a, b) ?? '');
        tb?.setAttribute('points', arrowPoints(b, a) ?? '');
      }
      const at = labelOffset(a, b, part.label.offsetWidth, part.label.offsetHeight);
      part.label.style.transform = `translate(${((a.x + b.x) / 2 + at.x).toFixed(1)}px, ${((a.y + b.y) / 2 + at.y).toFixed(1)}px) translate(-50%, -50%)`;
    });
  }

  /** Shown dimensions (tests): label text and whether it is on screen. */
  stats(): { label: string; shown: boolean }[] {
    return this.parts.map((p) => ({ label: p.label.textContent, shown: !p.label.hidden }));
  }

  dispose(): void {
    this.el.remove();
  }
}
