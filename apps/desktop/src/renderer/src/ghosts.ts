/**
 * Ghosts of markers the revision transfer could not place: where their lost parts were,
 * drawn as faint dots (painted points, vertices, face centres) and dashed lines (straight edges)
 * in the marker's colour. The points come from `transfer.ghost`, already in this model's frame
 * (the revision transfer moves them with their body). Pure: the viewport turns the result into three.js objects.
 */
import type { Marker } from './markers';
import { colorToHex } from './markers';

export interface GhostShape {
  readonly markerId: string;
  /** 0xrrggbb. */
  readonly color: number;
  /** XYZ per dot. */
  readonly points: readonly number[];
  /** XYZ pairs: straight lost edges. */
  readonly segments: readonly number[];
}

/** Painted points per ghost face drawn at most (a dense stroke is still readable thinned out). */
export const MAX_GHOST_POINTS_PER_FACE = 400;

/**
 * Ghost shapes of visible markers with a `transfer.ghost`. A part whose body (`fingerprint.body`)
 * is hidden is left out; one without a body is always drawn.
 */
export function ghostShapes(
  markers: readonly Marker[],
  bodyVisible: readonly boolean[] = [],
): GhostShape[] {
  const shown = (body: number | undefined): boolean =>
    body === undefined || bodyVisible[body] !== false;
  const out: GhostShape[] = [];
  for (const m of markers) {
    const ghost = m.transfer?.ghost;
    if (!ghost || !m.visible) continue;
    const points: number[] = [];
    const segments: number[] = [];
    for (const f of ghost.faces ?? []) {
      if (!shown(f.fingerprint?.body)) continue;
      const n = Math.floor(f.samples.length / 3); // flat x y z triples
      const step = Math.max(1, Math.ceil(n / MAX_GHOST_POINTS_PER_FACE));
      for (let i = 0; i < n; i += step)
        points.push(f.samples[i * 3] ?? 0, f.samples[i * 3 + 1] ?? 0, f.samples[i * 3 + 2] ?? 0);
    }
    for (const e of ghost.entities ?? []) {
      if (!shown(e.body) || !e.point) continue;
      const [x, y, z] = e.point;
      if (e.kind === 'edge' && e.type === 'line' && e.dir && e.length !== undefined) {
        // `point` is the midpoint along the edge.
        const [dx, dy, dz] = e.dir;
        const h = e.length / 2 / (Math.hypot(dx, dy, dz) || 1);
        segments.push(x - dx * h, y - dy * h, z - dz * h, x + dx * h, y + dy * h, z + dz * h);
      } else if (e.kind !== 'body') {
        points.push(x, y, z);
      }
    }
    if (points.length + segments.length === 0) continue;
    out.push({ markerId: m.id, color: colorToHex(m.color), points, segments });
  }
  return out;
}
