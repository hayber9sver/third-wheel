import { SCHEMA_VERSION, type Annotations } from '@third-wheel/core';
import { describe, expect, it } from 'vitest';
import {
  annotationCounts,
  carriedText,
  hasNotes,
  keptAlsoText,
  keptOwnText,
  mergeMarkers,
  ownMarkersQuestion,
  shortName,
  matchFacts,
  matchMarkersByName,
  withoutMarkersOf,
  movedText,
  revisionResult,
  transferSummary,
  sameGeometry,
  versionQuestionText,
  meshMovedText,
  meshQuestion,
  waitingText,
  placedAndLost,
  differentPartQuestion,
  differentPartNote,
  type PreviousAnnotations,
} from './revision.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const MESH = `sha256:${'b'.repeat(64)}`;
const OTHER = `sha256:${'c'.repeat(64)}`;
const TESS = { linearDeflection: 0.1, angularDeflection: 0.5 };

function doc(meshHash?: string, markers = 2, comments = 3): Annotations {
  return {
    schemaVersion: SCHEMA_VERSION,
    model: {
      fileName: 'part.step',
      format: 'step',
      contentHash: HASH,
      ...(meshHash ? { meshHash } : {}),
    },
    tessellation: TESS,
    markers: Array.from({ length: markers }, (_, i) => ({
      id: `m${String(i + 1)}`,
      name: `Marker ${String(i + 1)}`,
      color: '#ff0000',
      visible: true,
      entities: [],
      paint: { faces: [] },
    })),
    comments: Array.from({ length: comments }, (_, i) => ({
      id: `c${String(i + 1)}`,
      text: 'x',
      markerIds: [],
      status: 'open' as const,
      author: 'human' as const,
      createdAt: '2026-11-09T10:00:00.000Z',
      updatedAt: '2026-11-09T10:00:00.000Z',
    })),
  };
}

const prev = (d: Annotations, own: boolean): PreviousAnnotations => ({
  doc: d,
  droppedFields: [],
  path: own ? '/a/part.step' : '/a/part-v1.step',
  name: own ? 'part.step' : 'part-v1.step',
  own,
});

