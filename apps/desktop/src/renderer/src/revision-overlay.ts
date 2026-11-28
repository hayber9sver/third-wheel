/**
 * Revision view, drawn over the shown model:
 * - ghosts: where lost / "check" markers were (`ghosts.ts`), faint dots and dashed lines in the
 *   marker's colour; an emphasised marker (hovered row, highlighted comment) is drawn bold and on
 *   top, so it can be found behind other parts.
 * - compare: the previous version's changed faces see-through red with its changed edges, the new
 *   version's changed triangles tinted green (`version-diff.ts`).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Vector2,
  type Material,
  type Object3D,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { GhostShape } from './ghosts.js';
import type { VersionDiff } from './version-diff.js';

/** Previous version (see-through) and the new version's changed parts. */
export const COMPARE_COLORS = { old: 0xe5484d, new: 0x2fbf71 } as const;

const GHOST_POINT_PX = { normal: 5, bold: 8 } as const;
const GHOST_LINE_PX = { normal: 3, bold: 5 } as const;
const GHOST_OPACITY = { normal: 0.7, bold: 1 } as const;

export class RevisionOverlay {
  readonly root = new Group();
  private readonly ghostRoot = new Group();
  private readonly compareRoot = new Group();
  private ghosts: readonly GhostShape[] = [];
  private bold: ReadonlySet<string> = new Set();
  /** Canvas size in CSS px (fat dashed lines need it). */
  private readonly size = new Vector2(1, 1);

  constructor() {
    this.root.add(this.ghostRoot, this.compareRoot);
  }

  get ghostCount(): number {
    return this.ghosts.length;
  }

  get comparing(): boolean {
    return this.compareRoot.children.length > 0;
  }

  setViewport(size: Vector2): void {
    this.size.copy(size);
    for (const child of this.ghostRoot.children)
      if (child instanceof LineSegments2) child.material.resolution.copy(size);
  }

  setGhosts(shapes: readonly GhostShape[]): void {
    this.ghosts = shapes;
    this.buildGhosts();
  }

  /** Markers whose ghosts are drawn bold and on top. */
  setBold(markerIds: ReadonlySet<string>): void {
    const same =
      markerIds.size === this.bold.size && [...markerIds].every((id) => this.bold.has(id));
    if (same) return;
    this.bold = new Set(markerIds);
    this.buildGhosts();
  }

  private buildGhosts(): void {
    clear(this.ghostRoot);
    for (const g of this.ghosts) {
      const bold = this.bold.has(g.markerId);
      const look = {
        color: g.color,
        transparent: true,
        opacity: bold ? GHOST_OPACITY.bold : GHOST_OPACITY.normal,
        depthTest: !bold,
        depthWrite: false,
      };
      const order = bold ? 960 : 900;
      if (g.points.length > 0) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(g.points), 3));
        const points = new Points(
          geometry,
          new PointsMaterial({
            ...look,
            size: bold ? GHOST_POINT_PX.bold : GHOST_POINT_PX.normal,
            sizeAttenuation: false,
          }),
        );
        points.renderOrder = order;
        this.ghostRoot.add(points);
      }
      if (g.segments.length > 0) {
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(new Float32Array(g.segments));
        const material = new LineMaterial({
          ...look,
          linewidth: bold ? GHOST_LINE_PX.bold : GHOST_LINE_PX.normal,
          dashed: true,
          dashSize: 1.5,
          gapSize: 1,
        });
        material.resolution.copy(this.size);
        const lines = new LineSegments2(geometry, material);
        lines.computeLineDistances();
        lines.renderOrder = order + 1;
        this.ghostRoot.add(lines);
      }
    }
  }

  /** Compare with the previous version; undefined ends it. */
  setCompare(diff: VersionDiff | undefined): void {
    clear(this.compareRoot);
    if (!diff) return;
    if (diff.oldTriangles.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(diff.oldTriangles, 3));
      const mesh = new Mesh(
        geometry,
        new MeshBasicMaterial({
          color: COMPARE_COLORS.old,
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
          side: 2, // DoubleSide: removed material is seen from inside too
        }),
      );
      mesh.renderOrder = 800;
      this.compareRoot.add(mesh);
    }
    if (diff.oldEdges.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(diff.oldEdges, 3));
      const lines = new LineSegments(
        geometry,
        new LineBasicMaterial({
          color: COMPARE_COLORS.old,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      );
      lines.renderOrder = 801;
      this.compareRoot.add(lines);
    }
    if (diff.newTriangles.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(diff.newTriangles, 3));
      const mesh = new Mesh(
        geometry,
        new MeshBasicMaterial({
          color: COMPARE_COLORS.new,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      mesh.renderOrder = 802;
      this.compareRoot.add(mesh);
    }
  }

  dispose(): void {
    clear(this.ghostRoot);
    clear(this.compareRoot);
    this.ghosts = [];
  }
}

/** Removes and frees every child. */
function clear(group: Group): void {
  for (const child of [...group.children] as (Object3D & {
    geometry?: BufferGeometry;
    material?: Material;
  })[]) {
    group.remove(child);
    child.geometry?.dispose();
    child.material?.dispose();
  }
}
