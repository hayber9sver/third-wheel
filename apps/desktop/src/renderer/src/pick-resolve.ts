/**
 * Reading the GPU ID buffer, pure. The pick pass renders a small square around the cursor
 * where every pixel holds an entity: RGB = 24-bit id (R = low byte), A = kind (0 = background).
 * Faces are drawn first, then edges, then vertices, each depth-tested — so what is left in a
 * pixel is the frontmost entity of the highest priority there.
 */

export type EntityKind = 'vertex' | 'edge' | 'face';

/** Alpha byte per kind in the ID buffer. 0 = nothing drawn. */
export const KIND_CODE: Readonly<Record<EntityKind, number>> = { face: 1, edge: 2, vertex: 3 };

/** Ids must fit in 24 bits (RGB). */
export const MAX_PICK_ID = 0xffffff;

export interface EntityRef {
  readonly kind: EntityKind;
  readonly id: number;
}

/** RGBA bytes for an entity, as the pick shader writes them (for tests and docs). */
export function encodePick(kind: EntityKind, id: number): [number, number, number, number] {
  return [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, KIND_CODE[kind]];
}

/**
 * Entity under the centre of a `size`×`size` RGBA pixel block (`size` odd, centre = cursor).
 * Priority: the nearest vertex within `radius` px, else the nearest edge within `radius`, else the
 * face at the centre pixel. Distances are between pixel centres, in the block's pixels.
 */
export function resolvePick(
  pixels: Uint8Array,
  size: number,
  radius: number,
): EntityRef | undefined {
  const c = (size - 1) / 2;
  const r2 = radius * radius;
  let best: { code: number; d2: number; offset: number } | undefined;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const code = pixels[o + 3] ?? 0;
      if (code !== KIND_CODE.vertex && code !== KIND_CODE.edge) continue;
      const d2 = (x - c) * (x - c) + (y - c) * (y - c);
      if (d2 > r2) continue;
      if (!best || code > best.code || (code === best.code && d2 < best.d2))
        best = { code, d2, offset: o };
    }
  }
  const centre = (Math.floor(c) * size + Math.floor(c)) * 4;
  const offset = best?.offset ?? ((pixels[centre + 3] ?? 0) === KIND_CODE.face ? centre : -1);
  if (offset < 0) return undefined;
  const code = pixels[offset + 3] ?? 0;
  const kind: EntityKind =
    code === KIND_CODE.vertex ? 'vertex' : code === KIND_CODE.edge ? 'edge' : 'face';
  const id =
    (pixels[offset] ?? 0) | ((pixels[offset + 1] ?? 0) << 8) | ((pixels[offset + 2] ?? 0) << 16);
  return { kind, id };
}
