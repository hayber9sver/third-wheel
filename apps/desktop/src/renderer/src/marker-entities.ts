/**
 * Marker entities in the viewport: the exact vertices / edges / faces / bodies markers hold,
 * drawn in their marker's colour, so they read differently from paint (solid colour):
 * - face: see-through tint + thick outline along its border;
 * - body: fainter tint + its B-rep edges as thin lines;
 * - edge: thick line; vertex: round dot (always on top, like selected vertices).
 * Entities of hidden bodies are left out. The selection highlight draws over all of this.
 *
 * `markerEntityBuffers` is pure (tested); `MarkerEntitiesOverlay` turns it into three.js objects.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LessEqualDepth,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
  type Vector2,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { FaceTriangles, HighlightModel } from './highlight-buffers.js';
import type { ShownEntity } from './markers.js';

/** Tint opacity: a face entity, and each face of a body entity. */
export const TINT_ALPHA = { face: 0.4, body: 0.22 } as const;
const LINE_PX = 3;
const BODY_LINE_PX = 1.5;
const DOT_PX = 9;

export interface MarkerEntityBuffers {
  /** Non-indexed XYZ triangles of tinted faces. */
  readonly tintPositions: Float32Array;
  /** RGBA per tint vertex. */
  readonly tintColors: Float32Array;
  /** XYZ pairs: edge entities and face outlines (thick). */
  readonly lines: Float32Array;
  /** RGB per line point (two per segment). */
  readonly lineColors: Float32Array;
  /** XYZ pairs: B-rep edges of body entities (thin). */
  readonly bodyLines: Float32Array;
  readonly bodyLineColors: Float32Array;
  /** XYZ per vertex entity. */
  readonly points: Float32Array;
  readonly pointColors: Float32Array;
}

