import { pushRun, type Annotations, type CommentStatus, type MarkerData } from '@third-wheel/core';
import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { bodyFingerprints, edgeMidpoint, entityFingerprints } from './fingerprint.js';
import type { StepModel } from './model.js';
import {
  commentPayload,
  estimateTokens,
  filterReviewPayload,
  reviewPayload,
  reviewPayloadText,
} from './review.js';
import { importStep } from './step-import.js';

let m: StepModel;

beforeAll(async () => {
  const k = await OcctKernel.init();
  // Body 0: 40×40×10 plate with a Ø6 hole at (10, 10). Body 1: Ø10 shaft, 20 tall, at x = 60.
  const plate = k.cut(k.makeBox(40, 40, 10), k.translate(k.makeCylinder(3, 10), 10, 10, 0));
  const shaft = k.translate(k.makeCylinder(5, 20), 60, 0, 0);
  m = importStep(k, k.exportStep(k.makeCompound([plate, shaft])));
}, 30_000);

const faceWhere = (pred: (id: number) => boolean): number => {
  const id = m.faceTypes.findIndex((_, i) => pred(i));
  expect(id).toBeGreaterThanOrEqual(0);
  return id;
};
const normal = (id: number, axis: number): number => m.faceGeometry[id * 8 + axis] ?? NaN;
const hole = (): number => faceWhere((i) => m.faceBody[i] === 0 && m.faceTypes[i] === 'cylinder');
const shaftSide = (): number =>
  faceWhere((i) => m.faceBody[i] === 1 && m.faceTypes[i] === 'cylinder');
const plateTop = (): number =>
  faceWhere((i) => m.faceBody[i] === 0 && m.faceTypes[i] === 'plane' && normal(i, 2) > 0.5);
const plateRight = (): number =>
  faceWhere((i) => m.faceBody[i] === 0 && m.faceTypes[i] === 'plane' && normal(i, 0) > 0.5);
const holeCircle = (): number =>
  m.edgeTypes.findIndex((t, i) => t === 'circle' && m.edgeBody[i] === 0);

/** Paint covering whole faces. */
function paintFaces(...faces: number[]): MarkerData['paint'] {
  return {
    faces: faces.map((faceId) => {
      const triangles: [number, number][] = [];
      for (let t = 0; t < m.triangleFace.length; t++)
        if (m.triangleFace[t] === faceId) pushRun(triangles, t);
      return { faceId, triangles };
    }),
  };
}

const time = '2026-11-08T12:00:00.000Z';
function review(): Annotations {
  return {
    schemaVersion: 1,
    model: { fileName: 'plate.step', format: 'step', contentHash: `sha256:${'0'.repeat(64)}` },
    tessellation: { ...m.tessellation },
    markers: [
      {
        id: 'm1',
        name: 'Hole',
        color: '#ff0000',
        visible: true,
        entities: [],
        paint: paintFaces(hole()),
      },
      {
        id: 'm2',
        name: 'Edge + side',
        color: '#00ff00',
        visible: true,
        entities: [
          { kind: 'face', id: plateRight(), seq: 2 },
          { kind: 'edge', id: holeCircle(), seq: 1 },
        ],
        paint: { faces: [] },
      },
      // Two patches on two bodies: plate top + shaft side.
      {
        id: 'm3',
        name: 'Two',
        color: '#0000ff',
        visible: true,
        entities: [{ kind: 'body', id: 1, seq: 3 }],
        paint: paintFaces(plateTop(), shaftSide()),
      },
      // No comment points here: left out of the payload.
      {
        id: 'm4',
        name: 'Unused',
        color: '#888888',
        visible: true,
        entities: [],
        paint: { faces: [] },
      },
    ],
    comments: [
      {
        id: 'c1',
        text: 'Make this hole 8 mm',
        markerIds: ['m1'],
        status: 'open',
        author: 'human',
        createdAt: time,
        updatedAt: time,
      },
      {
        id: 'c2',
        text: 'Chamfer this edge',
        markerIds: ['m2', 'm1'],
        status: 'resolved',
        author: 'human',
        createdAt: time,
        updatedAt: time,
        note: 'added 1 mm chamfer',
      },
      {
        id: 'c3',
        text: 'Same height for both',
        markerIds: ['m3'],
        status: 'open',
        author: 'human',
        createdAt: time,
        updatedAt: time,
      },
      {
        id: 'c4',
        text: 'Looks good overall',
        markerIds: [],
        status: 'open',
        author: 'ai',
        createdAt: time,
        updatedAt: time,
      },
    ],
  };
}

