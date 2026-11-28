/**
 * Hover + selection highlight in the viewport. Two layers — selection, then hover on top —
 * each with a tinted face mesh, thick edge lines (screen-space width, three's LineSegments2) and
 * round vertex dots. Each layer owns small copies of its geometry (sharing the model's buffers
 * would free them on dispose) and rebuilds them only when its items change.
 *
 * Depth: the shown faces use polygon offset 1/1; highlight faces use 0.5/0.5, so they cover the
 * shown face but B-rep edge lines (offset 0) still draw on top. Hover is drawn after selection.
 *
 * Ghost: parts of a highlight hidden behind other geometry are drawn again,
 * faint and see-through (depth test "greater" = only where something is in front), plus a
 * body's B-rep edges as a thin outline — so an obstructed selection is still visible.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  GreaterDepth,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  ShaderMaterial,
  type Vector2,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { ResolvedTheme } from '../../shared/theme.js';
import {
  faceTriangles,
  highlightBuffers,
  highlightSphere,
  triangleVertexIndices,
  type FaceTriangles,
  type HighlightBuffers,
  type HighlightModel,
} from './highlight-buffers.js';
import type { BoundingSphere } from './camera-views.js';
import type { SelectionItem } from './selection.js';

export type HighlightLayer = 'selection' | 'hover';

interface LayerColors {
  face: number;
  edge: number;
}

/** Hover is lighter than selection so a hovered selected item still visibly reacts. */
const COLORS: Record<ResolvedTheme, Record<HighlightLayer, LayerColors>> = {
  light: {
    selection: { face: 0x4f86f0, edge: 0x1747b8 },
    hover: { face: 0x9cc2ff, edge: 0x2f80ff },
  },
  dark: {
    selection: { face: 0x4f86f0, edge: 0x8ab4ff },
    hover: { face: 0x8fb6ff, edge: 0xb8d3ff },
  },
};

const EDGE_WIDTH_PX: Record<HighlightLayer, number> = { selection: 3, hover: 3.5 };
const VERTEX_DOT_PX: Record<HighlightLayer, number> = { selection: 9, hover: 11 };

const DOT_VERTEX = /* glsl */ `
  uniform float size;
  void main() {
    gl_PointSize = size;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const DOT_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    // Thin dark rim so the dot reads on a highlighted face of the same colour.
    gl_FragColor = vec4(r > 0.55 ? color * 0.45 : color, 1.0);
  }
`;

/** Opacity of the see-through ghost of hidden highlight parts. */
const GHOST_OPACITY = { faces: 0.22, lines: 0.55 };

interface Layer {
  readonly faces: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly edges: LineSegments2;
  readonly edgeMaterial: LineMaterial;
  readonly dots: Points<BufferGeometry, ShaderMaterial>;
  /** Ghost passes; share geometry with the objects above (outline has its own). */
  readonly ghostFaces: Mesh<BufferGeometry, MeshBasicMaterial>;
  readonly ghostEdges: LineSegments2;
  readonly ghostEdgeMaterial: LineMaterial;
  readonly ghostOutline: LineSegments<BufferGeometry, LineBasicMaterial>;
  items: readonly SelectionItem[];
}

const ghostLook = {
  transparent: true,
  depthWrite: false,
  depthFunc: GreaterDepth,
} as const;

export class Highlighter {
  readonly root = new Group();
  /** Triangles per face (also used by box select). */
  readonly faceTris: FaceTriangles;
  private readonly layers: Record<HighlightLayer, Layer>;
  private visible: readonly boolean[] = [];

  constructor(private readonly model: HighlightModel & { readonly normals: Float32Array }) {
    this.faceTris = faceTriangles(model.triangleFace, model.faceBody.length);
    this.layers = { selection: this.makeLayer('selection'), hover: this.makeLayer('hover') };
  }

