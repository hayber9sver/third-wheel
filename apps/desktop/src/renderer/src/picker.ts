/**
 * GPU ID picking. A separate scene draws faces, edges and B-rep vertices with their ids as
 * colours (pick-resolve.ts has the encoding). Only a small square around the cursor is rendered —
 * the camera's view offset crops the picture — into a tiny offscreen target, then read back.
 *
 * Shares the shown model's position/index buffers (no extra GPU copy) and its draw groups, so
 * hidden bodies are not pickable. Depth uses the same polygon offset as the shown faces, so edges
 * and vertices win ties on the surface exactly as they do on screen.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  GLSL3,
  LineSegments,
  Mesh,
  NoBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { visibleRuns, type BodyBuffers } from './body-buffers.js';
import { facePickIds, vertexPickBuffers } from './pick-buffers.js';
import {
  KIND_CODE,
  MAX_PICK_ID,
  resolvePick,
  type EntityKind,
  type EntityRef,
} from './pick-resolve.js';
import type { StepModel } from '@third-wheel/geometry';

const VERTEX_SHADER = /* glsl */ `
  in float pickId;
  uniform float kindCode;
  uniform float pointSize;
  flat out vec4 vPick;
  void main() {
    // 24-bit id → RGB bytes (exact in float32 up to 2^24), kind → alpha byte.
    vPick = vec4(mod(pickId, 256.0), mod(floor(pickId / 256.0), 256.0), floor(pickId / 65536.0), kindCode) / 255.0;
    gl_PointSize = pointSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  flat in vec4 vPick;
  out highp vec4 pickColor; // GLSL3 in three.js: declare the output (no gl_FragColor)
  void main() { pickColor = vPick; }
`;

function pickMaterial(kind: EntityKind, extra: Partial<ShaderMaterial> = {}): ShaderMaterial {
  return Object.assign(
    new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { kindCode: { value: KIND_CODE[kind] }, pointSize: { value: 1 } },
      blending: NoBlending,
    }),
    extra,
  );
}

/** Size of B-rep vertex dots in the pick pass, CSS px (the pick radius does the rest). */
const VERTEX_POINT_PX = 3;

export class Picker {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private target = new WebGLRenderTarget(1, 1);
  private pixels = new Uint8Array(4);
  private readonly faces: Mesh<BufferGeometry, ShaderMaterial[]>;
  private readonly edges: LineSegments<BufferGeometry, ShaderMaterial[]>;
  private readonly vertices: Points<BufferGeometry, ShaderMaterial[]>;
  private readonly triStart: Uint32Array;
  private readonly edgeStart: Uint32Array;
  private readonly vertexStart: Uint32Array;
  private readonly clearColor = new Color();
  private readonly pointSize = { value: 1 };
  /** Attributes owned by the shown model (not freed by `dispose`). */
  private readonly shared = new Set<object>();