function rgbOf(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Grows a float array without knowing the final size (typed copy at the end). */
class Floats {
  private data: number[] = [];
  push(...values: number[]): void {
    for (const v of values) this.data.push(v);
  }
  pushFrom(src: ArrayLike<number>, start: number, count: number): void {
    for (let i = 0; i < count; i++) this.data.push(src[start + i] ?? 0);
  }
  get length(): number {
    return this.data.length;
  }
  done(): Float32Array {
    return Float32Array.from(this.data);
  }
}

export function markerEntityBuffers(
  entities: readonly ShownEntity[],
  model: HighlightModel,
  faceTris: FaceTriangles,
  visible: readonly boolean[] = [],
): MarkerEntityBuffers {
  const shown = (body: number | undefined): boolean =>
    body !== undefined && (visible[body] ?? true);
  const tint = new Floats();
  const tintColors = new Floats();
  const lines = new Floats();
  const lineColors = new Floats();
  const bodyLines = new Floats();
  const bodyLineColors = new Floats();
  const points = new Floats();
  const pointColors = new Floats();
  const faceCount = model.faceBody.length;

  const addTint = (face: number, rgb: [number, number, number], alpha: number): void => {
    for (let i = faceTris.start[face] ?? 0; i < (faceTris.start[face + 1] ?? 0); i++) {
      const t = faceTris.tris[i] ?? 0;
      for (let k = 0; k < 3; k++) {
        tint.pushFrom(model.positions, (model.indices[t * 3 + k] ?? 0) * 3, 3);
        tintColors.push(...rgb, alpha);
      }
    }
  };
  const addEdge = (e: number, rgb: [number, number, number], out: Floats, colors: Floats): void => {
    const first = model.edgeRanges[e * 2] ?? 0;
    const n = model.edgeRanges[e * 2 + 1] ?? 0;
    for (let i = 0; i + 1 < n; i++) {
      out.pushFrom(model.edgePoints, (first + i) * 3, 6);
      colors.push(...rgb, ...rgb);
    }
  };

  const bodyColor = new Map<number, [number, number, number]>();
  for (const entity of entities) {
    const rgb = rgbOf(entity.color);
    const { id } = entity;
    if (entity.kind === 'body') {
      if (shown(id)) bodyColor.set(id, rgb);
    } else if (entity.kind === 'face') {
      if (id >= faceCount || !shown(model.faceBody[id])) continue;
      addTint(id, rgb, TINT_ALPHA.face);
      const outline = faceOutline(id, model, faceTris);
      for (let i = 0; i < outline.length; i += 2) {
        const a = outline[i] ?? 0;
        const b = outline[i + 1] ?? 0;
        lines.pushFrom(model.positions, a * 3, 3);
        lines.pushFrom(model.positions, b * 3, 3);
        lineColors.push(...rgb, ...rgb);
      }
    } else if (entity.kind === 'edge') {
      if (id < model.edgeBody.length && shown(model.edgeBody[id]))
        addEdge(id, rgb, lines, lineColors);
    } else if (id < model.vertexBody.length && shown(model.vertexBody[id])) {
      points.pushFrom(model.vertexPositions, id * 3, 3);
      pointColors.push(...rgb);
    }
  }
  if (bodyColor.size > 0) {
    for (let f = 0; f < faceCount; f++) {
      const rgb = bodyColor.get(model.faceBody[f] ?? -1);
      if (rgb) addTint(f, rgb, TINT_ALPHA.body);
    }
    for (let e = 0; e < model.edgeBody.length; e++) {
      const rgb = bodyColor.get(model.edgeBody[e] ?? -1);
      if (rgb) addEdge(e, rgb, bodyLines, bodyLineColors);
    }
  }
  return {
    tintPositions: tint.done(),
    tintColors: tintColors.done(),
    lines: lines.done(),
    lineColors: lineColors.done(),
    bodyLines: bodyLines.done(),
    bodyLineColors: bodyLineColors.done(),
    points: points.done(),
    pointColors: pointColors.done(),
  };
}

/**
 * Border of one face's triangles as vertex-index pairs: triangle sides used by exactly one of
 * them. OCCT meshes each face with its own shared nodes, so index pairs are enough here.
 */
export function faceOutline(
  face: number,
  model: HighlightModel,
  faceTris: FaceTriangles,
): number[] {
  const count = new Map<string, [number, number, number]>();
  for (let i = faceTris.start[face] ?? 0; i < (faceTris.start[face + 1] ?? 0); i++) {
    const t = faceTris.tris[i] ?? 0;
    for (let k = 0; k < 3; k++) {
      const a = model.indices[t * 3 + k] ?? 0;
      const b = model.indices[t * 3 + ((k + 1) % 3)] ?? 0;
      const key = a < b ? `${String(a)},${String(b)}` : `${String(b)},${String(a)}`;
      const old = count.get(key);
      if (old) old[2]++;
      else count.set(key, [a, b, 1]);
    }
  }
  const out: number[] = [];
  for (const [a, b, n] of count.values()) if (n === 1) out.push(a, b);
  return out;
}

const DOT_VERTEX = /* glsl */ `
  uniform float size;
  attribute vec3 color;
  varying vec3 vColor;
  void main() {
    vColor = color;
    gl_PointSize = size;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const DOT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    gl_FragColor = vec4(r > 0.55 ? vColor * 0.45 : vColor, 1.0);
  }
`;

export class MarkerEntitiesOverlay {
  readonly root = new Group();
  private readonly tint: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly lines: LineSegments2;
  private readonly lineMaterial: LineMaterial;
  private readonly bodyLines: LineSegments2;
  private readonly bodyLineMaterial: LineMaterial;
  private readonly dots: Points<BufferGeometry, ShaderMaterial>;
  private entities: readonly ShownEntity[] = [];
  private visible: readonly boolean[] = [];

  constructor(
    private readonly model: HighlightModel,
    private readonly faceTris: FaceTriangles,
  ) {
    this.tint = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthFunc: LessEqualDepth,
        // Between the shown faces / whole-triangle paint (1) and the selection highlight (0.5),
        // so a selected face in a marker still shows the selection colour.
        polygonOffset: true,
        polygonOffsetFactor: 0.75,
        polygonOffsetUnits: 0.75,
      }),
    );
    this.tint.renderOrder = 3;
    this.lineMaterial = new LineMaterial({ linewidth: LINE_PX, vertexColors: true });
    this.lines = new LineSegments2(new LineSegmentsGeometry(), this.lineMaterial);
    this.lines.renderOrder = 4; // before the selection highlight (10+), which then wins ties
    this.bodyLineMaterial = new LineMaterial({ linewidth: BODY_LINE_PX, vertexColors: true });
    this.bodyLines = new LineSegments2(new LineSegmentsGeometry(), this.bodyLineMaterial);
    this.bodyLines.renderOrder = 4;
    this.dots = new Points(
      new BufferGeometry(),
      new ShaderMaterial({
        vertexShader: DOT_VERTEX,
        fragmentShader: DOT_FRAGMENT,
        uniforms: { size: { value: DOT_PX } },
        depthTest: false,
      }),
    );
    this.dots.renderOrder = 9;
    for (const obj of [this.tint, this.lines, this.bodyLines, this.dots]) {
      obj.visible = false;
      obj.frustumCulled = false;
    }
    this.root.add(this.tint, this.bodyLines, this.lines, this.dots);
  }

  /** Rebuilds only when what is drawn changes (not on rename / activate without effect). */
  set(entities: readonly ShownEntity[]): void {
    const same =
      entities.length === this.entities.length &&
      entities.every((e, i) => {
        const o = this.entities[i];
        return o?.kind === e.kind && o.id === e.id && o.color === e.color;
      });
    this.entities = entities;
    if (!same) this.rebuild();
  }

  setBodyVisibility(visible: readonly boolean[]): void {
    this.visible = visible;
    this.rebuild();
  }

  setViewport(size: Vector2, pixelRatio: number): void {
    this.lineMaterial.resolution.copy(size);
    this.bodyLineMaterial.resolution.copy(size);
    const u = this.dots.material.uniforms['size'];
    if (u) u.value = DOT_PX * pixelRatio;
  }

  /** Number of tinted triangles, edge-line segments and dots (for tests). */
  stats(): { tris: number; lines: number; bodyLines: number; dots: number } {
    const count = (g: BufferGeometry, name: string): number =>
      g.hasAttribute(name) ? g.getAttribute(name).count : 0;
    const n = (g: BufferGeometry): number => count(g, 'position');
    const segs = (l: LineSegments2): number => count(l.geometry, 'instanceStart');
    return {
      tris: n(this.tint.geometry) / 3,
      lines: this.lines.visible ? segs(this.lines) : 0,
      bodyLines: this.bodyLines.visible ? segs(this.bodyLines) : 0,
      dots: n(this.dots.geometry),
    };
  }

  private rebuild(): void {
    const b = markerEntityBuffers(this.entities, this.model, this.faceTris, this.visible);

    this.tint.geometry.dispose();
    const tint = new BufferGeometry();
    tint.setAttribute('position', new BufferAttribute(b.tintPositions, 3));
    tint.setAttribute('color', new BufferAttribute(b.tintColors, 4));
    this.tint.geometry = tint;
    this.tint.visible = b.tintPositions.length > 0;

    this.setLines(this.lines, b.lines, b.lineColors);
    this.setLines(this.bodyLines, b.bodyLines, b.bodyLineColors);

    this.dots.geometry.dispose();
    const dots = new BufferGeometry();
    dots.setAttribute('position', new BufferAttribute(b.points, 3));
    dots.setAttribute('color', new BufferAttribute(b.pointColors, 3));
    this.dots.geometry = dots;
    this.dots.visible = b.points.length > 0;
  }

  private setLines(obj: LineSegments2, positions: Float32Array, colors: Float32Array): void {
    // LineSegmentsGeometry keeps its instance count from the first setPositions: use a fresh one.
    obj.geometry.dispose();
    const g = new LineSegmentsGeometry();
    if (positions.length) {
      g.setPositions(positions);
      g.setColors(colors);
    }
    obj.geometry = g;
    obj.visible = positions.length > 0;
  }

  dispose(): void {
    this.tint.geometry.dispose();
    this.tint.material.dispose();
    this.lines.geometry.dispose();
    this.lineMaterial.dispose();
    this.bodyLines.geometry.dispose();
    this.bodyLineMaterial.dispose();
    this.dots.geometry.dispose();
    this.dots.material.dispose();
  }
}