describe('revision', () => {
  it('same geometry = same mesh hash and mesh settings', () => {
    expect(sameGeometry(doc(MESH), MESH, TESS)).toBe(true);
    expect(sameGeometry(doc(MESH), OTHER, TESS)).toBe(false);
    expect(sameGeometry(doc(MESH), MESH, { ...TESS, linearDeflection: 0.05 })).toBe(false);
  });

  it('a sidecar without a mesh hash fits only by the previous model in memory', () => {
    expect(sameGeometry(doc(), MESH, TESS)).toBe(false);
    expect(sameGeometry(doc(), MESH, TESS, MESH)).toBe(true);
    expect(sameGeometry(doc(), MESH, TESS, OTHER)).toBe(false);
    // The saved hash wins over the one in memory.
    expect(sameGeometry(doc(OTHER), MESH, TESS, MESH)).toBe(false);
  });

  it('counts what the previous version had', () => {
    expect(annotationCounts(doc(MESH))).toBe('2 markers and 3 comments');
    expect(annotationCounts(doc(MESH, 1, 0))).toBe('1 marker');
    expect(annotationCounts(doc(MESH, 0, 1))).toBe('1 comment');
    expect(annotationCounts(doc(MESH, 0, 0))).toBe('no annotations');
  });

  it('words the "new version?" question', () => {
    expect(versionQuestionText('part-v2.step', prev(doc(MESH), false))).toBe(
      'part-v1.step has 2 markers and 3 comments. Bring them over to part-v2.step? They are moved onto the new geometry; part-v1.step and its notes stay as they are.',
    );
  });

  it('words the carried-over notice for the same file and for another one', () => {
    expect(carriedText(prev(doc(MESH), true), 'part.step')).toBe(
      'part.step changed on disk, but its geometry is the same: 2 markers and 3 comments carried over.',
    );
    expect(carriedText(prev(doc(MESH), false), 'part-v2.step')).toMatch(
      /^part-v2\.step has the same geometry as part-v1\.step: 2 markers/,
    );
    expect(carriedText(prev(doc(MESH), false), 'part-v2.step', 'o.bak.json')).toMatch(
      /carried over\. Its own older annotations were moved to o\.bak\.json\.$/,
    );
  });

  it('says where the annotations stay when the geometry changed', () => {
    const own = waitingText(prev(doc(MESH), true), 'part.step', 'the model file changed', 'b.json');
    expect(own).toMatch(/new version \(the model file changed\).*were moved to b\.json/);
    expect(own).toMatch(/could not be moved/);
    expect(waitingText(prev(doc(MESH), true), 'part.step', 'x', null)).toMatch(/left as they are/);
    expect(waitingText(prev(doc(MESH), false), 'part-v2.step', '', null)).toMatch(
      /^part-v2\.step is a new version of part-v1\.step\. Its 2 markers and 3 comments stay saved with part-v1\.step/,
    );
  });

  it('tells the AI the previous file and its counts', () => {
    expect(revisionResult(prev(doc(MESH), false), 'waiting', doc(MESH))).toEqual({
      of: 'part-v1.step',
      path: '/a/part-v1.step',
      annotations: 'waiting',
      markers: 2,
      comments: 3,
    });
    expect(revisionResult({ name: 'a.step', path: '/a.step' }, 'none')).toMatchObject({
      markers: 0,
      comments: 0,
    });
  });

  it('counts the transfer per status and lists the flagged markers', () => {
    const d = doc(MESH, 3);
    const sum = transferSummary(d, { m1: 'found', m2: 'changed' });
    expect(sum).toEqual({
      found: 1,
      changed: 1,
      lost: 1, // no status = lost
      check: 0,
      flagged: [
        { id: 'm2', name: 'Marker 2', status: 'changed' },
        { id: 'm3', name: 'Marker 3', status: 'lost' },
      ],
    });
    expect(revisionResult(prev(d, false), 'moved', d, sum).transfer).toBe(sum);
  });

  it('words the notice after moving annotations', () => {
    const d = doc(MESH, 3);
    const sum = transferSummary(d, { m1: 'found', m2: 'changed' });
    expect(movedText(prev(d, false), 'part-v2.step', sum, null)).toBe(
      'part-v2.step is a new version of part-v1.step: 3 markers moved over — 1 found, 1 changed, 1 lost. Look for ⚠ in Markers.',
    );
    const all = transferSummary(d, { m1: 'found', m2: 'found', m3: 'found' });
    expect(movedText(prev(d, true), 'part.step', all, 'p.bak.json')).toBe(
      "part.step changed on disk: 3 markers moved onto the new geometry, all found. Its earlier geometry isn't kept. The old file was kept as p.bak.json.",
    );
  });
});

describe('mesh → STEP', () => {
  const stl: PreviousAnnotations = {
    ...prev(doc(), false),
    path: '/a/cover.stl',
    name: 'cover.stl',
  };
  const sum = { found: 2, changed: 0, lost: 0, check: 0, flagged: [] };
  const cov = {
    points: 1000,
    matched: 996,
    surface: 1,
    toleranceMm: 0.986,
    mirrored: false,
    meshRead: true,
  };

  it('asks whether the STEP is the same part', () => {
    expect(meshQuestion('cover.step', stl)).toEqual({
      title: 'Is cover.step the same part as cover.stl?',
      text: 'cover.stl has 2 markers and 3 comments. Bring them onto cover.step? The two files are lined up and the paint goes onto the nearest STEP faces; cover.stl and its notes stay as they are.',
    });
  });

  it('reports the share of paint matched and the tolerance', () => {
    expect(meshMovedText(stl, 'cover.step', sum, cov, null)).toBe(
      'Notes from cover.stl moved onto cover.step: 2 markers, 99 % of the paint matched a STEP face within 0.99 mm.',
    );
  });

  it('flags lost markers, a poor fit and a mirror', () => {
    const bad = { ...sum, found: 1, lost: 1 };
    expect(
      meshMovedText(stl, 'cover.step', bad, { ...cov, matched: 400, surface: 0.42 }, null),
    ).toBe(
      'Notes from cover.stl moved onto cover.step: 2 markers, 40 % of the paint matched a STEP face within 0.99 mm (1 lost). Look for ⚠ in Markers. Only 42 % of the mesh lies on the STEP surface: the files may be different parts or versions.',
    );
    expect(
      meshMovedText(
        stl,
        'cover.step',
        { ...sum, found: 0, check: 2 },
        { ...cov, mirrored: true },
        null,
      ),
    ).toContain('only fits the STEP as a mirror image');
  });
});