  /** `shown` = the displayed face mesh / edge lines, whose position and index buffers are reused. */
  constructor(
    model: StepModel,
    buffers: BodyBuffers,
    shown: { faces: BufferGeometry; edges: BufferGeometry },
  ) {
    const most = Math.max(model.faceBody.length, model.edgeBody.length, model.vertexBody.length);
    if (most > MAX_PICK_ID)
      console.warn(`Picking: ${String(most)} entities exceed the 24-bit id range`);

    // --- Faces ---
    const shownPosition = shown.faces.getAttribute('position') as BufferAttribute;
    const faceIds = facePickIds(
      buffers.indices,
      buffers.triangleOrder,
      model.triangleFace,
      model.positions.length / 3,
    );
    const faceGeometry = new BufferGeometry();
    if (faceIds.split) {
      const { indices, sourceVertex } = faceIds.split;
      const pos = new Float32Array(sourceVertex.length * 3);
      sourceVertex.forEach((v, i) => {
        pos.set(model.positions.subarray(v * 3, v * 3 + 3), i * 3);
      });
      faceGeometry.setAttribute('position', new BufferAttribute(pos, 3));
      faceGeometry.setIndex(new BufferAttribute(indices, 1));
    } else {
      const shownIndex = shown.faces.getIndex();
      faceGeometry.setAttribute('position', shownPosition);
      faceGeometry.setIndex(shownIndex);
      this.shared.add(shownPosition);
      if (shownIndex) this.shared.add(shownIndex);
    }
    faceGeometry.setAttribute('pickId', new BufferAttribute(faceIds.faceIds, 1));
    this.faces = new Mesh(faceGeometry, [
      pickMaterial('face', { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    ]);

    // --- Edges ---
    const edgeGeometry = new BufferGeometry();
    const edgePosition = shown.edges.getAttribute('position');
    edgeGeometry.setAttribute('position', edgePosition);
    this.shared.add(edgePosition);
    edgeGeometry.setAttribute('pickId', new BufferAttribute(buffers.edgeSegmentIds, 1));
    this.edges = new LineSegments(edgeGeometry, [pickMaterial('edge')]);

    // --- B-rep vertices ---
    const vb = vertexPickBuffers(model);
    const vertexGeometry = new BufferGeometry();
    vertexGeometry.setAttribute('position', new BufferAttribute(vb.points, 3));
    vertexGeometry.setAttribute('pickId', new BufferAttribute(vb.ids, 1));
    const vertexMaterial = pickMaterial('vertex');
    vertexMaterial.uniforms.pointSize = this.pointSize;
    this.vertices = new Points(vertexGeometry, [vertexMaterial]);

    // Draw order = priority order: later kinds overwrite earlier ones where depth allows.
    this.faces.renderOrder = 0;
    this.edges.renderOrder = 1;
    this.vertices.renderOrder = 2;
    for (const obj of [this.faces, this.edges, this.vertices]) obj.frustumCulled = false;
    this.scene.add(this.faces, this.edges, this.vertices);

    this.triStart = buffers.triStart;
    this.edgeStart = buffers.edgeStart;
    this.vertexStart = vb.start;
    this.setBodyVisibility([]);
  }

  /** Same rule as the shown model: missing entries count as visible. */
  setBodyVisibility(visible: readonly boolean[]): void {
    const set = (geometry: BufferGeometry, starts: Uint32Array): void => {
      geometry.clearGroups();
      for (const run of visibleRuns(starts, visible)) geometry.addGroup(run.start, run.count, 0);
    };
    set(this.faces.geometry, this.triStart);
    set(this.edges.geometry, this.edgeStart);
    set(this.vertices.geometry, this.vertexStart);
  }

  /**
   * Selection filter: leave vertices / edges out of the pass. Faces are always drawn, so
   * they still hide what is behind them.
   */
  setPassKinds(kinds: { readonly vertex: boolean; readonly edge: boolean }): void {
    this.vertices.visible = kinds.vertex;
    this.edges.visible = kinds.edge;
  }

  /**
   * Entity at canvas position (`x`, `y`, CSS px from the top-left) for `camera`. Vertices and
   * edges within `radius` CSS px win over the face under the cursor (vertex > edge > face).
   * A view offset on `camera` that shifts its full-size picture (the left panel's) is kept.
   */
  pick(
    renderer: WebGLRenderer,
    camera: PerspectiveCamera,
    x: number,
    y: number,
    radius: number,
  ): EntityRef | undefined {
    const dpr = renderer.getPixelRatio();
    const canvas = renderer.domElement;
    const r = Math.max(0, Math.ceil(radius * dpr));
    const size = 2 * r + 1;
    if (this.target.width !== size) {
      this.target.dispose();
      this.target = new WebGLRenderTarget(size, size);
      this.pixels = new Uint8Array(size * size * 4);
    }
    // Crop the full picture to the size×size device pixels centred on the cursor, counted in the
    // camera's own (shifted) picture when it has a view offset.
    const view = camera.view?.enabled ? camera.view : undefined;
    const shiftX = view ? (view.offsetX / view.fullWidth) * canvas.width : 0;
    const shiftY = view ? (view.offsetY / view.fullHeight) * canvas.height : 0;
    this.camera.copy(camera);
    this.camera.setViewOffset(
      canvas.width,
      canvas.height,
      Math.floor(x * dpr + shiftX) - r, // the device pixel under the cursor
      Math.floor(y * dpr + shiftY) - r,
      size,
      size,
    );
    this.pointSize.value = VERTEX_POINT_PX * dpr;

    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this.clearColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.readRenderTargetPixels(this.target, 0, 0, size, size, this.pixels);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clearColor, prevAlpha);
    return resolvePick(this.pixels, size, radius * dpr);
  }

  /**
   * ID buffer of a canvas rectangle (CSS px, top-left origin) for box select: one pass per
   * kind, each drawn over the faces only, so an edge or vertex never hides a small face and a
   * vertex dot never hides a short edge. Returns the RGBA bytes of every pass (faces always).
   *
   * Each pass draws the **whole view** and reads back only the rectangle. Drawing just the
   * rectangle (camera view offset) changes the projection with the box size, and tiny edges that
   * lie exactly on a surface (e.g. knurling) then flip between visible and hidden — a box could
   * select an edge and a slightly bigger box fail to remove it.
   */
  renderRegion(
    renderer: WebGLRenderer,
    camera: PerspectiveCamera,
    rect: { x0: number; y0: number; x1: number; y1: number },
    kinds: { readonly vertex: boolean; readonly edge: boolean },
  ): Uint8Array[] {
    const dpr = renderer.getPixelRatio();
    const canvas = renderer.domElement;
    const x = Math.floor(rect.x0 * dpr);
    const y = Math.floor(rect.y0 * dpr);
    const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(rect.x1 * dpr) - x));
    const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(rect.y1 * dpr) - y));
    const target = new WebGLRenderTarget(canvas.width, canvas.height);
    this.camera.copy(camera); // keeps the camera's view offset (the left panel's shift)
    // Render targets are read with a bottom-left origin.
    const readY = canvas.height - y - h;
    this.pointSize.value = VERTEX_POINT_PX * dpr;

    const was = { edge: this.edges.visible, vertex: this.vertices.visible };
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this.clearColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    const passes: Uint8Array[] = [];
    const pass = (edge: boolean, vertex: boolean): void => {
      this.edges.visible = edge;
      this.vertices.visible = vertex;
      renderer.clear();
      renderer.render(this.scene, this.camera);
      const pixels = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(target, x, readY, w, h, pixels);
      passes.push(pixels);
    };
    try {
      pass(false, false);
      if (kinds.edge) pass(true, false);
      if (kinds.vertex) pass(false, true);
    } finally {
      this.edges.visible = was.edge;
      this.vertices.visible = was.vertex;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this.clearColor, prevAlpha);
      target.dispose();
    }
    return passes;
  }

  dispose(): void {
    for (const obj of [this.faces, this.edges, this.vertices]) {
      for (const m of obj.material) m.dispose();
    }
    // Detach buffers shared with the shown model first: three.js frees the GPU buffers of every
    // attribute of a disposed geometry, which would break the model if it is still shown.
    const shared = this.shared;
    for (const g of [this.faces.geometry, this.edges.geometry]) {
      if (g.index && shared.has(g.index)) g.setIndex(null);
      for (const name of Object.keys(g.attributes)) {
        const a = g.getAttribute(name);
        if (shared.has(a)) g.deleteAttribute(name);
      }
    }
    this.faces.geometry.dispose();
    this.edges.geometry.dispose();
    this.vertices.geometry.dispose();
    this.target.dispose();
  }
}
