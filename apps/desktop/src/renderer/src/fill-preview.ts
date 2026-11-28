/**
 * Smart fill hover preview: the region a click would fill, tinted in the active marker's
 * colour (red when the click would erase). One mesh sharing the model's vertex buffers, drawn
 * over the faces and the paint.
 */
import { BufferAttribute, BufferGeometry, LessEqualDepth, Mesh, MeshBasicMaterial } from 'three';

export const FILL_PREVIEW_OPACITY = 0.45;

export class FillPreview {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private shown: Uint32Array | undefined;

  /** `position`: the model's attribute (shared). `indices`: the import's index buffer. */
  constructor(
    position: BufferAttribute,
    private readonly indices: Uint32Array,
  ) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setIndex(new BufferAttribute(new Uint32Array(0), 1));
    this.mesh = new Mesh(
      geometry,
      new MeshBasicMaterial({
        transparent: true,
        opacity: FILL_PREVIEW_OPACITY,
        depthWrite: false,
        depthFunc: LessEqualDepth,
        // Pulled slightly in front of the faces (offset 1) like the selection highlight: with the
        // faces' own offset its depth didn't match theirs and it was hidden.
        polygonOffset: true,
        polygonOffsetFactor: 0.5,
        polygonOffsetUnits: 0.5,
      }),
    );
    this.mesh.renderOrder = 2; // after faces (0) and paint (1)
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Show `triangles` (import ids) in `color` (0xrrggbb). Rebuilds only for a new region. */
  show(triangles: Uint32Array, color: number): void {
    this.mesh.material.color.setHex(color);
    this.mesh.visible = triangles.length > 0;
    if (triangles === this.shown) return;
    this.shown = triangles;
    const index = new Uint32Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i] ?? 0;
      index[i * 3] = this.indices[t * 3] ?? 0;
      index[i * 3 + 1] = this.indices[t * 3 + 1] ?? 0;
      index[i * 3 + 2] = this.indices[t * 3 + 2] ?? 0;
    }
    this.mesh.geometry.setIndex(new BufferAttribute(index, 1));
  }

  hide(): void {
    this.mesh.visible = false;
  }

  /** Triangles shown now (0 when hidden). */
  shownTriangles(): number {
    return this.mesh.visible ? (this.shown?.length ?? 0) : 0;
  }

  dispose(): void {
    // Shares position with the model's faces: dispose only together with the model.
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
