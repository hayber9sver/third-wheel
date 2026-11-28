/**
 * Offscreen region picture: the whole model in plain grey with dark B-rep edges on white,
 * the requested markers' paint and held entities in their own colours, seen
 * by an orthographic camera (`RegionView`, region-view.ts). Draws with the app's WebGLRenderer
 * into its own render target and scene, so the user's view is untouched; the scene shares the
 * model's GPU vertex buffers (no copies). All bodies are drawn, also ones hidden in the app.
 * Bodies in front of the region (region-occlusion.ts) are ghosted: faint see-through faces
 * and edges, so the region shows through them and the AI still sees they are there.
 */
import {
  type BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  SRGBColorSpace,
  Scene,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { StepModel } from '@third-wheel/geometry';
import { visibleRuns } from './body-buffers.js';
import type { FaceTriangles } from './highlight-buffers.js';
import { MarkerEntitiesOverlay } from './marker-entities.js';
import type { ShownEntity } from './markers.js';
import type { PaintLayer } from './paint.js';
import { PaintOverlay, type MarkerStyle } from './paint-overlay.js';
import type { RegionView } from './region-view.js';

const BACKGROUND = 0xffffff;
const FACE = 0xc3c8d0; // light theme face colour
const EDGE = 0x1c1f24;
/** Opacity of ghosted bodies' faces / edges: there, but clearly not the subject. */
const GHOST_FACE_OPACITY = 0.12;
const GHOST_EDGE_OPACITY = 0.2;

export interface RegionDraw {
  readonly view: RegionView;
  /** Square picture size in px. */
  readonly size: number;
  readonly styles: readonly MarkerStyle[];
  readonly entities: readonly ShownEntity[];
  /** Paint (must match the model's triangles); undefined = no paint. */
  readonly layer: PaintLayer | undefined;
  /** Bodies drawn ghosted (in front of the region). */
  readonly ghost: readonly number[];
}

export class RegionRenderer {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera();
  private readonly faces: Mesh<BufferGeometry, MeshStandardMaterial[]>;
  private readonly edges: LineSegments<BufferGeometry, LineBasicMaterial[]>;
  private readonly paint: PaintOverlay;
  private readonly entities: MarkerEntitiesOverlay;
  private target: WebGLRenderTarget | undefined;

  /**
   * `faceGeometry` / `edgeGeometry`: the viewport's model geometry (attributes shared, its draw
   * groups ignored). `triBody`: body per import triangle. `triStart` / `edgeStart`: per-body
   * index / vertex ranges of those geometries (body-buffers.ts).
   */
  constructor(
    model: StepModel,
    faceGeometry: BufferGeometry,
    edgeGeometry: BufferGeometry,
    faceTris: FaceTriangles,
    triBody: Uint32Array,
    private readonly triStart: Uint32Array,
    private readonly edgeStart: Uint32Array,
  ) {
    const position = faceGeometry.getAttribute('position');
    const normal = faceGeometry.getAttribute('normal');
    const faces = new BufferGeometry();
    faces.setAttribute('position', position);
    faces.setAttribute('normal', normal);
    faces.setIndex(faceGeometry.getIndex());
    const faceLook = {
      color: FACE,
      metalness: 0.05,
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    };
    // Material 0 = solid, 1 = ghost (draw groups per `render`).
    this.faces = new Mesh(faces, [
      new MeshStandardMaterial(faceLook),
      new MeshStandardMaterial({
        ...faceLook,
        transparent: true,
        opacity: GHOST_FACE_OPACITY,
        depthWrite: false,
      }),
    ]);
    const edges = new BufferGeometry();
    edges.setAttribute('position', edgeGeometry.getAttribute('position'));
    this.edges = new LineSegments(edges, [
      new LineBasicMaterial({ color: EDGE }),
      new LineBasicMaterial({
        color: EDGE,
        transparent: true,
        opacity: GHOST_EDGE_OPACITY,
        depthWrite: false,
      }),
    ]);
    this.paint = new PaintOverlay(
      position as BufferAttribute,
      normal as BufferAttribute,
      model.indices,
      triBody,
    );
    this.entities = new MarkerEntitiesOverlay(model, faceTris);
    for (const obj of [this.faces, this.edges]) obj.frustumCulled = false;

    this.scene.background = new Color(BACKGROUND);
    this.scene.add(new HemisphereLight(0xffffff, 0x8a8f99, 2));
    // Head light: from the upper right of the picture, whatever the view direction.
    const light = new DirectionalLight(0xffffff, 1.5);
    light.position.set(0.5, 1, 1);
    const aim = new Object3D();
    this.camera.add(light, aim);
    light.target = aim;
    this.scene.add(this.camera, this.faces, this.paint.mesh, this.paint.pieceMesh, this.edges);
    this.scene.add(this.entities.root);
  }

  /** Draws the picture; returns RGBA rows top to bottom (`size` × `size` × 4 bytes). */
  render(renderer: WebGLRenderer, draw: RegionDraw): Uint8Array {
    const { view, size } = draw;
    if (draw.layer) this.paint.update(draw.layer, draw.styles, []);
    else {
      this.paint.invalidate();
      this.paint.mesh.visible = false;
      this.paint.pieceMesh.visible = false;
    }
    this.setGhost(draw.ghost);
    this.entities.set(draw.entities);
    this.entities.setViewport(new Vector2(size, size), 1);

    const cam = this.camera;
    const h = view.halfSize;
    cam.left = -h;
    cam.right = h;
    cam.top = h;
    cam.bottom = -h;
    cam.near = view.near;
    cam.far = view.far;
    const [tx, ty, tz] = view.target;
    cam.position.set(
      tx + view.dir[0] * view.distance,
      ty + view.dir[1] * view.distance,
      tz + view.dir[2] * view.distance,
    );
    cam.up.set(...view.up);
    cam.lookAt(tx, ty, tz);
    cam.updateProjectionMatrix();
    this.scene.updateMatrixWorld();

    const target = this.targetOf(size);
    const before = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.render(this.scene, cam);
      const raw = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, raw);
      return flipRows(raw, size);
    } finally {
      renderer.setRenderTarget(before);
    }
  }

  /**
   * Compiles the picture's shaders for its render target in the background, so the AI's first
   * `render_region` doesn't wait 15–300 ms for them. `size`: the picture
   * size to allocate the target for (the default `regionSize()`).
   */
  warm(renderer: WebGLRenderer, size: number): Promise<unknown> {
    this.setGhost([]);
    // Shader variants depend on the render target (colour space), so compile with it bound;
    // compileAsync starts the compile synchronously, then only waits.
    const before = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targetOf(size));
    try {
      return renderer.compileAsync(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(before);
    }
  }

  /** Draw groups: ghosted bodies with material 1, all others with material 0. */
  private setGhost(ghost: readonly number[]): void {
    const bodies = this.triStart.length - 1;
    const solid = new Array<boolean>(bodies).fill(true);
    const ghosted = new Array<boolean>(bodies).fill(false);
    for (const b of ghost)
      if (b >= 0 && b < bodies) {
        solid[b] = false;
        ghosted[b] = true;
      }
    const setRuns = (geometry: BufferGeometry, starts: Uint32Array): void => {
      geometry.clearGroups();
      for (const run of visibleRuns(starts, solid)) geometry.addGroup(run.start, run.count, 0);
      for (const run of visibleRuns(starts, ghosted)) geometry.addGroup(run.start, run.count, 1);
    };
    setRuns(this.faces.geometry, this.triStart);
    setRuns(this.edges.geometry, this.edgeStart);
  }

  private targetOf(size: number): WebGLRenderTarget {
    if (this.target?.width === size) return this.target;
    this.target?.dispose();
    // MSAA for smooth edges; sRGB so the colours match the screen.
    this.target = new WebGLRenderTarget(size, size, { samples: 4, colorSpace: SRGBColorSpace });
    return this.target;
  }

  dispose(): void {
    // Shares vertex buffers with the viewport's model (freed with it); its own geometries hold
    // only the VAOs, released here together with the model.
    this.faces.geometry.dispose();
    this.edges.geometry.dispose();
    for (const mat of [...this.faces.material, ...this.edges.material]) mat.dispose();
    this.paint.dispose();
    this.entities.dispose();
    this.target?.dispose();
  }
}

/** WebGL rows are bottom-up; images are top-down. Alpha forced opaque. */
export function flipRows(raw: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(raw.length);
  const row = size * 4;
  for (let y = 0; y < size; y++)
    out.set(raw.subarray((size - 1 - y) * row, (size - y) * row), y * row);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

/**
 * RGBA top-down pixels (`width` × `height`) → PNG bytes (browser encoder). `overlay` draws on
 * top before encoding (contact sheet labels).
 */
export async function encodePng(
  rgba: Uint8Array,
  width: number,
  height = width,
  overlay?: (ctx: OffscreenCanvasRenderingContext2D) => void,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas for PNG encoding');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  overlay?.(ctx);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
