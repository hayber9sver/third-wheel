/**
 * Brush tools' cursor: where the pointer meets the visible model surface (BVH raycast,
 * `SurfaceRaycaster`) and a circle lying on the surface there, sized to the brush radius
 * (`BrushCursor`). Painting uses the same raycaster (`trianglesInSphere`).
 */
import type { StepModel } from '@third-wheel/geometry';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Ray,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Vec3 } from './camera-views.js';

/** A point on the model surface. `normal` is the triangle's, turned towards the viewer. */
export interface SurfaceHit {
  readonly point: Vec3;
  readonly normal: Vec3;
  /** Triangle id of the import (`StepModel.triangleFace` index). */
  readonly triangle: number;
  readonly face: number;
  readonly body: number;
}

/**
 * Ray → nearest visible surface point. The BVH is built on first use over the import's own
 * triangle order (`indirect`: the model's index buffer is not reordered), so hit triangle ids
 * are the import's ids.
 */
export class SurfaceRaycaster {
  private bvh: MeshBVH | undefined;
  private readonly geometry = new BufferGeometry();

  constructor(private readonly model: StepModel) {
    this.geometry.setAttribute('position', new BufferAttribute(model.positions, 3));
    this.geometry.setIndex(new BufferAttribute(model.indices, 1));
  }

  /** Build the BVH now (otherwise on the first `hit`). Returns the build time in ms. */
  prepare(): number {
    if (this.bvh) return 0;
    const t0 = performance.now();
    this.bvh = new MeshBVH(this.geometry, { indirect: true });
    return performance.now() - t0;
  }

  /** Whether (x, y, z) lies within `tol` mm of the surface, any body (version compare). */
  near(x: number, y: number, z: number, tol: number): boolean {
    this.prepare();
    const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
    // The max threshold only prunes far boxes: a triangle beyond it can still come back.
    const found = this.bvh?.closestPointToPoint(new Vector3(x, y, z), hit, 0, tol);
    return found != null && found.distance <= tol;
  }

  /**
   * Nearest hit on a body whose `visible` entry isn't false, or undefined. The normal is the
   * smoothed (vertex-normal interpolated) one, so the circle doesn't snap per facet on curves.
   */
  hit(ray: Ray, visible: readonly boolean[]): SurfaceHit | undefined {
    this.prepare();
    const hits = this.bvh?.raycast(ray, DoubleSide) ?? [];
    let best: (typeof hits)[number] | undefined;
    let bestBody = 0;
    for (const h of hits) {
      if (best && h.distance >= best.distance) continue;
      const t = h.faceIndex ?? 0;
      const face = this.model.triangleFace[t] ?? 0;
      const body = this.model.faceBody[face] ?? 0;
      if (visible[body] === false) continue;
      best = h;
      bestBody = body;
    }
    if (!best) return undefined;
    const triangle = best.faceIndex ?? 0;
    const point: Vec3 = [best.point.x, best.point.y, best.point.z];
    const normal = smoothNormal(this.model, triangle, point);
    const d = ray.direction;
    if (normal[0] * d.x + normal[1] * d.y + normal[2] * d.z > 0) {
      normal[0] = -normal[0];
      normal[1] = -normal[1];
      normal[2] = -normal[2];
    }
    return {
      point,
      normal,
      triangle,
      face: this.model.triangleFace[triangle] ?? 0,
      body: bestBody,
    };
  }

  /** BVH built (`prepare` ran): cheap queries only, no build stall (pins). */
  get ready(): boolean {
    return this.bvh !== undefined;
  }

  /**
   * Something visible on the ray closer than `maxDistance` (pin occlusion). False while the
   * BVH isn't built yet (it is built in idle time after a load).
   */
  blocked(ray: Ray, maxDistance: number, visible: readonly boolean[]): boolean {
    const bvh = this.bvh;
    if (!bvh) return false;
    for (const h of bvh.raycast(ray, DoubleSide, 0, maxDistance)) {
      if (h.distance >= maxDistance) continue;
      const body = this.model.faceBody[this.model.triangleFace[h.faceIndex ?? 0] ?? 0] ?? 0;
      if (visible[body] !== false) return true;
    }
    return false;
  }