  private makeLayer(layer: HighlightLayer): Layer {
    const order = layer === 'hover' ? 20 : 10;
    const faces = new Mesh(
      new BufferGeometry(),
      new MeshStandardMaterial({
        metalness: 0.05,
        roughness: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: 0.5,
        polygonOffsetUnits: 0.5,
      }),
    );
    faces.renderOrder = order;
    const edgeMaterial = new LineMaterial({ linewidth: EDGE_WIDTH_PX[layer] });
    const edges = new LineSegments2(new LineSegmentsGeometry(), edgeMaterial);
    edges.renderOrder = order + 1;
    const dots = new Points(
      new BufferGeometry(),
      new ShaderMaterial({
        vertexShader: DOT_VERTEX,
        fragmentShader: DOT_FRAGMENT,
        uniforms: { size: { value: VERTEX_DOT_PX[layer] }, color: { value: new Color() } },
        // Always on top: a hovered vertex was just picked (visible), and a selected one hidden
        // behind other parts should still be findable (vertices have no other ghost).
        depthTest: false,
      }),
    );
    dots.renderOrder = order + 2;
    // Ghost passes draw last, after all opaque geometry has filled the depth buffer.
    const ghostFaces = new Mesh(
      faces.geometry,
      new MeshBasicMaterial({ ...ghostLook, opacity: GHOST_OPACITY.faces }),
    );
    ghostFaces.renderOrder = order + 100;
    const ghostEdgeMaterial = new LineMaterial({
      ...ghostLook,
      linewidth: EDGE_WIDTH_PX[layer] - 1,
      opacity: GHOST_OPACITY.lines,
    });
    const ghostEdges = new LineSegments2(edges.geometry, ghostEdgeMaterial);
    ghostEdges.renderOrder = order + 101;
    const ghostOutline = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ ...ghostLook, opacity: GHOST_OPACITY.lines }),
    );
    ghostOutline.renderOrder = order + 102;
    for (const obj of [faces, edges, dots, ghostFaces, ghostEdges, ghostOutline]) {
      obj.visible = false;
      obj.frustumCulled = false;
    }
    this.root.add(faces, edges, dots, ghostFaces, ghostEdges, ghostOutline);
    return {
      faces,
      edges,
      edgeMaterial,
      dots,
      ghostFaces,
      ghostEdges,
      ghostEdgeMaterial,
      ghostOutline,
      items: [],
    };
  }

  /** Replace the highlighted items of one layer. */
  set(layer: HighlightLayer, items: readonly SelectionItem[]): void {
    this.layers[layer].items = items;
    this.rebuild(layer);
  }

  /** Body visibility as in `Viewport.setBodyVisibility` (missing = visible). */
  setBodyVisibility(visible: readonly boolean[]): void {
    this.visible = visible;
    this.rebuild('selection');
    this.rebuild('hover');
  }

  setTheme(theme: ResolvedTheme): void {
    for (const layer of ['selection', 'hover'] as const) {
      const c = COLORS[theme][layer];
      const l = this.layers[layer];
      l.faces.material.color.setHex(c.face);
      l.edgeMaterial.color.setHex(c.edge);
      l.ghostFaces.material.color.setHex(c.face);
      l.ghostEdgeMaterial.color.setHex(c.edge);
      l.ghostOutline.material.color.setHex(c.edge);
      (l.dots.material.uniforms['color']?.value as Color).setHex(c.edge);
    }
  }

  /** Canvas size in CSS px and device pixel ratio (line widths and dots are in CSS px). */
  setViewport(size: Vector2, pixelRatio: number): void {
    for (const layer of ['selection', 'hover'] as const) {
      const l = this.layers[layer];
      l.edgeMaterial.resolution.copy(size);
      l.ghostEdgeMaterial.resolution.copy(size);
      const u = l.dots.material.uniforms['size'];
      if (u) u.value = VERTEX_DOT_PX[layer] * pixelRatio;
    }
  }

  /** Bounding sphere of `items` (visible ones), for zoom-to-selection. */
  sphereOf(
    items: readonly SelectionItem[],
    triangles: ArrayLike<number> = [],
  ): BoundingSphere | undefined {
    return highlightSphere(this.buffersOf(items, triangles), this.model.positions);
  }

  private vertexFaceCache: Uint32Array | undefined;
  /** B-rep face per vertex (OCCT meshes each face with its own vertices); built on first use. */
  get vertexFace(): Uint32Array {
    if (!this.vertexFaceCache) {
      const { indices, triangleFace, positions } = this.model;
      const out = new Uint32Array(positions.length / 3);
      for (let i = 0; i < indices.length; i++) {
        out[indices[i] ?? 0] = triangleFace[Math.floor(i / 3)] ?? 0;
      }
      this.vertexFaceCache = out;
    }
    return this.vertexFaceCache;
  }

  /**
   * Highlight buffers of `items` plus import `triangles` (painted ones), visible bodies only —
   * for framing and comment pin anchors.
   */
  buffersOf(items: readonly SelectionItem[], triangles: ArrayLike<number> = []): HighlightBuffers {
    const buffers = highlightBuffers(items, this.model, this.faceTris, this.visible);
    if (triangles.length === 0) return buffers;
    const { triangleFace, faceBody } = this.model;
    const shown: number[] = [];
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i] ?? 0;
      if (this.visible[faceBody[triangleFace[t] ?? 0] ?? 0] !== false) shown.push(t);
    }
    const extra = triangleVertexIndices(shown, this.model.indices);
    const indices = new Uint32Array(buffers.indices.length + extra.length);
    indices.set(buffers.indices);
    indices.set(extra, buffers.indices.length);
    return { ...buffers, indices };
  }

  private rebuild(layer: HighlightLayer): void {
    const l = this.layers[layer];
    const b = highlightBuffers(l.items, this.model, this.faceTris, this.visible);

    l.faces.geometry.dispose();
    l.faces.geometry = this.faceGeometry(b.indices);
    l.ghostFaces.geometry = l.faces.geometry;
    l.faces.visible = l.ghostFaces.visible = b.indices.length > 0;

    // LineSegmentsGeometry keeps its instance count from the first setPositions: use a fresh one.
    l.edges.geometry.dispose();
    const edgeGeometry = new LineSegmentsGeometry();
    if (b.edgeSegments.length) edgeGeometry.setPositions(b.edgeSegments);
    l.edges.geometry = l.ghostEdges.geometry = edgeGeometry;
    l.edges.visible = l.ghostEdges.visible = b.edgeSegments.length > 0;

    l.ghostOutline.geometry.dispose();
    const outline = new BufferGeometry();
    outline.setAttribute('position', new BufferAttribute(b.outlineSegments, 3));
    l.ghostOutline.geometry = outline;
    l.ghostOutline.visible = b.outlineSegments.length > 0;

    l.dots.geometry.dispose();
    const dotGeometry = new BufferGeometry();
    dotGeometry.setAttribute('position', new BufferAttribute(b.points, 3));
    l.dots.geometry = dotGeometry;
    l.dots.visible = b.points.length > 0;
  }

  /** Non-indexed copy of the given triangles (positions + normals). */
  private faceGeometry(indices: Uint32Array): BufferGeometry {
    const { positions, normals } = this.model;
    const pos = new Float32Array(indices.length * 3);
    const nor = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      const v = (indices[i] ?? 0) * 3;
      for (let k = 0; k < 3; k++) {
        pos[i * 3 + k] = positions[v + k] ?? 0;
        nor[i * 3 + k] = normals[v + k] ?? 0;
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nor, 3));
    return g;
  }

  dispose(): void {
    for (const layer of ['selection', 'hover'] as const) {
      const l = this.layers[layer];
      l.faces.geometry.dispose();
      l.faces.material.dispose();
      l.edges.geometry.dispose();
      l.edgeMaterial.dispose();
      l.dots.geometry.dispose();
      l.dots.material.dispose();
      l.ghostFaces.material.dispose();
      l.ghostEdgeMaterial.dispose();
      l.ghostOutline.geometry.dispose();
      l.ghostOutline.material.dispose();
    }
  }
}
