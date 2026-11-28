/**
 * Paint drawn over the model: one mesh sharing the model's vertex buffers, whose index
 * holds the whole-painted triangles grouped by marker (one material per marker), and one small
 * mesh of its own for the pieces of cut triangles (positions and smooth normals
 * interpolated from the triangle's vertices). Rebuilt at most once per frame when the paint,
 * marker colours/visibility or body visibility changed; a paint change reads only the blocks of
 * triangles it touched and joins the cached rest.
 */
import {
  BufferAttribute,
  BufferGeometry,
  LessEqualDepth,
  Mesh,
  MeshStandardMaterial,
  type Camera,
  type Material,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { forEachPiece, PAINT_BLOCK, type PaintLayer, type PaintNode } from './paint.js';

interface PieceChunk {
  readonly node: PaintNode;
  readonly bySlot: ReadonlyMap<number, { readonly pos: Float32Array; readonly nor: Float32Array }>;
}

/** What one block of `PAINT_BLOCK` triangles draws, by marker slot. */
interface Block {
  /** The layer's stamp this was built from (`PaintLayer.blockEdit`). */
  readonly edit: number;
  /** Per slot: vertex indices of its whole-painted triangles (3 per triangle). */
  readonly whole: ReadonlyMap<number, Uint32Array>;
  /** Per slot: pieces of the block's cut triangles (positions, normals; 9 floats per piece). */
  readonly pieces: ReadonlyMap<number, { readonly pos: Float32Array; readonly nor: Float32Array }>;
  /** Cut triangles drawn (shown bodies) with their pieces, by triangle (reused while unchanged). */
  readonly chunks: ReadonlyMap<number, PieceChunk>;
}

/** Material cache key of the shader warm-up (never a marker id: those are `m1`, `m2`…). */
const WARM_ID = '\u0000warm';

export interface MarkerStyle {
  readonly id: string;
  /** 0xrrggbb */
  readonly color: number;
  readonly visible: boolean;
  /** Resolved marker shown by "Show resolved": drawn faded unless its comment is highlighted. */
  readonly fade?: boolean;
}

/** Marker paint strength while comparing versions: the red / green diff shows through. */
export const FADED_PAINT_OPACITY = 0.25;

export class PaintOverlay {
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial[]>;
  /** Pieces of cut triangles (own vertices). */
  readonly pieceMesh: Mesh<BufferGeometry, MeshStandardMaterial[]>;
  private readonly materials = new Map<string, MeshStandardMaterial>();
  private readonly pieceMaterials = new Map<string, MeshStandardMaterial>();
  private builtKey = '';
  /** Layer and body visibility the blocks were built for (either changes → all rebuilt). */
  private builtLayer: PaintLayer | undefined;
  private builtVisible = '';
  private blocks: (Block | undefined)[] = [];
  /** Slots drawn in the last build. */
  private shownSlots = new Set<number>();
  /** Whole-painted triangles drawn in the last build. */
  private shownWhole = 0;
  /** Pieces drawn in the last build. */
  shownPieces = 0;

  /**
   * `position` / `normal`: the model's attributes (shared, not copied). `indices`: the import's
   * index buffer (triangle t = indices[3t..3t+2]). `triBody`: body per import triangle.
   */
  constructor(
    private readonly position: BufferAttribute,
    private readonly normal: BufferAttribute,
    private readonly indices: Uint32Array,
    private readonly triBody: Uint32Array,
  ) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setIndex(new BufferAttribute(new Uint32Array(0), 1));
    this.mesh = new Mesh(geometry, []);
    // Same depth (and same polygon offset) as the faces it covers, drawn after them.
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.pieceMesh = new Mesh(new BufferGeometry(), []);
    this.pieceMesh.renderOrder = 1;
    this.pieceMesh.frustumCulled = false;
    this.pieceMesh.visible = false;
  }

  /** Import triangles drawn (whole or some pieces) in the last build. */
  get shownTriangles(): number {
    let cut = 0;
    for (const block of this.blocks)
      if (block)
        for (const chunk of block.chunks.values())
          for (const slot of chunk.bySlot.keys())
            if (this.shownSlots.has(slot)) {
              cut++;
              break;
            }
    return this.shownWhole + cut;
  }

  /**
   * Rebuild when anything it shows changed since the last call; only blocks whose paint changed
   * are read again. Returns the build time in ms.
   */
  update(layer: PaintLayer, styles: readonly MarkerStyle[], visible: readonly boolean[]): number {
    const visibleKey = visible.join(',');
    const key = `${String(layer.version)}|${JSON.stringify(styles)}|${visibleKey}`;
    if (key === this.builtKey && layer === this.builtLayer) return 0;
    this.builtKey = key;
    const t0 = performance.now();
    if (layer !== this.builtLayer || visibleKey !== this.builtVisible) {
      this.builtLayer = layer;
      this.builtVisible = visibleKey;
      this.blocks = [];
    }
    const triBody = this.triBody;
    const include = visible.includes(false)
      ? (t: number) => visible[triBody[t] ?? 0] !== false
      : undefined;
    for (let b = 0; b < layer.blockCount; b++) {
      const edit = layer.blockEdit(b);
      const block = this.blocks[b];
      if (block ? block.edit !== edit : edit !== 0)
        this.blocks[b] = this.buildBlock(layer, b, edit, include);
    }

    const shown: { style: MarkerStyle; slot: number }[] = [];
    for (const style of styles) {
      const slot = style.visible ? layer.slotOfMarker(style.id) : undefined;
      if (slot !== undefined) shown.push({ style, slot });
    }
    this.shownSlots = new Set(shown.map((s) => s.slot));
    this.shownWhole = this.fillWhole(shown) / 3;
    this.shownPieces = this.fillPieces(shown) / 9;
    return performance.now() - t0;
  }

  /** Whole triangles of the shown markers into the index, one draw group per marker. Returns the index count. */
  private fillWhole(shown: readonly { style: MarkerStyle; slot: number }[]): number {
    let total = 0;
    for (const { slot } of shown)
      for (const block of this.blocks) total += block?.whole.get(slot)?.length ?? 0;
    const index = this.indexFor(total);
    const geometry = this.mesh.geometry;
    geometry.clearGroups();
    const materials: Material[] = [];
    let at = 0;
    for (const { style, slot } of shown) {
      const start = at;
      for (const block of this.blocks) {
        const list = block?.whole.get(slot);
        if (!list) continue;
        index.set(list, at);
        at += list.length;
      }
      if (at === start) continue;
      geometry.addGroup(start, at - start, materials.length);
      materials.push(this.material(style));
    }
    const attr = geometry.getIndex();
    if (attr?.array !== index) geometry.setIndex(new BufferAttribute(index, 1));
    else if (at > 0) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, at);
      attr.needsUpdate = true;
    }
    this.mesh.material = materials as MeshStandardMaterial[];
    this.mesh.visible = at > 0;
    return at;
  }

  /**
   * Index array with room for `count` entries. Grows (doubling) but is otherwise reused: a new
   * index attribute is a new GPU buffer, and three.js frees a replaced one only with the whole
   * geometry — which shares the model's position / normal buffers. The
   * draw groups cover only the filled part.
   */
  private indexFor(count: number): Uint32Array {
    const cur = this.mesh.geometry.getIndex()?.array;
    if (cur instanceof Uint32Array && cur.length >= count) return cur;
    return new Uint32Array(Math.max(count, (cur?.length ?? 0) * 2, 1024));
  }

  /**
   * Pieces of the shown markers into `pieceMesh`, one draw group per marker. Its buffers are
   * reused while they fit (only the filled part is uploaded); when they grow (doubling) the
   * geometry is replaced — it owns its buffers, so disposing the old one frees them. Returns
   * the float count.
   */
  private fillPieces(shown: readonly { style: MarkerStyle; slot: number }[]): number {
    let total = 0;
    for (const { slot } of shown)
      for (const block of this.blocks) total += block?.pieces.get(slot)?.pos.length ?? 0;
    let geometry = this.pieceMesh.geometry;
    let posAttr = geometry.getAttribute('position') as BufferAttribute | undefined;
    let norAttr = geometry.getAttribute('normal') as BufferAttribute | undefined;
    const fits = posAttr !== undefined && posAttr.array.length >= total;
    if (!fits) {
      const size = Math.max(total, (posAttr?.array.length ?? 0) * 2, 9 * 1024);
      geometry.dispose();
      geometry = new BufferGeometry();
      posAttr = new BufferAttribute(new Float32Array(size), 3);
      norAttr = new BufferAttribute(new Float32Array(size), 3);
      geometry.setAttribute('position', posAttr);
      geometry.setAttribute('normal', norAttr);
      this.pieceMesh.geometry = geometry;
    }
    if (!posAttr || !norAttr) return 0;
    const pos = posAttr.array as Float32Array;
    const nor = norAttr.array as Float32Array;
    geometry.clearGroups();
    const materials: Material[] = [];
    let at = 0;
    for (const { style, slot } of shown) {
      const start = at;
      for (const block of this.blocks) {
        const part = block?.pieces.get(slot);
        if (!part) continue;
        pos.set(part.pos, at);
        nor.set(part.nor, at);
        at += part.pos.length;
      }
      if (at === start) continue;
      geometry.addGroup(start / 3, (at - start) / 3, materials.length);
      materials.push(this.material(style, true));
    }
    if (fits && at > 0)
      for (const attr of [posAttr, norAttr]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, at);
        attr.needsUpdate = true;
      }
    this.pieceMesh.material = materials as MeshStandardMaterial[];
    this.pieceMesh.visible = at > 0;
    return at;
  }

  /**
   * Reads block `b` of the layer: whole triangles by slot, and the pieces of its cut triangles
   * (a cut triangle whose pieces are the same object as in the old block is reused).
   */
  private buildBlock(
    layer: PaintLayer,
    b: number,
    edit: number,
    include: ((t: number) => boolean) | undefined,
  ): Block {
    const old = this.blocks[b]?.chunks;
    const owner = layer.owner;
    const I = this.indices;
    const first = b * PAINT_BLOCK;
    const end = Math.min(owner.length, first + PAINT_BLOCK);
    const whole = new Map<number, number[]>();
    const chunks = new Map<number, PieceChunk>();
    const pieceLists = new Map<number, { pos: Float32Array[]; nor: Float32Array[]; n: number }>();
    for (let t = first; t < end; t++) {
      const o = owner[t] ?? 0;
      if (o === 0 || (include && !include(t))) continue;
      const node = layer.splitAt(t);
      if (node === undefined) {
        let list = whole.get(o);
        if (!list) whole.set(o, (list = []));
        list.push(I[t * 3] ?? 0, I[t * 3 + 1] ?? 0, I[t * 3 + 2] ?? 0);
        continue;
      }
      let chunk = old?.get(t);
      if (chunk?.node !== node) chunk = this.buildChunk(t, node);
      chunks.set(t, chunk);
      for (const [slot, part] of chunk.bySlot) {
        let list = pieceLists.get(slot);
        if (!list) pieceLists.set(slot, (list = { pos: [], nor: [], n: 0 }));
        list.pos.push(part.pos);
        list.nor.push(part.nor);
        list.n += part.pos.length;
      }
    }
    const pieces = new Map<number, { pos: Float32Array; nor: Float32Array }>();
    for (const [slot, list] of pieceLists) {
      const pos = new Float32Array(list.n);
      const nor = new Float32Array(list.n);
      let at = 0;
      list.pos.forEach((p, i) => {
        pos.set(p, at);
        nor.set(list.nor[i] ?? p, at);
        at += p.length;
      });
      pieces.set(slot, { pos, nor });
    }
    return {
      edit,
      whole: new Map([...whole].map(([slot, list]) => [slot, Uint32Array.from(list)])),
      pieces,
      chunks,
    };
  }

  /** Vertices (positions, smooth normals) of triangle `t`'s pieces, by slot (unpainted skipped). */
  private buildChunk(t: number, node: PaintNode): PieceChunk {
    const P = this.position.array;
    const N = this.normal.array;
    const I = this.indices;
    const ia = (I[t * 3] ?? 0) * 3;
    const ib = (I[t * 3 + 1] ?? 0) * 3;
    const ic = (I[t * 3 + 2] ?? 0) * 3;
    const lists = new Map<number, { pos: number[]; nor: number[] }>();
    const corner = (list: { pos: number[]; nor: number[] }, u: number, v: number): void => {
      const w = 1 - u - v;
      for (let d = 0; d < 3; d++)
        list.pos.push(w * (P[ia + d] ?? 0) + u * (P[ib + d] ?? 0) + v * (P[ic + d] ?? 0));
      const nx = w * (N[ia] ?? 0) + u * (N[ib] ?? 0) + v * (N[ic] ?? 0);
      const ny = w * (N[ia + 1] ?? 0) + u * (N[ib + 1] ?? 0) + v * (N[ic + 1] ?? 0);
      const nz = w * (N[ia + 2] ?? 0) + u * (N[ib + 2] ?? 0) + v * (N[ic + 2] ?? 0);
      const len = Math.hypot(nx, ny, nz) || 1;
      list.nor.push(nx / len, ny / len, nz / len);
    };
    forEachPiece(node, (slot, u0, v0, u1, v1, u2, v2) => {
      if (slot === 0) return;
      let list = lists.get(slot);
      if (!list) {
        list = { pos: [], nor: [] };
        lists.set(slot, list);
      }
      corner(list, u0, v0);
      corner(list, u1, v1);
      corner(list, u2, v2);
    });
    const bySlot = new Map<number, { pos: Float32Array; nor: Float32Array }>();
    for (const [slot, l] of lists)
      bySlot.set(slot, { pos: Float32Array.from(l.pos), nor: Float32Array.from(l.nor) });
    return { node, bySlot };
  }

  /**
   * Compiles the paint shader before the first stroke (cold, the first painted frame took
   * ~16 ms more). Programs depend only on the material settings and attributes, so a
   * kept warm-up material (same settings as the marker ones) on a one-triangle mesh is enough.
   * `scene`: where the overlay is drawn (its lights are part of the shader).
   */
  warm(renderer: WebGLRenderer, scene: Scene, camera: Camera): Promise<unknown> {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    );
    const material = this.material({ id: WARM_ID, color: 0, visible: true });
    const probe = new Mesh(geometry, material);
    return renderer.compileAsync(probe, camera, scene).finally(() => {
      geometry.dispose(); // the material stays (cached), so its program is kept
    });
  }

  /** Forget the last build (next `update` rebuilds everything). */
  invalidate(): void {
    this.builtKey = '';
    this.builtLayer = undefined;
  }

  /**
   * Whole triangles: the faces' own vertices and polygon offset (1), `LessEqual` → same depth.
   * Pieces have interpolated vertices whose depth differs by rounding, so they sit a little in
   * front (offset 0.5, like the highlighter) instead of z-fighting with the face.
   */
  private material(style: MarkerStyle, piece = false): MeshStandardMaterial {
    const cache = piece ? this.pieceMaterials : this.materials;
    let m = cache.get(style.id);
    if (!m) {
      m = new MeshStandardMaterial({
        metalness: 0.05,
        roughness: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: piece ? 0.5 : 1,
        polygonOffsetUnits: piece ? 0.5 : 1,
        depthFunc: LessEqualDepth,
      });
      cache.set(style.id, m);
    }
    m.color.setHex(style.color);
    this.applyFade(m);
    return m;
  }

  /** Paint at {@link FADED_PAINT_OPACITY} (Compare) or solid. */
  private faded = false;
  setFaded(on: boolean): void {
    if (this.faded === on) return;
    this.faded = on;
    for (const m of [...this.materials.values(), ...this.pieceMaterials.values()])
      this.applyFade(m);
  }

  private applyFade(m: MeshStandardMaterial): void {
    const opacity = this.faded ? FADED_PAINT_OPACITY : 1;
    if (m.opacity === opacity) return;
    m.transparent = this.faded;
    m.opacity = opacity;
    m.depthWrite = !this.faded;
    m.needsUpdate = true; // transparent switches the shader variant
  }

  dispose(): void {
    // Shares position/normal with the model's faces: dispose only together with the model.
    this.mesh.geometry.dispose();
    this.pieceMesh.geometry.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.pieceMaterials.values()) m.dispose();
    this.materials.clear();
    this.pieceMaterials.clear();
    this.blocks = [];
  }
}