  /**
   * Every body the ray meets beyond `near` (all bodies, hidden ones too; region pictures).
   * Builds the BVH if needed.
   */
  bodiesOnRay(ray: Ray, near = 0): number[] {
    this.prepare();
    const out: number[] = [];
    for (const h of this.bvh?.raycast(ray, DoubleSide, near) ?? [])
      out.push(this.model.faceBody[this.model.triangleFace[h.faceIndex ?? 0] ?? 0] ?? 0);
    return out;
  }

  /**
   * Import triangle ids touching the ball of `radius` around `center` (any part of the triangle
   * inside), on bodies whose `visible` entry isn't false — the sphere brush.
   */
  trianglesInSphere(center: Vec3, radius: number, visible: readonly boolean[]): number[] {
    this.prepare();
    const bvh = this.bvh;
    if (!bvh) return [];
    const c = this.sphereCenter.set(...center);
    const r2 = radius * radius;
    const closest = this.closest;
    const out: number[] = [];
    bvh.shapecast({
      intersectsBounds: (box) => box.distanceToPoint(c) <= radius,
      // MeshBVH's own overload (not deprecated) — the lint sees the deprecated base declaration.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      intersectsTriangle: (tri, t) => {
        if (tri.closestPointToPoint(c, closest).distanceToSquared(c) > r2) return false;
        const body = this.model.faceBody[this.model.triangleFace[t] ?? 0] ?? 0;
        if (visible[body] !== false) out.push(t);
        return false;
      },
    });
    return out;
  }

  private readonly sphereCenter = new Vector3();
  private readonly closest = new Vector3();

  dispose(): void {
    this.geometry.dispose();
    this.bvh = undefined;
  }
}

/** Unit normal of triangle `t` (right-handed winding); [0, 0, 1] for a degenerate one. */
export function triangleNormal(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  t: number,
): [number, number, number] {
  const p = (k: number, axis: number): number =>
    positions[(indices[t * 3 + k] ?? 0) * 3 + axis] ?? 0;
  const ux = p(1, 0) - p(0, 0);
  const uy = p(1, 1) - p(0, 1);
  const uz = p(1, 2) - p(0, 2);
  const vx = p(2, 0) - p(0, 0);
  const vy = p(2, 1) - p(0, 1);
  const vz = p(2, 2) - p(0, 2);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 1];
}

/**
 * Unit normal at `point` on triangle `t`, interpolated from the vertex normals (barycentric);
 * falls back to the facet normal when the vertex normals cancel out.
 */
export function smoothNormal(
  model: Pick<StepModel, 'positions' | 'indices' | 'normals'>,
  t: number,
  point: Vec3,
): [number, number, number] {
  const { positions: P, indices: I, normals: N } = model;
  const i0 = I[t * 3] ?? 0;
  const i1 = I[t * 3 + 1] ?? 0;
  const i2 = I[t * 3 + 2] ?? 0;
  const v = (i: number, a: number): number => P[i * 3 + a] ?? 0;
  // Barycentric coordinates of `point` (projected onto the triangle plane).
  const e0 = [v(i1, 0) - v(i0, 0), v(i1, 1) - v(i0, 1), v(i1, 2) - v(i0, 2)] as const;
  const e1 = [v(i2, 0) - v(i0, 0), v(i2, 1) - v(i0, 1), v(i2, 2) - v(i0, 2)] as const;
  const e2 = [point[0] - v(i0, 0), point[1] - v(i0, 1), point[2] - v(i0, 2)] as const;
  const dot = (a: readonly number[], b: readonly number[]): number =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  const d00 = dot(e0, e0);
  const d01 = dot(e0, e1);
  const d11 = dot(e1, e1);
  const d20 = dot(e2, e0);
  const d21 = dot(e2, e1);
  const den = d00 * d11 - d01 * d01;
  if (den <= 0) return triangleNormal(P, I, t);
  const b1 = Math.min(1, Math.max(0, (d11 * d20 - d01 * d21) / den));
  const b2 = Math.min(1 - b1, Math.max(0, (d00 * d21 - d01 * d20) / den));
  const b0 = 1 - b1 - b2;
  const n = (a: number): number =>
    b0 * (N[i0 * 3 + a] ?? 0) + b1 * (N[i1 * 3 + a] ?? 0) + b2 * (N[i2 * 3 + a] ?? 0);
  const nx = n(0);
  const ny = n(1);
  const nz = n(2);
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-9 ? [nx / len, ny / len, nz / len] : triangleNormal(P, I, t);
}