describe('a new version with notes of its own', () => {
  it('an empty notes file counts as no notes', () => {
    expect(hasNotes(doc(MESH, 0, 0))).toBe(false);
    // doc()'s markers are empty (no paint, no entities): like an unused "Marker 1".
    expect(hasNotes(doc(MESH, 1, 0))).toBe(false);
    const held = doc(MESH, 1, 0);
    expect(
      hasNotes({
        ...held,
        markers: held.markers.map((m) => ({
          ...m,
          entities: [{ kind: 'face' as const, id: 3, seq: 0 }],
        })),
      }),
    ).toBe(true);
    const painted = doc(MESH, 1, 0);
    expect(
      hasNotes({
        ...painted,
        markers: painted.markers.map((m) => ({
          ...m,
          paint: { faces: [{ faceId: 0, triangles: [[0, 1]] }] },
        })),
      }),
    ).toBe(true);
    expect(hasNotes(doc(MESH, 0, 1))).toBe(true);
  });
  it('words the notice when a new version keeps its own markers', () => {
    expect(keptOwnText('bracket_v2.step', 'bracket.step')).toBe(
      'bracket_v2.step uses its own markers; none came from bracket.step.',
    );
  });
});

describe('a new version with markers of its own: its own / the earlier / both', () => {
  const paintAll = (d: Annotations): Annotations => ({
    ...d,
    markers: d.markers.map((m) => ({
      ...m,
      paint: { faces: [{ faceId: 1, triangles: [[0, 1]] as [number, number][] }] },
    })),
  });
  const prev: PreviousAnnotations = {
    doc: paintAll(doc(MESH, 3, 2)),
    droppedFields: [],
    path: '/p/bracket.step',
    name: 'bracket.step',
    own: false,
  };
  it('words the question: buttons name whose markers, details on hover', () => {
    const q = ownMarkersQuestion('bracket_v2.step', prev.name);
    expect(q.title).toBe('Which markers should bracket_v2.step use?');
    expect(q.text).toBe('Comments are shared by all versions.');
    expect([q.keep, q.replace, q.merge]).toEqual([
      'bracket_v2.step (new)',
      'bracket.step (earlier)',
      'Both',
    ]);
    expect(q.tips.keep).toBe(
      'Use the markers made on bracket_v2.step. One with the name of an earlier marker is that marker (its comments apply). Nothing moves from bracket.step.',
    );
    expect(q.tips.replace).toContain('kept in a backup copy');
    expect(q.tips.merge).toContain('add those of bracket.step');
  });
  it('cuts a long file name in the middle, keeping its version suffix', () => {
    expect(shortName('bracket.step')).toBe('bracket.step');
    const long = 'mounting-bracket-for-the-left-side_v12.step';
    const cut = shortName(long);
    expect(cut).toHaveLength(22);
    expect(cut.startsWith('mounting-b')).toBe(true);
    expect(cut.endsWith('_v12.step')).toBe(true);
    expect(cut).toContain('…');
  });
  const mark = (
    id: string,
    name: string,
    color: string,
    painted: boolean,
  ): Annotations['markers'][number] => ({
    ...(doc(MESH, 1, 0).markers[0] as Annotations['markers'][number]),
    id,
    name,
    color,
    paint: painted
      ? { faces: [{ faceId: 1, triangles: [[0, 1]] as [number, number][] }] }
      : { faces: [] },
  });
  it("same name = same marker: its own marker takes the listed one's id, the empty row goes", () => {
    // Two files marked on their own: both have an orange "Marker 1"; the earlier one's (d1) is only
    // listed here because shared comment c1 names it. The new file's own comment c2 names e1.
    const base = doc(MESH, 0, 2);
    const own = {
      ...base,
      markers: [mark('e1', 'marker 1', '#ff8a1f', true), mark('d1', 'Marker 1', '#2fbf71', false)],
      comments: [
        { ...base.comments[0], markerIds: ['d1'] },
        { ...base.comments[1], markerIds: ['e1', 'd1'] },
      ],
    } as Annotations;
    const out = matchMarkersByName(own, []);
    // The project's name / colour (case ignored when matching); its own paint.
    expect(out.doc.markers.map((m) => [m.id, m.name, m.color, m.paint.faces.length])).toEqual([
      ['d1', 'Marker 1', '#2fbf71', 1],
    ]);
    expect(out.doc.comments.map((c) => c.markerIds)).toEqual([['d1'], ['d1']]);
    expect(out.matched).toEqual(['Marker 1']);
    expect(out.recoloured).toEqual([]);
  });
  it("matches the earlier version's markers too; nothing of theirs changes", () => {
    const own = {
      ...doc(MESH, 0, 0),
      markers: [mark('e1', 'Hole', '#ff8a1f', true), mark('e2', 'Rib', '#2fbf71', true)],
    } as Annotations;
    const earlier = [mark('d1', 'Hole', '#8b5cf6', true), mark('d2', 'Slot', '#e0409a', true)];
    const before = JSON.stringify(earlier);
    const out = matchMarkersByName(own, earlier);
    expect(out.doc.markers.map((m) => [m.id, m.name, m.color])).toEqual([
      ['d1', 'Hole', '#8b5cf6'],
      ['e2', 'Rib', '#2fbf71'],
    ]);
    expect(JSON.stringify(earlier)).toBe(before);
  });
  it('the earlier version only listing its own marker (shared comment) still matches by name', () => {
    // Once both files share a part, d lists e's marker e1 too (comment "From e" names it).
    const own = {
      ...doc(MESH, 0, 0),
      markers: [mark('e1', 'Marker 2', '#ff8a1f', true), mark('d2', 'Marker 2', '#2fbf71', false)],
    } as Annotations;
    const earlier = [
      mark('d2', 'Marker 2', '#2fbf71', true),
      mark('e1', 'Marker 2', '#ff8a1f', false),
    ];
    const out = matchMarkersByName(own, earlier);
    expect(out.doc.markers.map((m) => [m.id, m.color])).toEqual([['d2', '#2fbf71']]);
    // An unmatched marker never clashes with its own listed copy on the earlier version.
    const alone = { ...own, markers: [mark('e1', 'Rib', '#ff8a1f', true)] } as Annotations;
    expect(matchMarkersByName(alone, [mark('e1', 'Rib', '#ff8a1f', false)]).doc).toBe(alone);
  });
  it('a marker of its own that matches none gets a free colour when its colour is taken here', () => {
    // Marker 1 matches (takes teal); Marker 3 was teal → a free colour, said in the notice.
    const own = {
      ...doc(MESH, 0, 0),
      markers: [
        mark('e1', 'Marker 1', '#ff8a1f', true),
        mark('e3', 'Marker 3', '#19b5c8', true),
        mark('d1', 'Marker 1', '#19b5c8', false),
      ],
    } as Annotations;
    const out = matchMarkersByName(own, []);
    expect(out.doc.markers.map((m) => [m.id, m.color])).toEqual([
      ['d1', '#19b5c8'],
      ['e3', '#ff8a1f'],
    ]);
    expect(out.recoloured).toEqual([{ name: 'Marker 3', taken: '#19b5c8' }]);
    // The AI's load_model result says the same.
    expect(matchFacts(out)).toEqual({
      matched: ['Marker 1'],
      recoloured: [{ name: 'Marker 3', taken: '#19b5c8' }],
    });
    expect(matchFacts(undefined)).toEqual({});
    expect(keptOwnText('b_v2.step', 'b.step', out)).toBe(
      'b_v2.step uses its own markers; none came from b.step. Marker 1 has the name of an earlier marker, so it is that marker: its comments apply here. Marker 3 got a new colour: teal was taken.',
    );
  });
  it('two earlier markers with one name (an old project): the name matches neither', () => {
    const own = {
      ...doc(MESH, 0, 0),
      markers: [mark('e1', 'Hole', '#e5484d', true)],
    } as Annotations;
    const earlier = [mark('d1', 'Hole', '#8b5cf6', true), mark('d2', 'hole', '#e0409a', true)];
    const out = matchMarkersByName(own, earlier);
    expect(out.matched).toEqual([]);
    expect(out.doc.markers.map((m) => m.id)).toEqual(['e1']);
  });
  it('nothing matched or clashing → the same object (nothing to save); listed rows stay', () => {
    const own = {
      ...doc(MESH, 0, 0),
      markers: [mark('e1', 'Marker 1', '#ff8a1f', true), mark('d1', 'Hole', '#123456', false)],
    } as Annotations;
    const out = matchMarkersByName(own, [mark('d2', 'Slot', '#2fbf71', true)]);
    expect(out.doc).toBe(own);
    expect(out.matched).toEqual([]);
  });
  it('merge moves only the markers the new file lacks, and keeps its own as they are', () => {
    const own = paintAll(doc(MESH, 1, 2)); // m1, comments c1 c2
    const rest = withoutMarkersOf(prev.doc, own);
    expect(rest.markers.map((m) => m.id)).toEqual(['m2', 'm3']);
    const moved = {
      ...rest,
      comments: [...rest.comments, { ...rest.comments[0], id: 'c9' }],
    } as Annotations;
    const merged = mergeMarkers(
      { ...own, markers: [{ ...own.markers[0], name: 'Mine' }] } as Annotations,
      moved,
    );
    expect(merged.markers.map((m) => [m.id, m.name])).toEqual([
      ['m1', 'Mine'],
      ['m2', 'Marker 2'],
      ['m3', 'Marker 3'],
    ]);
    expect(merged.comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c9']);
    expect(keptAlsoText('bracket_v2.step', own)).toBe('bracket_v2.step kept its own 1 marker.');
  });
  it('merge: an earlier marker named like one of its own is not moved; moved ones keep their names', () => {
    const own = {
      ...doc(MESH, 0, 0),
      markers: [mark('a1', 'Marker 1', '#ff8a1f', true), mark('a2', 'Hole', '#654321', true)],
    } as Annotations;
    const earlier = {
      ...doc(MESH, 0, 0),
      markers: [mark('b1', 'marker 1', '#ff8a1f', true), mark('b2', 'Slot', '#ff8a1f', true)],
    } as Annotations;
    const rest = withoutMarkersOf(earlier, own);
    expect(rest.markers.map((m) => m.id)).toEqual(['b2']);
    const merged = mergeMarkers(own, rest);
    expect(merged.markers.map((m) => [m.id, m.name, m.color])).toEqual([
      ['a1', 'Marker 1', '#ff8a1f'],
      ['a2', 'Hole', '#654321'],
      ['b2', 'Slot', '#ff8a1f'],
    ]);
  });
  it('merge: an empty marker the new file only lists (a shared comment names it) still comes over', () => {
    const painted = (id: string) => ({
      ...doc(MESH, 1, 0).markers[0],
      id,
      name: `Marker ${id}`,
      paint: { faces: [{ faceId: 1, triangles: [[0, 1]] as [number, number][] }] },
    });
    const own = {
      ...doc(MESH, 0, 0),
      markers: [painted('m1'), { ...painted('m2'), paint: { faces: [] } }],
    } as Annotations;
    const earlier = { ...doc(MESH, 0, 0), markers: [painted('m1'), painted('m2')] } as Annotations;
    const rest = withoutMarkersOf(earlier, own);
    expect(rest.markers.map((m) => m.id)).toEqual(['m2']);
    const merged = mergeMarkers(own, rest);
    expect(merged.markers.map((m) => [m.id, m.paint.faces.length])).toEqual([
      ['m1', 1],
      ['m2', 1],
    ]);
    expect(keptAlsoText('x.step', own)).toBe('x.step kept its own 1 marker.');
  });
});

describe('a new version that looks like another part', () => {
  it('counts only markers placed on the earlier version', () => {
    const d = doc(MESH, 4, 0);
    const [a, b, c, e] = d.markers;
    if (!a || !b || !c || !e) throw new Error('four markers');
    const placed: Annotations = {
      ...d,
      markers: [
        { ...a, paint: { faces: [1] } },
        { ...b, entities: [{ kind: 'face', id: 2 }] },
        { ...c, paint: { faces: [], samples: [{ p: [0, 0, 0], face: 3 }] } },
        e, // listed only: no sign either way
      ],
    } as Annotations;
    expect(placedAndLost(placed, { m1: 'lost', m2: 'found', m4: 'lost' })).toEqual({
      held: 3,
      lost: 2, // m1 lost, m3 has no status (= lost)
    });
  });
  it('asks with the reason; New version first', () => {
    const q = differentPartQuestion('lid.step', 'base.step', '6 of 8 markers lost');
    expect(q.title).toBe('The files look very different');
    expect(q.text).toBe('Is lid.step really a new version of base.step? 6 of 8 markers lost.');
    expect([q.version, q.separate]).toEqual(['New version', 'Separate part']);
    expect(q.tips.second).toContain('the file stays on disk');
  });
  it('tells where to undo it after the AI loaded it', () => {
    expect(
      differentPartNote('lid.step', 'base.step', 'size 40 × 20 × 10 mm → 120 × 80 × 5 mm'),
    ).toBe(
      ' The files look very different (size 40 × 20 × 10 mm → 120 × 80 × 5 mm): if lid.step is not a version of base.step, open base.step and remove lid.step under Versions ▾.',
    );
  });
});
