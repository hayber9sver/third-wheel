/**
 * Contact sheet: up to 4 region pictures in one image, so the AI gets several
 * places in one image request. Layout: 1 region → one 768² picture, 2 → side by side (768 × 384,
 * half the image tokens), 3–4 → 2 × 2 grid of 384² tiles. Tiles are split by thin grey lines and
 * numbered 1…4 in their top-left corner. Pure layout + pixel copying; the
 * drawing is `Viewport.renderContactSheet`.
 */

export const SHEET_WIDTH = 768;
export const MAX_SHEET_REGIONS = 4;
/** Divider between tiles (grey, drawn over the tiles' touching edges). */
export const DIVIDER = { px: 2, rgb: [150, 155, 165] } as const;

export interface SheetTile {
  /** Top-left corner in the sheet, px. */
  readonly x: number;
  readonly y: number;
}

export interface SheetLayout {
  readonly width: number;
  readonly height: number;
  /** Square tile size, px. */
  readonly tile: number;
  readonly tiles: readonly SheetTile[];
}

/** Grid for `count` regions (1…MAX_SHEET_REGIONS; more are an error). */
export function sheetLayout(count: number): SheetLayout {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHEET_REGIONS)
    throw new Error(
      `A contact sheet holds 1–${String(MAX_SHEET_REGIONS)} regions, got ${String(count)}`,
    );
  if (count === 1)
    return { width: SHEET_WIDTH, height: SHEET_WIDTH, tile: SHEET_WIDTH, tiles: [{ x: 0, y: 0 }] };
  const tile = SHEET_WIDTH / 2;
  const rows = count <= 2 ? 1 : 2;
  const tiles: SheetTile[] = [];
  for (let i = 0; i < count; i++) tiles.push({ x: (i % 2) * tile, y: Math.floor(i / 2) * tile });
  return { width: SHEET_WIDTH, height: rows * tile, tile, tiles };
}

/**
 * One RGBA image (top-down, white background) from tile pictures (each `layout.tile`² RGBA,
 * top-down, in `layout.tiles` order; undefined = left white), with dividers between tiles.
 */
export function composeSheet(
  layout: SheetLayout,
  pictures: readonly (Uint8Array | undefined)[],
): Uint8Array {
  const { width, height, tile } = layout;
  const out = new Uint8Array(width * height * 4).fill(255);
  layout.tiles.forEach((t, i) => {
    const pic = pictures[i];
    if (!pic) return;
    if (pic.length !== tile * tile * 4) throw new Error(`Tile ${String(i + 1)} has the wrong size`);
    for (let y = 0; y < tile; y++)
      out.set(pic.subarray(y * tile * 4, (y + 1) * tile * 4), ((t.y + y) * width + t.x) * 4);
  });
  const half = DIVIDER.px / 2;
  const paint = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        const o = (y * width + x) * 4;
        out[o] = DIVIDER.rgb[0];
        out[o + 1] = DIVIDER.rgb[1];
        out[o + 2] = DIVIDER.rgb[2];
        out[o + 3] = 255;
      }
  };
  if (layout.tiles.length > 1) paint(tile - half, 0, tile + half, height); // vertical
  if (height > tile) paint(0, tile - half, width, tile + half); // horizontal
  return out;
}

/** Label box size (px) and where tile `i`'s number sits. */
export const LABEL = { size: 22, margin: 6, font: 'bold 15px sans-serif' } as const;

/** Draws the tile numbers 1…n (white box, dark border and text) into a 2D context. */
export function drawTileLabels(ctx: OffscreenCanvasRenderingContext2D, layout: SheetLayout): void {
  if (layout.tiles.length < 2) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = LABEL.font;
  ctx.lineWidth = 1.5;
  layout.tiles.forEach((t, i) => {
    const x = t.x + LABEL.margin;
    const y = t.y + LABEL.margin;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, LABEL.size, LABEL.size);
    ctx.strokeStyle = '#1c1f24';
    ctx.strokeRect(x, y, LABEL.size, LABEL.size);
    ctx.fillStyle = '#1c1f24';
    ctx.fillText(String(i + 1), x + LABEL.size / 2, y + LABEL.size / 2 + 1);
  });
}