describe('reviewPayload', () => {
  it('matches the snapshot (comments, referenced markers, rounded paint + entities)', () => {
    expect(reviewPayload(m, review())).toMatchSnapshot();
  });

  it('lists only markers that comments point at, in first-mention order', () => {
    const p = reviewPayload(m, review());
    expect(p.markers.map((x) => x.id)).toEqual(['m1', 'm2', 'm3']);
    expect(p.comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(p.bodies).toEqual({ '0': m.bodyNames[0], '1': m.bodyNames[1] });
  });

  it("measured: only when the comment's markers hold exactly two entities", () => {
    const p = reviewPayload(m, review());
    const c2 = p.comments.find((c) => c.id === 'c2');
    // Hole circle edge ↔ the plate's right side: axis 30 mm from the plane (the drawn one).
    expect(c2?.measured?.main).toEqual({ kind: 'distance', value: 30 });
    expect(c2?.measured?.planeDistance).toBe(30);
    expect(c2?.measured?.between.map((r) => r.kind).sort()).toEqual(['edge', 'face']);
    // c1: paint only; c3: one body (+ paint) → nothing measured.
    expect(p.comments.find((c) => c.id === 'c1')?.measured).toBeUndefined();
    expect(p.comments.find((c) => c.id === 'c3')?.measured).toBeUndefined();
    // Three entities → nothing.
    const doc = review();
    const three = {
      ...doc,
      comments: doc.comments.map((c) => (c.id === 'c2' ? { ...c, markerIds: ['m2', 'm3'] } : c)),
    };
    expect(reviewPayload(m, three).comments.find((c) => c.id === 'c2')?.measured).toBeUndefined();
  });

  it('describes a painted hole: area, normal, cylinder face with radius and full coverage', () => {
    const m1 = reviewPayload(m, review()).markers[0];
    expect(m1?.paint?.patchCount).toBe(1);
    expect(m1?.paint?.patches).toBeUndefined();
    const f = m1?.paint?.faces[0];
    expect(f).toMatchObject({
      kind: 'face',
      type: 'cylinder',
      form: 'hole',
      radius: 3,
      covered: 1,
    });
    // All ways round: the normals cancel out.
    expect(m1?.paint?.flatness).toBeLessThan(0.1);
  });

  it('held entities in the order they were added; full circle has no arcAngle', () => {
    const m2 = reviewPayload(m, review()).markers[1];
    expect(m2?.paint).toBeUndefined();
    expect(m2?.entities?.map((e) => e.kind)).toEqual(['edge', 'face']);
    expect(m2?.entities?.[0]).toMatchObject({ type: 'circle', radius: 3 });
    expect(m2?.entities?.[0]?.arcAngle).toBeUndefined();
  });

  it('sends the thread: an old note first, the latest replies only', () => {
    const doc = review();
    const c2 = doc.comments[1];
    if (!c2) throw new Error('no c2');
    const at = '2026-11-09T10:00:00.000Z';
    const replies = Array.from({ length: 4 }, (_, i) => ({
      id: `r${String(i + 1)}`,
      text: `reply ${String(i + 1)}`,
      author: i % 2 === 0 ? ('human' as const) : ('ai' as const),
      createdAt: at,
      updatedAt: at,
      ...(i === 0 ? { status: 'open' as const } : {}),
    }));
    doc.comments[1] = { ...c2, replies };
    const p = reviewPayload(m, doc, { maxReplies: 3 });
    const out = p.comments[1];
    expect(out).not.toHaveProperty('note');
    expect(out?.moreReplies).toBe(2); // the old note + reply 1
    expect(out?.replies).toEqual([
      { by: 'ai', text: 'reply 2' },
      { by: 'human', text: 'reply 3' },
      { by: 'ai', text: 'reply 4' },
    ]);
    expect(reviewPayload(m, doc).comments[1]?.replies?.[0]).toEqual({
      by: 'ai',
      text: 'added 1 mm chamfer',
      status: 'resolved',
    });
    expect(p.comments[0]).not.toHaveProperty('replies');
  });

  it('filters comments by status; their markers follow', () => {
    const p = reviewPayload(m, review(), { statuses: ['resolved'] });
    expect(p.comments.map((c) => c.id)).toEqual(['c2']);
    expect(p.markers.map((x) => x.id)).toEqual(['m2', 'm1']);
  });

  it('filterReviewPayload of the full payload = a payload made with those statuses', () => {
    const full = reviewPayload(m, review());
    const sets: CommentStatus[][] = [['open'], ['resolved'], ['wontfix'], ['open', 'resolved']];
    for (const statuses of sets)
      expect(filterReviewPayload(full, statuses)).toEqual(reviewPayload(m, review(), { statuses }));
  });

  it('card numbers count every comment, whatever the status filter', () => {
    const doc = review();
    const all = reviewPayload(m, doc).comments.map((c) => [c.id, c.n]);
    expect(all).toEqual(doc.comments.map((c, i) => [c.id, i + 1]));
    for (const c of reviewPayload(m, doc, { statuses: ['resolved'] }).comments)
      expect(c.n).toBe(doc.comments.findIndex((x) => x.id === c.id) + 1);
  });

  it('commentPayload keeps one comment with its own markers and bodies', () => {
    const full = reviewPayload(m, review());
    const c = full.comments.find((x) => x.markers.length > 0);
    if (!c) throw new Error('no comment with markers');
    const one = commentPayload(full, c.id);
    expect(one.comments).toEqual([c]);
    expect(one.markers.map((x) => x.id)).toEqual(c.markers);
    expect(commentPayload(full, 'nope').comments).toEqual([]);
  });

  it('linked model files go along with their comment', () => {
    const doc = review();
    const c1 = doc.comments[0];
    if (!c1) throw new Error('no comment');
    const linked = { ...doc, comments: [{ ...c1, linkedModels: ['lid.step'] }] };
    expect(reviewPayload(m, linked).comments[0]?.linkedModels).toEqual(['lid.step']);
    expect(reviewPayload(m, review()).comments[0]).not.toHaveProperty('linkedModels');
  });

  it('part requests go along with their comment', () => {
    const doc = review();
    const c1 = doc.comments[0];
    if (!c1) throw new Error('no comment');
    const part = {
      id: 'p1',
      source: {
        kind: 'library' as const,
        library: 'bd_warehouse',
        cls: 'HexNut',
        params: { size: 'M5-0.8' },
      },
      copies: 2,
      scope: 'whole' as const,
    };
    const asked = { ...doc, comments: [{ ...c1, parts: [part] }] };
    expect(reviewPayload(m, asked).comments[0]?.parts).toEqual([part]);
    expect(reviewPayload(m, review()).comments[0]).not.toHaveProperty('parts');
  });

  it('caps long lists, largest first, and says how many were left out', () => {
    const p = reviewPayload(m, review(), { maxFaces: 1, maxPatches: 1, maxEntities: 1 });
    const m3 = p.markers.find((x) => x.id === 'm3');
    expect(m3?.paint?.patchCount).toBe(2);
    expect(m3?.paint?.patches).toHaveLength(1);
    expect(m3?.paint?.faces).toHaveLength(1);
    expect(m3?.paint?.moreFaces).toBe(1);
    expect(m3?.paint?.morePatches).toBe(1);
    // Largest patch first: plate top (≈ 1572 mm²) over the shaft side (≈ 628 mm²).
    expect(m3?.paint?.patches?.[0]?.area).toBeGreaterThan(1500);
    expect(p.markers.find((x) => x.id === 'm2')?.moreEntities).toBe(1);
  });

  it('a typical review stays well under 2k tokens', () => {
    const text = reviewPayloadText(reviewPayload(m, review()));
    expect(estimateTokens(text)).toBeLessThan(2000);
    expect(text).not.toContain('triangles');
  });
});

describe('fingerprints', () => {
  it('bodies: name, size, centre, area for every body', () => {
    const b = bodyFingerprints(m, m.bodyCount);
    expect(b).toHaveLength(m.bodyCount);
    expect(b[0]).toMatchObject({ name: m.bodyNames[0], size: [40, 40, 10], centre: [20, 20, 5] });
    expect(b[1]?.size[2]).toBe(20);
    expect(b[0]?.area).toBeGreaterThan(2 * 1600);
  });

  it('entities: type, size and position; body entities point at the body fingerprint', () => {
    const bodies = bodyFingerprints(m, m.bodyCount);
    const [h, e, top, body] = entityFingerprints(
      m,
      [
        { kind: 'face', id: hole() },
        { kind: 'edge', id: holeCircle() },
        { kind: 'face', id: plateTop() },
        { kind: 'body', id: 1 },
      ],
      bodies,
    );
    expect(h).toMatchObject({ body: 0, type: 'cylinder', form: 'hole', radius: 3 });
    expect(h?.point?.[2]).toBeCloseTo(5, 3);
    expect(e).toMatchObject({ body: 0, type: 'circle', radius: 3 });
    expect(e?.length).toBeCloseTo(6 * Math.PI, 3);
    expect(top).toMatchObject({ type: 'plane', dir: [0, 0, 1] });
    expect(top?.point?.[2]).toBe(10);
    expect(body).toEqual({
      body: 1,
      point: bodies[1]?.centre,
      size: bodies[1]?.size,
      area: bodies[1]?.area,
    });
  });

  it('edgeMidpoint: halfway along the polyline', () => {
    const line = m.edgeTypes.findIndex(
      (t, i) => t === 'line' && Math.abs((m.edgeGeometry[i * 9 + 6] ?? 0) - 40) < 1e-6,
    );
    const p = edgeMidpoint(m, line);
    const s = m.edgeGeometry.subarray(line * 9 + 3, line * 9 + 6);
    const d = m.edgeGeometry.subarray(line * 9, line * 9 + 3);
    for (let i = 0; i < 3; i++) expect(p?.[i]).toBeCloseTo((s[i] ?? 0) + (d[i] ?? 0) * 20, 4);
  });
});
