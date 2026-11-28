import { describe, expect, it } from 'vitest';
import {
  annotationsSchema,
  type VersionLink,
  type Annotations,
  SCHEMA_VERSION,
  emptyAnnotations,
  parseAnnotations,
  parseAnnotationsJson,
} from './schema.js';

const HASH = `sha256:${'ab'.repeat(32)}`;
const TIME = '2026-11-08T10:00:00.000Z';

function sample(): Annotations {
  return {
    schemaVersion: 1,
    model: { fileName: 'bracket.step', format: 'step', contentHash: HASH },
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
    markers: [
      {
        id: 'm1',
        name: 'Marker 1',
        color: '#ff8a1f',
        visible: true,
        entities: [
          { kind: 'face', id: 12, seq: 0 },
          { kind: 'edge', id: 3, seq: 2 },
        ],
        paint: {
          faces: [
            {
              faceId: 12,
              triangles: [[100, 3]],
              pieces: [{ triangle: 103, tree: [1, 0, [1, 1, 0, 0], 0] }],
            },
            { faceId: 13, triangles: [[140, 1]] },
          ],
          samples: [0, 0, 0, 1, 2, 3],
        },
      },
      {
        id: 'm2',
        name: 'Hole',
        color: '#2fbf71',
        visible: false,
        entities: [{ kind: 'body', id: 0, seq: 1 }],
        // Pieces of one cut triangle may belong to several markers.
        paint: {
          faces: [{ faceId: 12, triangles: [], pieces: [{ triangle: 103, tree: [0, 1, 0, 0] }] }],
        },
      },
    ],
    comments: [
      {
        id: 'c1',
        text: 'Make this wall 2 mm thicker',
        markerIds: ['m1', 'm2'],
        status: 'open',
        author: 'human',
        createdAt: TIME,
        updatedAt: TIME,
      },
      {
        id: 'c2',
        text: 'Done, also rounded the edge',
        markerIds: ['m1'],
        status: 'resolved',
        author: 'ai',
        createdAt: TIME,
        updatedAt: '2026-11-08T11:00:00+01:00',
        note: 'added a 1 mm fillet',
      },
      {
        id: 'c3',
        text: 'General remark',
        markerIds: [],
        status: 'wontfix',
        author: 'human',
        createdAt: TIME,
        updatedAt: TIME,
      },
    ],
  };
}

function errorsOf(doc: unknown): string[] {
  const r = parseAnnotations(doc);
  return r.ok ? [] : [...r.errors];
}

