import { parseAnnotations, type Annotations } from '@third-wheel/core';
import { describe, expect, it } from 'vitest';
import type { Comment } from './comments.js';
import type { Marker } from './markers.js';
import { PaintLayer, PaintRecord, type PaintState } from './paint.js';
import {
  applyPaint,
  checkSidecar,
  fromAnnotations,
  MAX_SAMPLES,
  toAnnotations,
  type SidecarModel,
} from './sidecar.js';

/** 5 triangles: 0–2 on face 0, 3–4 on face 1 (corners at x = triangle number). */
function makeModel(triangles = 5): SidecarModel {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < triangles; t++) {
    positions.push(t, 0, 0, t + 1, 0, 0, t, 1, 0);
    indices.push(t * 3, t * 3 + 1, t * 3 + 2);
  }
  return {
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleFace: Uint32Array.from({ length: triangles }, (_, t) => (t < 3 ? 0 : 1)),
    bodyCount: 1,
    faceBody: new Uint32Array(2),
    edgeBody: new Uint32Array(6),
    vertexBody: new Uint32Array(4),
  };
}

const marker = (id: string, extra: Partial<Marker> = {}): Marker => ({
  id,
  name: `Marker ${id}`,
  color: '#ff8a1f',
  visible: true,
  entities: [],
  ...extra,
});

const T = '2026-11-08T10:00:00.000Z';
const comment = (id: string, markerIds: string[]): Comment => ({
  id,
  text: 'Fillet here',
  markerIds,
  status: 'open',
  author: 'human',
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
});

const HASH = `sha256:${'a'.repeat(64)}`;

function paintWith(model: SidecarModel, states: Record<number, PaintState>): PaintLayer {
  const layer = new PaintLayer(model.triangleFace.length, model);
  const record = new PaintRecord();
  for (const [t, s] of Object.entries(states)) record.note(Number(t), undefined, s);
  layer.restore(record, 'after');
  return layer;
}

function save(model: SidecarModel, paint: PaintLayer, markers: Marker[], comments: Comment[] = []) {
  return toAnnotations({
    fileName: 'part.step',
    contentHash: HASH,
    model,
    markers,
    comments,
    paint,
  });
}