/**
 * Flat ring in the XY plane between radius `inner` and `outer` as a triangle list (XYZ per
 * vertex). `dashed`: only every other pair of segments is kept (erase cursor).
 */
export function ringPositions(
  inner: number,
  outer: number,
  segments: number,
  dashed: boolean,
): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    if (dashed && Math.floor(i / 2) % 2 === 1) continue;
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
    out.push(inner * c0, inner * s0, 0, outer * c0, outer * s0, 0, outer * c1, outer * s1, 0);
    out.push(inner * c0, inner * s0, 0, outer * c1, outer * s1, 0, inner * c1, inner * s1, 0);
  }
  return new Float32Array(out);
}

const Z_AXIS = new Vector3(0, 0, 1);

/** Ring line width on screen, CSS px. */
export const RING_WIDTH_PX = 2;
const RING_SEGMENTS = 64;
/** Brush circle colour with no active marker (the active marker's colour otherwise). */
export const NO_MARKER_COLOR = 0x8d939d;
export const ERASE_COLOR = 0xe5484d;

export type BrushCursorStyle = 'brush' | 'erase';

/** What the cursor shows now (tests). */
export interface BrushCursorState {
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
  readonly style: BrushCursorStyle;
  /** Colour as 0xrrggbb. */
  readonly color: number;
}

/**
 * Circle on the surface: ring (solid = brush, dashed red = erase) plus a faint fill for the
 * brush. Drawn on top of everything (it's the cursor) and never picked.
 */
export class BrushCursor {
  readonly root = new Group();
  private readonly ring: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly fill: Mesh<BufferGeometry, MeshBasicMaterial>;
  private state: BrushCursorState | undefined;
  private ringKey = '';
  /** Brush colour (the active marker's); erase is always red. */
  private brushColor = NO_MARKER_COLOR;
  private readonly normal = new Vector3();

  constructor() {
    const overlay = (opacity: number): MeshBasicMaterial =>
      new MeshBasicMaterial({
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      });
    this.ring = new Mesh(new BufferGeometry(), overlay(1));
    const fillGeometry = new BufferGeometry();
    fillGeometry.setAttribute('position', new BufferAttribute(ringPositions(0, 1, 48, false), 3));
    this.fill = new Mesh(fillGeometry, overlay(0.18));
    this.ring.renderOrder = 11;
    this.fill.renderOrder = 10;
    this.root.add(this.fill, this.ring);
    this.root.visible = false;
  }

  /**
   * Show the circle at `hit` with world `radius`. `pxWorld` = world size of one CSS pixel at the
   * hit (keeps the ring line `RING_WIDTH_PX` wide at any zoom).
   */
  show(hit: SurfaceHit, radius: number, pxWorld: number, style: BrushCursorStyle): void {
    const outer = radius;
    const inner = Math.max(0, radius - RING_WIDTH_PX * pxWorld);
    // Ring in unit size (scaled below); rebuilt only when its relative width visibly changes.
    const ratio = outer > 0 ? Math.round((inner / outer) * 100) / 100 : 0;
    const key = `${String(ratio)}|${style}`;
    if (key !== this.ringKey) {
      this.ringKey = key;
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new BufferAttribute(ringPositions(ratio, 1, RING_SEGMENTS, style === 'erase'), 3),
      );
      this.ring.geometry.dispose();
      this.ring.geometry = geometry;
    }
    const color = style === 'erase' ? ERASE_COLOR : this.brushColor;
    this.ring.material.color.setHex(color);
    this.fill.material.color.setHex(color);
    this.fill.visible = style === 'brush';
    this.root.position.set(...hit.point);
    this.root.quaternion.setFromUnitVectors(Z_AXIS, this.normal.set(...hit.normal));
    this.root.scale.setScalar(outer);
    this.root.visible = true;
    this.state = { center: hit.point, normal: hit.normal, radius, style, color };
  }

  /** Brush colour as 0xrrggbb; takes effect on the next `show`. */
  setBrushColor(color: number): void {
    this.brushColor = color;
  }

  hide(): void {
    this.root.visible = false;
    this.state = undefined;
  }

  current(): BrushCursorState | undefined {
    return this.state;
  }

  dispose(): void {
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.fill.geometry.dispose();
    this.fill.material.dispose();
  }
}