describe('annotation schema', () => {
  it('accepts a full document and round-trips it through JSON', () => {
    const doc = sample();
    const r = parseAnnotationsJson(JSON.stringify(doc));
    expect(r).toEqual({ ok: true, data: doc, droppedFields: [] });
  });

  it('builds an empty document that validates', () => {
    const doc = emptyAnnotations(
      { fileName: 'a.step', format: 'step', contentHash: HASH },
      { linearDeflection: 0.1, angularDeflection: 0.5 },
    );
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parseAnnotations(doc).ok).toBe(true);
    const mesh = emptyAnnotations({ fileName: 'a.stl', format: 'stl', contentHash: HASH });
    expect(mesh).not.toHaveProperty('tessellation');
    expect(parseAnnotations(mesh).ok).toBe(true);
  });

  it('has no separate selections list (dropped on read)', () => {
    const r = parseAnnotations({ ...sample(), selections: [{ kind: 'face', id: 1 }] });
    expect(r.ok && 'selections' in r.data).toBe(false);
  });

  it('lists the fields dropped on read (unknown keys, malformed bodyTree)', () => {
    const doc = sample();
    const raw = {
      ...doc,
      selections: [],
      markers: doc.markers.map((m, i) => (i === 0 ? { ...m, label: 'x' } : m)),
      bodyTree: { folders: 'broken' },
    };
    const r = parseAnnotations(raw);
    expect(r.ok && [...r.droppedFields].sort()).toEqual([
      'bodyTree',
      'markers.0.label',
      'selections',
    ]);
  });

  it('refuses files without a schemaVersion or from a newer version', () => {
    expect(errorsOf({ markers: [] })[0]).toMatch(/not a Third Wheel annotation file/);
    expect(errorsOf(null)[0]).toMatch(/not a Third Wheel annotation file/);
    expect(errorsOf({ ...sample(), schemaVersion: 2 })[0]).toMatch(/newer version.*update the app/);
    expect(errorsOf({ ...sample(), schemaVersion: 0 }).length).toBeGreaterThan(0);
  });

  it('reports bad JSON instead of throwing', () => {
    const r = parseAnnotationsJson('{ "schemaVersion": 1,');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors[0]).toMatch(/not valid JSON/);
  });

  it('checks fields with readable paths', () => {
    const doc = sample();
    const bad = {
      ...doc,
      model: { ...doc.model, contentHash: 'md5:123' },
      markers: [{ ...doc.markers[0], color: 'orange' }, doc.markers[1]],
      comments: [{ ...doc.comments[0], status: 'done', author: 'bot', createdAt: 'yesterday' }],
    };
    const errors = errorsOf(bad);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^model\.contentHash: /),
        expect.stringMatching(/^markers\.0\.color: colour must be #rrggbb/),
        expect.stringMatching(/^comments\.0\.status: /),
        expect.stringMatching(/^comments\.0\.author: /),
        expect.stringMatching(/^comments\.0\.createdAt: /),
      ]),
    );
  });

  it('rejects bad entities and piece trees', () => {
    const doc = sample();
    const m = at(doc.markers, 0);
    expect(
      errorsOf({ ...doc, markers: [{ ...m, entities: [{ kind: 'solid', id: 1, seq: 0 }] }] })
        .length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf({ ...doc, markers: [{ ...m, entities: [{ kind: 'face', id: -1, seq: 0 }] }] })
        .length,
    ).toBeGreaterThan(0);
    const tree = (t: unknown): unknown => ({
      ...doc,
      comments: [],
      markers: [
        {
          ...m,
          paint: { faces: [{ faceId: 1, triangles: [], pieces: [{ triangle: 5, tree: t }] }] },
        },
      ],
    });
    expect(errorsOf(tree([1, 0, 1, 0]))).toEqual([]);
    expect(errorsOf(tree(1)).length).toBeGreaterThan(0); // root must be cut
    expect(errorsOf(tree([1, 0, 1])).length).toBeGreaterThan(0);
    expect(errorsOf(tree([1, 0, 2, 0])).length).toBeGreaterThan(0);
    expect(
      errorsOf({
        ...doc,
        markers: [{ ...m, paint: { faces: [], samples: [1, 2] } }],
        comments: [],
      })[0],
    ).toMatch(/x y z triples/);
  });

  it('needs tessellation for STEP only', () => {
    const noTess: Partial<Annotations> = sample();
    delete noTess.tessellation;
    expect(errorsOf(noTess)[0]).toMatch(/^tessellation: STEP models need tessellation/);
    expect(errorsOf({ ...noTess, model: { ...noTess.model, format: '3mf' } })).toEqual([]);
  });

  it('rejects duplicate ids and comments pointing at missing markers', () => {
    const doc = sample();
    const errors = errorsOf({
      ...doc,
      markers: [doc.markers[0], { ...doc.markers[1], id: 'm1' }],
      comments: [
        { ...doc.comments[0], markerIds: ['m1', 'm9', 'm1'] },
        { ...doc.comments[1], id: 'c1' },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'markers.1: duplicate marker id "m1"',
        'comments.1: duplicate comment id "c1"',
        'comments.0.markerIds.2: duplicate marker reference "m1"',
        'comments.0.markerIds.1: unknown marker "m9"',
      ]),
    );
  });

  it('rejects duplicate entities in one marker', () => {
    const doc = sample();
    const m = at(doc.markers, 0);
    const errors = errorsOf({
      ...doc,
      markers: [
        { ...m, entities: [...m.entities, { kind: 'face', id: 12, seq: 5 }] },
        doc.markers[1],
      ],
    });
    expect(errors).toEqual(['markers.0.entities.2: duplicate entity "face:12"']);
  });

  it('keeps one marker per whole triangle', () => {
    const doc = sample();
    const [m1, m2] = [at(doc.markers, 0), at(doc.markers, 1)];
    const twice = errorsOf({
      ...doc,
      markers: [m1, { ...m2, paint: { faces: [{ faceId: 12, triangles: [[101, 1]] }] } }],
    });
    expect(twice).toEqual([
      'markers.1.paint.faces.0.triangles: triangle 101 is already painted by marker "m1"',
    ]);
    const own = errorsOf({
      ...doc,
      markers: [
        {
          ...m1,
          paint: {
            faces: [
              {
                faceId: 1,
                triangles: [
                  [7, 1],
                  [7, 1],
                ],
              },
            ],
          },
        },
        m2,
      ],
    });
    expect(own[0]).toMatch(/triangle 7 is already painted by this marker/);
    const overlap = errorsOf({
      ...doc,
      markers: [
        {
          ...m1,
          paint: {
            faces: [
              {
                faceId: 1,
                triangles: [
                  [0, 10],
                  [5, 1e12],
                ],
              },
            ],
          },
        },
        m2,
      ],
    });
    expect(overlap[0]).toMatch(/triangle 5 is already painted by this marker/);
    const badRun = errorsOf({
      ...doc,
      markers: [{ ...m1, paint: { faces: [{ faceId: 1, triangles: [[3, 0]] }] } }, m2],
    });
    expect(badRun[0]).toMatch(/^markers\.0\.paint\.faces\.0\.triangles\.0\.1:/);
    const wholeAndCut = errorsOf({
      ...doc,
      markers: [
        m1,
        {
          ...m2,
          paint: {
            faces: [{ faceId: 12, triangles: [], pieces: [{ triangle: 100, tree: [1, 0, 0, 0] }] }],
          },
        },
      ],
    });
    expect(wholeAndCut).toEqual([
      'markers: triangle 100 is painted whole by marker "m1" and cut into pieces',
    ]);
  });
});