describe('sidecar', () => {
  it('writes runs per face, piece trees per marker, samples, and passes the schema', () => {
    const model = makeModel();
    const paint = paintWith(model, {
      0: 'm1',
      1: 'm1',
      2: ['m1', undefined, 'm2', undefined],
      3: 'm1',
      4: 'm2',
    });
    const doc = save(
      model,
      paint,
      [marker('m1', { entities: [{ kind: 'edge', id: 3, seq: 1 }] }), marker('m2')],
      [comment('c1', ['m1', 'gone'])],
    );
    expect(parseAnnotations(doc).ok).toBe(true);
    const [m1, m2] = doc.markers;
    expect(m1?.paint.faces).toMatchObject([
      { faceId: 0, triangles: [[0, 2]], pieces: [{ triangle: 2, tree: [1, 0, 0, 0] }] },
      { faceId: 1, triangles: [[3, 1]] },
    ]);
    expect(m2?.paint.faces).toMatchObject([
      { faceId: 0, triangles: [], pieces: [{ triangle: 2, tree: [0, 0, 1, 0] }] },
      { faceId: 1, triangles: [[4, 1]] },
    ]);
    // Samples per face, none on the marker; a cut triangle only where it is painted.
    expect(m1?.paint.samples).toBeUndefined();
    const s0 = m1?.paint.faces[0]?.samples ?? [];
    expect(s0.length).toBeGreaterThanOrEqual(3 * 3);
    for (let i = 0; i < s0.length; i += 3) {
      const [x = 0, y = 0] = s0.slice(i, i + 2);
      expect(x < 2 || (x <= 2.5 && y <= 0.5)).toBe(true); // triangle 2: piece (a, ab, ca) only
    }
    expect(m1?.paint.faces[1]?.samples?.length).toBeGreaterThan(0);
    expect(m1?.entities).toEqual([{ kind: 'edge', id: 3, seq: 1 }]);
    expect(doc.comments[0]?.markerIds).toEqual(['m1']); // deleted marker left out
  });

  it('round-trips paint, markers and comments', () => {
    const model = makeModel();
    const states: Record<number, PaintState> = {
      0: 'm2',
      2: [['m1', 'm2', undefined, 'm1'], undefined, 'm2', 'm1'],
      4: 'm1',
    };
    const markers = [
      marker('m1', { visible: false }),
      marker('m2', {
        transfer: {
          status: 'lost',
          from: 'v1.step',
          ghost: { faces: [{ samples: [1, 2, 3], clear: [4, 5, 6] }] },
        },
      }),
    ];
    const comments = [
      {
        ...comment('c4', ['m2']),
        status: 'resolved' as const,
        replies: [
          { id: 'r1', text: 'which edge?', author: 'ai' as const, createdAt: T, updatedAt: T },
          {
            id: 'r2',
            text: 'done',
            author: 'ai' as const,
            createdAt: T,
            updatedAt: T,
            status: 'resolved' as const,
          },
        ],
      },
      { ...comment('c5', []), linkedModels: ['lid.step'] },
      { ...comment('c6', []), status: 'wontfix' as const, awaitingConfirm: true as const },
    ];
    const doc = save(model, paintWith(model, states), markers, comments);
    const loaded = fromAnnotations(JSON.parse(JSON.stringify(doc)) as Annotations, model);
    expect(loaded.dropped).toBe(0);
    expect(loaded.markers).toEqual(markers);
    expect(loaded.comments).toEqual(comments);
    const layer = new PaintLayer(model.triangleFace.length, model);
    applyPaint(layer, loaded.paint);
    for (let t = 0; t < 5; t++) expect(layer.stateAt(t)).toEqual(states[t]);
  });

  it('turns an old single `note` into the first AI reply', () => {
    const model = makeModel();
    const doc = save(model, paintWith(model, {}), [], [comment('c1', [])]);
    const old = JSON.parse(JSON.stringify(doc)) as Annotations;
    const c = old.comments[0];
    if (!c) throw new Error('no comment');
    Object.assign(c, { status: 'resolved', note: 'added a fillet' });
    const loaded = fromAnnotations(old, model);
    expect(loaded.comments[0]).toMatchObject({
      status: 'resolved',
      replies: [{ id: 'r1', text: 'added a fillet', author: 'ai', status: 'resolved' }],
    });
    expect(loaded.comments[0]).not.toHaveProperty('note');
    const again = save(model, paintWith(model, {}), [], loaded.comments);
    expect(again.comments[0]).not.toHaveProperty('note');
    expect(again.comments[0]?.replies).toHaveLength(1);
  });

  it('caps samples per marker', () => {
    const model = makeModel(MAX_SAMPLES * 2 + 1);
    const states: Record<number, PaintState> = {};
    for (let t = 0; t < model.triangleFace.length; t++) states[t] = 'm1';
    const doc = save(model, paintWith(model, states), [marker('m1')]);
    const n = (doc.markers[0]?.paint.faces ?? []).reduce((a, f) => a + (f.samples?.length ?? 0), 0);
    expect(n).toBeGreaterThan(MAX_SAMPLES * 1.5);
    expect(n).toBeLessThanOrEqual(MAX_SAMPLES * 3);
  });

  it('drops what does not fit the model', () => {
    const model = makeModel();
    const doc = save(model, paintWith(model, { 0: 'm1', 3: 'm1' }), [
      marker('m1', {
        entities: [
          { kind: 'face', id: 1, seq: 1 },
          { kind: 'face', id: 9, seq: 2 },
        ],
      }),
    ]);
    const m = doc.markers[0];
    if (!m) throw new Error('no marker');
    const tampered: Annotations = {
      ...doc,
      markers: [
        {
          ...m,
          paint: {
            faces: [
              {
                faceId: 0,
                triangles: [
                  [0, 1],
                  [3, 1],
                ],
              }, // 3 is on face 1
              { faceId: 1, triangles: [[4, 1e12]] }, // runs past the model
              { faceId: 0, triangles: [], pieces: [{ triangle: 99, tree: [1, 0, 0, 0] }] },
            ],
          },
        },
      ],
    };
    const loaded = fromAnnotations(tampered, model);
    expect([...loaded.paint.keys()].sort()).toEqual([0, 4]);
    // triangle 3, the 1e12 − 1 past the end, piece 99, face 9
    expect(loaded.dropped).toBe(1 + (1e12 - 1) + 1 + 1);
    expect(loaded.markers[0]?.entities).toEqual([{ kind: 'face', id: 1, seq: 1 }]);
  });

  it('checks hash, mesh settings and readability', () => {
    const model = makeModel();
    const text = JSON.stringify(save(model, paintWith(model, {}), [marker('m1')]));
    expect(checkSidecar(text, HASH, model).ok).toBe(true);
    expect(checkSidecar(text, `sha256:${'b'.repeat(64)}`, model)).toMatchObject({
      ok: false,
      reason: 'other-version',
      // The other version's annotations come back (carried over or kept for the revision transfer).
      doc: { markers: [{ id: 'm1' }] },
      droppedFields: [],
    });
    const finer = { ...model, tessellation: { linearDeflection: 0.05, angularDeflection: 0.5 } };
    expect(checkSidecar(text, HASH, finer)).toMatchObject({ ok: false, reason: 'other-version' });
    expect(checkSidecar('{oops', HASH, model)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('mesh files: format written, no tessellation, read back; a STEP sidecar is refused', () => {
    const stepModel = makeModel();
    const model = { ...stepModel, meshFormat: 'stl' as const };
    const doc = save(model, paintWith(model, { 1: 'm1' }), [marker('m1')]);
    expect(doc.model.format).toBe('stl');
    expect(doc.tessellation).toBeUndefined();
    expect(parseAnnotations(doc).ok).toBe(true);
    const text = JSON.stringify(doc);
    const check = checkSidecar(text, HASH, model);
    expect(check.ok).toBe(true);
    if (check.ok) expect(fromAnnotations(check.doc, model).paint.get(1)).toBe('m1');
    expect(checkSidecar(text, `sha256:${'b'.repeat(64)}`, model)).toMatchObject({
      ok: false,
      reason: 'other-version',
    });
    const stepText = JSON.stringify(save(stepModel, paintWith(stepModel, {}), []));
    expect(checkSidecar(stepText, HASH, model)).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(checkSidecar(text, HASH, stepModel)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('writes the mesh hash when given', () => {
    const model = makeModel();
    const meshHash = `sha256:${'d'.repeat(64)}`;
    const layer = paintWith(model, {});
    expect(save(model, layer, []).model.meshHash).toBeUndefined();
    const doc = toAnnotations({
      fileName: 'part.step',
      contentHash: HASH,
      meshHash,
      model,
      markers: [],
      comments: [],
      paint: layer,
    });
    expect(doc.model.meshHash).toBe(meshHash);
    expect(checkSidecar(JSON.stringify(doc), HASH, model)).toMatchObject({ ok: true });
  });

  it('writes the body tree only when there is one', () => {
    const model = makeModel();
    const paint = paintWith(model, {});
    expect(save(model, paint, []).bodyTree).toBeUndefined();
    const bodyTree = {
      folders: [{ id: 'n1', name: 'Folder 1', parent: 'top' as const }],
      bodies: [{ body: 0, parent: { folder: 'n1' } }],
      assemblies: [],
    };
    const doc = toAnnotations({
      fileName: 'part.step',
      contentHash: HASH,
      model,
      markers: [],
      comments: [],
      paint,
      bodyTree,
    });
    expect(doc.bodyTree).toEqual(bodyTree);
    expect(parseAnnotations(doc).ok).toBe(true);
  });

  it('writes body fingerprints and one fingerprint per held entity', () => {
    const model = makeModel();
    const paint = paintWith(model, {});
    expect(save(model, paint, []).bodies).toBeUndefined();
    const bodies = [
      {
        name: 'Body 1',
        size: [5, 1, 0] as [number, number, number],
        centre: [2.5, 0.5, 0] as [number, number, number],
        area: 2.5,
      },
    ];
    const asked: string[] = [];
    const doc = toAnnotations({
      fileName: 'part.step',
      contentHash: HASH,
      model,
      markers: [
        marker('m1', { entities: [{ kind: 'face', id: 1, seq: 0 }] }),
        marker('m2', {
          entities: [
            { kind: 'edge', id: 4, seq: 1 },
            { kind: 'body', id: 0, seq: 2 },
          ],
        }),
      ],
      comments: [],
      paint,
      fingerprints: {
        bodies,
        entities: (refs) => {
          asked.push(refs.map((r) => `${r.kind}:${String(r.id)}`).join(' '));
          return refs.map((r) => (r.kind === 'body' ? { body: r.id } : { body: 0, type: r.kind }));
        },
      },
    });
    // One call for all markers (faces share one mesh pass).
    expect(asked).toEqual(['face:1 edge:4 body:0']);
    expect(doc.bodies).toEqual(bodies);
    expect(doc.markers[0]?.entities[0]).toEqual({
      kind: 'face',
      id: 1,
      seq: 0,
      fingerprint: { body: 0, type: 'face' },
    });
    expect(doc.markers[1]?.entities[1]?.fingerprint).toEqual({ body: 0 });
    const parsed = parseAnnotations(doc);
    expect(parsed.ok && parsed.droppedFields).toEqual([]);
    // Loading keeps only kind / id / seq in the app's markers.
    expect(fromAnnotations(doc, model).markers[0]?.entities).toEqual([
      { kind: 'face', id: 1, seq: 0 },
    ]);
  });
});
