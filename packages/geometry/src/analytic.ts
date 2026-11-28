/**
 * Exact geometry of analytic faces and edges (radius, axis, normal…), read from the kernel once
 * at import. occt-wasm has no axis / centre getters, so they are derived from surface and
 * curve evaluation, using OCCT's standard parametrisations:
 *   cylinder  P(u,v) = O + R(cos u·X + sin u·Y) + v·Z           → opposite points (u, u+π) share v
 *   cone      P(u,v) = O + (R + v sin α)(cos u·X + sin u·Y) + v cos α·Z
 *   sphere    P(u,v) = O + R cos v (cos u·X + sin u·Y) + R sin v·Z → opposite of (u,v) is (u+π, −v)
 *   torus     P(u,v) = O + (R + r cos v)(cos u·X + sin u·Y) + r sin v·Z
 *   circle    P(t)   = C + R(cos t·X + sin t·Y)
 * Kernel surface area is not used: it costs ~3 ms per face (26 s on a 9k-face assembly); area
 * comes from the mesh instead (`entity-info.ts`).
 */
import type { OcctKernel, ShapeHandle, Vec3 } from 'occt-wasm';
import { EDGE_GEOMETRY_STRIDE, FACE_GEOMETRY_STRIDE } from './model.js';
import { cross, dot, len, mid, sub, unit, type V3 } from './vec.js';

type V = V3;
const v3 = (p: Vec3): V => [p.x, p.y, p.z];
/** Two parameters inside [min, max] (or around the middle if the range is infinite). */
function span(min: number, max: number): [number, number] {
  if (Number.isFinite(min) && Number.isFinite(max) && max - min > 1e-9) return [min, max];
  const m = Number.isFinite(min) ? min : Number.isFinite(max) ? max : 0;
  return [m, m + 1];
}

/**
 * Writes one face's record into `out` at `face * FACE_GEOMETRY_STRIDE` (layout: see
 * `StepModel.faceGeometry`). Leaves NaN where a value does not apply or evaluation fails.
 */
export function readFaceGeometry(
  kernel: OcctKernel,
  face: ShapeHandle,
  type: string,
  out: Float32Array,
  index: number,
): void {
  const o = index * FACE_GEOMETRY_STRIDE;
  const put = (d: V | undefined, p: V | undefined, a = NaN, b = NaN): void => {
    out.set([...(d ?? [NaN, NaN, NaN]), ...(p ?? [NaN, NaN, NaN]), a, b], o);
  };
  put(undefined, undefined);
  if (!['plane', 'cylinder', 'cone', 'sphere', 'torus'].includes(type)) return;
  try {
    const b = kernel.uvBounds(face);
    const [u0] = span(b.uMin, b.uMax);
    const [v0, v1] = span(b.vMin, b.vMax);
    const um = Number.isFinite(b.uMax) ? (u0 + b.uMax) / 2 : u0;
    const vm = (v0 + v1) / 2;
    const at = (u: number, v: number): V => v3(kernel.pointOnSurface(face, u, v));
    const normal = (u: number, v: number): V => v3(kernel.surfaceNormal(face, u, v));
    /** +1 if the face's outward normal points away from `centre` (shaft, ball), −1 if towards (hole). */
    const convexity = (p: V, centre: V): number =>
      dot(normal(um, vm), sub(p, centre)) >= 0 ? 1 : -1;
    switch (type) {
      case 'plane':
        put(normal(um, vm), at(um, vm));
        return;
      case 'cylinder': {
        const p = at(um, vm);
        const centre = mid(p, at(um + Math.PI, vm));
        const axis = unit(sub(at(um, v1), at(um, v0)));
        put(axis, centre, len(sub(p, centre)), convexity(p, centre));
        return;
      }
      case 'cone': {
        const a0 = mid(at(um, v0), at(um + Math.PI, v0));
        const a1 = mid(at(um, v1), at(um + Math.PI, v1));
        const r0 = len(sub(at(um, v0), a0));
        const r1 = len(sub(at(um, v1), a1));
        const h = len(sub(a1, a0));
        if (h === 0 || Math.abs(r1 - r0) < 1e-12) return;
        // Axis points from the apex towards the wide end.
        const axis = unit(r1 > r0 ? sub(a1, a0) : sub(a0, a1));
        const halfAngle = Math.atan(Math.abs(r1 - r0) / h);
        const rNear = Math.min(r0, r1);
        const near = r1 > r0 ? a0 : a1;
        const t = rNear / Math.tan(halfAngle);
        const apex: V = [near[0] - axis[0] * t, near[1] - axis[1] * t, near[2] - axis[2] * t];
        const p = at(um, vm);
        put(axis, apex, halfAngle, convexity(p, mid(a0, a1)));
        return;
      }
      case 'sphere': {
        const p = at(um, vm);
        const centre = mid(p, at(um + Math.PI, -vm));
        put(undefined, centre, len(sub(p, centre)), convexity(p, centre));
        return;
      }
      case 'torus': {
        const tube = (u: number): V => mid(at(u, vm), at(u, vm + Math.PI));
        const minor = len(sub(at(um, vm), at(um, vm + Math.PI))) / 2;
        const t0 = tube(um);
        const centre = mid(t0, tube(um + Math.PI));
        const axis = unit(cross(sub(t0, centre), sub(tube(um + Math.PI / 2), centre)));
        put(axis, centre, len(sub(t0, centre)), minor);
        return;
      }
    }
  } catch {
    put(undefined, undefined); // unusual surface: type only
  }
}

/**
 * Writes one edge's record into `out` at `edge * EDGE_GEOMETRY_STRIDE` (layout: see
 * `StepModel.edgeGeometry`).
 */
export function readEdgeGeometry(
  kernel: OcctKernel,
  edge: ShapeHandle,
  type: string,
  out: Float32Array,
  index: number,
): void {
  const o = index * EDGE_GEOMETRY_STRIDE;
  out.fill(NaN, o, o + EDGE_GEOMETRY_STRIDE);
  if (type === 'other') return; // degenerate (no curve)
  try {
    out[o + 6] = kernel.getLength(edge);
    const { first, last } = kernel.curveParameters(edge);
    const at = (t: number): V => v3(kernel.curvePointAtParam(edge, t));
    if (type === 'line') {
      const a = at(first);
      out.set([...unit(sub(at(last), a)), ...a], o);
    } else if (type === 'circle') {
      const p = at(first);
      const centre = mid(p, at(first + Math.PI));
      const axis = unit(cross(sub(p, centre), sub(at(first + Math.PI / 2), centre)));
      out.set([...axis, ...centre], o);
      out[o + 7] = len(sub(p, centre));
      out[o + 8] = Math.min(Math.abs(last - first), 2 * Math.PI);
    }
  } catch {
    // Type (and maybe length) only.
  }
}