function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`no item ${String(i)}`);
  return item;
}

describe('annotation schema (edge cases)', () => {
  it('rejects a face listed twice in one marker and paths as file names', () => {
    const doc = sample();
    const m = at(doc.markers, 0);
    const twice = { faceId: 12, triangles: [] };
    expect(
      errorsOf({
        ...doc,
        markers: [{ ...m, paint: { faces: [twice, twice] } }, at(doc.markers, 1)],
      }),
    ).toEqual(['markers.0.paint.faces.1: duplicate face "12"']);
    for (const fileName of ['parts/a.step', 'C:\\parts\\a.step']) {
      expect(errorsOf({ ...doc, model: { ...doc.model, fileName } })).toEqual([
        'model.fileName: fileName must be a file name, not a path',
      ]);
    }
  });
});

describe('annotation schema: body tree', () => {
  it('accepts user folders and moved rows; a missing bodyTree is fine', () => {
    const bodyTree = {
      folders: [{ id: 'n1', name: 'Screws', parent: 'top' as const }],
      bodies: [{ body: 3, parent: { folder: 'n1' } }],
      assemblies: [{ assembly: 2, parent: { assembly: 0 } }],
    };
    const parsed = parseAnnotations({ ...sample(), bodyTree });
    expect(parsed.ok && parsed.data.bodyTree).toEqual(bodyTree);
    expect(parseAnnotations(sample()).ok).toBe(true);
  });

  it('drops a malformed bodyTree but keeps the rest of the file', () => {
    for (const bodyTree of [
      { folders: [], bodies: [{ body: 1, parent: 'somewhere' }], assemblies: [] },
      { folders: [{ id: 'n1', name: '', parent: 'top' }], bodies: [], assemblies: [] },
    ]) {
      const parsed = parseAnnotations({ ...sample(), bodyTree });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.data.bodyTree).toBeUndefined();
      expect(parsed.ok && parsed.data.markers.length).toBe(sample().markers.length);
    }
  });
});

