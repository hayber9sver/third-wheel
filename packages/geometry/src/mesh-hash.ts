/**
 * Mesh hash: one SHA-256 over the arrays that annotations point into — triangles, their
 * faces, and the face / edge / vertex → body maps. Two STEP files with the same hash give the same
 * triangle numbers and entity ids, so a sidecar made for one fits the other exactly (a re-export
 * that only changed the file's header or ids inside it). Body names are left out on purpose:
 * renaming a part doesn't move anything.
 */
import type { StepModel } from './model.js';

export type MeshHashModel = Pick<
  StepModel,
  | 'tessellation'
  | 'positions'
  | 'indices'
  | 'triangleFace'
  | 'faceBody'
  | 'edgeBody'
  | 'edgeRanges'
  | 'vertexBody'
  | 'vertexPositions'
  | 'bodyCount'
>;

/** `sha256:<64 hex>` of the model's mesh and entity maps. */
export async function meshHash(model: MeshHashModel): Promise<string> {
  const head = new Float64Array([
    model.tessellation.linearDeflection,
    model.tessellation.angularDeflection,
    model.bodyCount,
  ]);
  const parts: ArrayBufferView[] = [
    head,
    model.positions,
    model.indices,
    model.triangleFace,
    model.faceBody,
    model.edgeBody,
    model.edgeRanges,
    model.vertexBody,
    model.vertexPositions,
  ];
  // Each array's length goes in too, so bytes moving from one array to the next change the hash.
  const lengths = new Float64Array(parts.map((p) => p.byteLength));
  const digests = await Promise.all(
    [lengths, ...parts].map((p) => crypto.subtle.digest('SHA-256', bytesOf(p))),
  );
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => {
    all.set(new Uint8Array(d), i * 32);
  });
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return `sha256:${[...sum].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function bytesOf(view: ArrayBufferView): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  // `digest` wants a plain ArrayBuffer view; a transferred SharedArrayBuffer is copied.
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
}