describe('annotation schema: fingerprints', () => {
  const bodies = [
    { name: 'Bracket', size: [40, 40, 10], centre: [20, 20, 5], area: 4000 },
    { name: 'M3 screw', path: 'Assembly › Screws', size: [3, 3, 10], centre: [0, 0, 0], area: 90 },
  ];
  const withPrints = (): Annotations => {
    const doc = sample();
    const m = at(doc.markers, 0);
    return {
      ...doc,
      markers: [
        {
          ...m,
          entities: [
            {
              kind: 'face',
              id: 12,
              seq: 0,
              fingerprint: {
                body: 0,
                type: 'cylinder',
                form: 'hole',
                radius: 3,
                point: [10, 10, 5],
                dir: [0, 0, 1],
                area: 188,
              },
            },
            {
              kind: 'edge',
              id: 3,
              seq: 2,
              fingerprint: { body: 0, type: 'line', length: 40, point: [20, 0, 0] },
            },
          ],
        },
        ...doc.markers.slice(1),
      ],
    };
  };

  it('keeps entity and body fingerprints; files without them are fine', () => {
    const parsed = parseAnnotations({ ...withPrints(), bodies });
    expect(parsed.ok && parsed.data.bodies).toEqual(bodies);
    expect(parsed.ok && parsed.data.markers[0]?.entities[0]?.fingerprint?.radius).toBe(3);
    expect(parsed.ok && parsed.droppedFields).toEqual([]);
    expect(parseAnnotations(sample()).ok).toBe(true);
  });

  it('drops a malformed fingerprint or body list but keeps the rest (and reports it)', () => {
    const doc = withPrints();
    const m = at(doc.markers, 0);
    const broken = {
      ...doc,
      markers: [
        {
          ...m,
          entities: [{ ...at(m.entities, 0), fingerprint: { point: [1, 2] } }, at(m.entities, 1)],
        },
        ...doc.markers.slice(1),
      ],
      bodies: [{ name: 'no size' }],
    };
    const parsed = parseAnnotations(broken);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.bodies).toBeUndefined();
    expect(parsed.data.markers[0]?.entities[0]?.fingerprint).toBeUndefined();
    expect(parsed.data.markers[0]?.entities[1]?.fingerprint?.length).toBe(40);
    expect(parsed.droppedFields).toEqual(['markers.0.entities.0.fingerprint', 'bodies']);
  });

  it('keeps a mesh hash and drops a malformed one', () => {
    const doc = sample();
    const meshHash = `sha256:${'c'.repeat(64)}`;
    const good = parseAnnotations({ ...doc, model: { ...doc.model, meshHash } });
    expect(good.ok && good.data.model.meshHash).toBe(meshHash);
    const bad = parseAnnotations({ ...doc, model: { ...doc.model, meshHash: 'x' } });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.data.model.meshHash).toBeUndefined();
    expect(bad.droppedFields).toEqual(['model.meshHash']);
  });
});

// Old notes files (v1) carry a version chain; it is read when they move into a project.
const hash = (c: string): string => `sha256:${c.repeat(64)}`;
const link = (name: string, c: string, more: Partial<VersionLink> = {}): VersionLink => ({
  path: `/m/${name}`,
  name,
  contentHash: hash(c),
  date: '2026-11-09T14:02:00.000Z',
  ...more,
});

describe('versions in the sidecar', () => {
  const doc = {
    schemaVersion: 1,
    model: { fileName: 'b.step', format: 'step', contentHash: hash('b') },
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
    markers: [],
    comments: [],
  };

  it('reads a chain', () => {
    const versions = { earlier: [link('a.step', 'a', { overwritten: true })] };
    expect(annotationsSchema.parse({ ...doc, versions }).versions).toEqual(versions);
  });

  it('drops a malformed chain, never the file', () => {
    const parsed = annotationsSchema.parse({ ...doc, versions: { earlier: [{ path: 3 }] } });
    expect(parsed.versions).toBeUndefined();
  });
});
