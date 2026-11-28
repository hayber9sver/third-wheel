import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addFileAsPart,
  applyNotes,
  findVersion,
  forgetMarkers,
  isEarlierVersion,
  linkAsNewer,
  notesOf,
  partVersions,
  relocateVersion,
  removeFromVersions,
  versionAtPath,
  versionFacts,
  replaceContents,
} from './project-notes.js';
import { parseProject, type Project, type VersionMarks } from './project-schema.js';
import { parseAnnotations, type Annotations } from './schema.js';
import { H, must, sampleMarks, sampleProject } from './testing/fixtures.js';

const P = path.posix;
const W = path.win32;
const FOLDER = '/work/bracket';
const NOW = new Date('2026-11-22T09:00:00.000Z');
const TESS = { linearDeflection: 0.1, angularDeflection: 0.5 };
let seed = 0;
let calls = 0;
/** Different bytes on every call (ids must not repeat). */
const random = (n: number): Uint8Array => {
  calls++;
  return Uint8Array.from({ length: n }, (_, i) => (calls * 31 + seed * 7 + i * 13) % 256);
};

function notes(
  over: Partial<Annotations> & { fileName?: string; hash?: string } = {},
): Annotations {
  const { fileName, hash, ...rest } = over;
  return {
    schemaVersion: 1,
    model: { fileName: fileName ?? 'bracket.step', format: 'step', contentHash: hash ?? H('a') },
    tessellation: TESS,
    markers: [],
    comments: [],
    ...rest,
  };
}

const marker = (id: string, faceId = 3) => ({
  id,
  name: `Marker ${id}`,
  color: '#00ff00',
  visible: true,
  entities: [],
  paint: { faces: [{ faceId, triangles: [[faceId * 10, 2]] as [number, number][] }] },
});

const comment = (id: string, markerIds: string[], text = 'fix this') => ({
  id,
  text,
  markerIds,
  status: 'open' as const,
  author: 'human' as const,
  createdAt: '2026-11-22T08:00:00.000Z',
  updatedAt: '2026-11-22T08:00:00.000Z',
});

const part = (id: string, markerIds: string[], extra: Record<string, unknown> = {}) => ({
  id,
  source: {
    kind: 'library' as const,
    library: 'bd_warehouse',
    cls: 'SocketHeadCapScrew',
    params: {},
  },
  copies: 1,
  scope: 'whole' as const,
  target: { markerIds },
  ...extra,
});

/** `newer` becomes a version made from `parent` (listed first when it isn't yet). */
function link(
  project: Project | undefined,
  newer: string,
  newerHash: string,
  parent: string,
  parentHash: string,
  over: { folder?: string; path?: typeof P } = {},
) {
  seed++;
  const opts = { folder: over.folder ?? FOLDER, path: over.path ?? P, now: NOW, random };
  const listed = addFileAsPart(
    project,
    { file: parent, contentHash: parentHash, format: 'step' },
    opts,
  );
  return linkAsNewer(
    listed,
    { file: newer, contentHash: newerHash, format: 'step' },
    { file: parent, contentHash: parentHash },
    opts,
  );
}

function apply(
  project: Project | undefined,
  file: string,
  n: Annotations,
  oldMarks?: VersionMarks,
) {
  seed++;
  return applyNotes({
    project,
    folder: FOLDER,
    path: P,
    file,
    notes: n,
    now: NOW,
    random,
    oldMarks,
  });
}

describe('notesOf', () => {
  it('gives a version as v1 notes: paint from its marks, names and comments from the project', () => {
    const project = sampleProject();
    const ref = must(findVersion(project, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    const doc = notesOf(project, ref, sampleMarks(), FOLDER, P);
    expect(parseAnnotations(doc).ok).toBe(true);
    expect(doc.model).toEqual({ fileName: 'bracket.step', format: 'step', contentHash: H('a') });
    expect(doc.markers).toEqual([
      {
        id: 'm1',
        name: 'Marker 1',
        color: '#ff0000',
        visible: true,
        entities: [{ kind: 'face', id: 3, seq: 1 }],
        paint: { faces: [{ faceId: 3, triangles: [[10, 4]] }] },
      },
    ]);
    expect(doc.comments.map((c) => c.id)).toEqual(['c1']);
    expect(doc.comments[0]).not.toHaveProperty('modelId');
    // Its place in the version list is asked separately (versionFacts), not in the notes.
    expect(doc.versions).toBeUndefined();
  });

  it('lists a marker a comment names without paint when this version has none', () => {
    const project = sampleProject();
    const ref = must(findVersion(project, FOLDER, '/work/exports/bracket_v2.step', H('b'), P));
    const marks: VersionMarks = {
      ...sampleMarks(),
      versionId: 'ver0000002',
      contentHash: H('b'),
      markers: [],
    };
    const doc = notesOf(project, ref, marks, FOLDER, P);
    expect(doc.markers).toEqual([
      {
        id: 'm1',
        name: 'Marker 1',
        color: '#ff0000',
        visible: true,
        entities: [],
        paint: { faces: [] },
      },
    ]);
    expect(doc.versions).toBeUndefined();
  });

  it('leaves out fields the window does not know (no backup on every open)', () => {
    const project = sampleProject();
    const parsed = parseProject({
      ...project,
      comments: [{ ...must(project.comments[0]), fromNewerApp: 1 }],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const withExtra = parsed.data;
    const ref = must(findVersion(withExtra, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    const doc = notesOf(withExtra, ref, { ...sampleMarks(), extra: true }, FOLDER, P);
    expect(doc.comments[0]).not.toHaveProperty('fromNewerApp');
    expect(JSON.stringify(doc)).not.toContain('extra');
  });

  it('turns body folders by name back into indices of this version', () => {
    const project = sampleProject();
    const part = must(project.models[0]);
    part.bodyTree = {
      folders: [{ id: 'f1', name: 'Screws', parent: 'top' }],
      bodies: [{ body: { name: 'screw', index: 0 }, parent: { folder: 'f1' } }],
      assemblies: [],
    };
    const ref = must(findVersion(project, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    const box = {
      size: [1, 1, 1] as [number, number, number],
      centre: [0, 0, 0] as [number, number, number],
      area: 1,
    };
    const marks = {
      ...sampleMarks(),
      bodies: [
        { name: 'base', ...box },
        { name: 'screw', ...box },
      ],
    };
    const doc = notesOf(project, ref, marks, FOLDER, P);
    expect(doc.bodyTree?.bodies).toEqual([{ body: 1, parent: { folder: 'f1' } }]);
  });
});

describe('versionAtPath', () => {
  it('prefers the version that is not overwritten', () => {
    const project = sampleProject();
    const part = must(project.models[0]);
    must(part.versions[0]).overwritten = true;
    part.versions.push({
      id: 'ver0000003',
      path: 'bracket.step',
      contentHash: H('c'),
      format: 'step',
      added: '2026-11-20T00:00:00.000Z',
      from: 'ver0000001',
    });
    expect(versionAtPath(project, FOLDER, '/work/bracket/bracket.step', P)?.version.id).toBe(
      'ver0000003',
    );
  });

  it('works with Windows paths', () => {
    const project = sampleProject();
    const ref = versionAtPath(
      project,
      'C:\\work\\bracket',
      'C:\\work\\exports\\bracket_v2.step',
      W,
    );
    expect(ref?.version.id).toBe('ver0000002');
  });
});

describe('applyNotes', () => {
  it('part requests (comments[].parts) are saved, read back and updated', () => {
    const c = { ...comment('c1', ['m1']), parts: [part('p1', ['m1'])] };
    const a = apply(
      undefined,
      '/work/bracket/bracket.step',
      notes({ markers: [marker('m1')], comments: [c] }),
    );
    expect(a.project.comments[0]?.parts).toEqual([part('p1', ['m1'])]);
    const ref = must(findVersion(a.project, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    expect(notesOf(a.project, ref, a.marks, FOLDER, P).comments[0]?.parts).toEqual([
      part('p1', ['m1']),
    ]);
    // The AI's result is written on a later save; a request taken off the comment is gone.
    const result = {
      status: 'placed' as const,
      bodies: ['M5 screw'],
      updatedAt: NOW.toISOString(),
    };
    const placed = { ...c, parts: [part('p1', ['m1'], { result })] };
    const b = apply(
      a.project,
      '/work/bracket/bracket.step',
      notes({ markers: [marker('m1')], comments: [placed] }),
      a.marks,
    );
    expect(b.project.comments[0]?.parts?.[0]).toMatchObject({ result: { status: 'placed' } });
    const c2 = apply(
      b.project,
      '/work/bracket/bracket.step',
      notes({ markers: [marker('m1')], comments: [comment('c1', ['m1'])] }),
      b.marks,
    );
    expect(c2.project.comments[0]).not.toHaveProperty('parts');
  });

  it('a part aimed at a marker the project no longer has: that target is left out when read', () => {
    const c = { ...comment('c1', ['m1', 'm2']), parts: [part('p1', ['m1', 'm2'])] };
    const a = apply(
      undefined,
      '/work/bracket/bracket.step',
      notes({ markers: [marker('m1'), marker('m2', 5)], comments: [c] }),
    );
    // A marker missing from the project list (e.g. a hand-edited file): the comment loses it.
    const project = { ...a.project, markers: a.project.markers.filter((m) => m.id !== 'm2') };
    const ref = must(findVersion(project, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    const read = notesOf(project, ref, a.marks, FOLDER, P).comments[0];
    expect(read?.markerIds).toEqual(['m1']);
    expect(read?.parts?.[0]?.target?.markerIds).toEqual(['m1']);
  });

  it('makes a project, a part and a version on the first save', () => {
    const n = notes({ markers: [marker('m1')], comments: [comment('c1', ['m1'])] });
    const r = apply(undefined, '/work/bracket/bracket.step', n);
    expect(r.project.name).toBe('bracket');
    expect(r.project.models).toHaveLength(1);
    expect(r.project.models[0]?.versions[0]).toMatchObject({
      path: 'bracket.step',
      contentHash: H('a'),
      format: 'step',
    });
    expect(r.project.markers).toEqual([
      { id: 'm1', name: 'Marker m1', color: '#00ff00', visible: true },
    ]);
    expect(r.project.comments[0]).toMatchObject({ id: 'c1', modelId: r.partId, markerIds: ['m1'] });
    expect(r.marks.versionId).toBe(r.versionId);
    expect(r.marks.markers[0]?.paint.faces[0]?.triangles).toEqual([[30, 2]]);
    expect(r.project.tessellation).toEqual(TESS);
  });

  it('round-trips: notes read back equal the notes saved', () => {
    const n = notes({ markers: [marker('m1')], comments: [comment('c1', ['m1'])] });
    const r = apply(undefined, '/work/bracket/bracket.step', n);
    const ref = must(findVersion(r.project, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    expect(notesOf(r.project, ref, r.marks, FOLDER, P)).toEqual(n);
  });

  it('a new version linked to the first joins the part; the facts show both ways', () => {
    const first = apply(
      undefined,
      '/work/bracket/bracket.step',
      notes({ markers: [marker('m1')], comments: [comment('c1', ['m1'])] }),
    );
    const l = link(
      first.project,
      '/work/bracket/bracket_v2.step',
      H('b'),
      '/work/bracket/bracket.step',
      H('a'),
    );
    expect(l.outcome).toEqual({ kind: 'linked' });
    const second = apply(
      l.project,
      '/work/bracket/bracket_v2.step',
      notes({
        fileName: 'bracket_v2.step',
        hash: H('b'),
        markers: [marker('m1', 4)],
        comments: [comment('c1', ['m1'], 'fixed?')],
      }),
    );
    expect(second.partId).toBe(first.partId);
    const part = must(second.project.models[0]);
    expect(part.versions.map((v) => v.from)).toEqual([undefined, first.versionId]);
    // One comment for the part, the newest text; one marker (same id came down the chain).
    expect(second.project.comments.map((c) => c.text)).toEqual(['fixed?']);
    expect(second.project.markers.map((m) => m.id)).toEqual(['m1']);
    const old = versionFacts(second.project, FOLDER, '/work/bracket/bracket.step', H('a'), P);
    expect(old.newer?.version.path).toBe('bracket_v2.step');
    expect(old.parent).toBeUndefined();
    const now = versionFacts(second.project, FOLDER, '/work/bracket/bracket_v2.step', H('b'), P);
    expect(now.parent?.version.id).toBe(first.versionId);
    // Saving again never changes the links (they are not in the notes).
    const again = apply(
      second.project,
      '/work/bracket/bracket_v2.step',
      notes({ fileName: 'bracket_v2.step', hash: H('b'), markers: [marker('m1', 4)] }),
    );
    expect(must(again.project.models[0]).versions.map((v) => v.from)).toEqual([
      undefined,
      first.versionId,
    ]);
  });

  it('a deleted comment is gone for the whole part; markers no one holds are reported', () => {
    const a = apply(
      undefined,
      '/work/bracket/bracket.step',
      notes({ markers: [marker('m1'), marker('m2', 5)], comments: [comment('c1', ['m1'])] }),
    );
    const b = apply(a.project, '/work/bracket/bracket.step', notes({ markers: [] }), a.marks);
    expect(b.project.comments).toEqual([]);
    expect(b.droppedMarkers.sort()).toEqual(['m1', 'm2']);
    expect(b.project.markers).toHaveLength(2); // other versions may still hold them
    expect(forgetMarkers(b.project, b.droppedMarkers).markers).toEqual([]);
  });

  it('keeps fields a newer app wrote (comments, marks, versions)', () => {
    const project = parseProject({
      ...sampleProject(),
      comments: [{ ...must(sampleProject().comments[0]), future: 'x' }],
      models: [{ ...must(sampleProject().models[0]), future: 1 }],
    });
    if (!project.ok) throw new Error(project.errors.join());
    const old = {
      ...sampleMarks(),
      future: 2,
      markers: [{ ...must(sampleMarks().markers[0]), future: 3 }],
    } as VersionMarks;
    const r = apply(
      project.data,
      '/work/bracket/bracket.step',
      notes({ markers: [marker('m1')], comments: [comment('c1', ['m1'], 'edited')] }),
      old,
    );
    expect(r.project.comments[0]).toMatchObject({ future: 'x', text: 'edited' });
    expect(r.project.models[0]).toMatchObject({ future: 1 });
    expect(r.marks).toMatchObject({ future: 2 });
    expect(r.marks.markers[0]).toMatchObject({ future: 3 });
  });

  it('a file saved over in place stays one version: same id and links, new contents', () => {
    const a = apply(undefined, '/work/bracket/bracket.step', notes({ markers: [marker('m1')] }));
    const l = link(
      a.project,
      '/work/bracket/bracket_v2.step',
      H('c'),
      '/work/bracket/bracket.step',
      H('a'),
    );
    const before = must(l.project.models[0]).versions;
    const r = replaceContents(l.project, FOLDER, '/work/bracket/bracket.step', H('a'), H('b'), P);
    const versions = must(r.project.models[0]).versions;
    expect(versions).toHaveLength(2);
    expect(r.versionId).toBe(before[0]?.id);
    expect(versions[0]).toMatchObject({
      id: before[0]?.id,
      path: 'bracket.step',
      contentHash: H('b'),
    });
    expect(versions[1]?.from).toBe(before[0]?.id);
    expect(r.project.comments).toEqual(l.project.comments);
    expect(() =>
      replaceContents(r.project, FOLDER, '/work/bracket/bracket.step', H('a'), H('d'), P),
    ).toThrow(/not a version/);
  });

  it('a comment linking another part follows it to its newest version', () => {
    const lid = apply(
      undefined,
      '/work/bracket/lid.step',
      notes({ fileName: 'lid.step', hash: H('c'), markers: [marker('m1')] }),
    );
    const b = apply(
      lid.project,
      '/work/bracket/bracket.step',
      notes({
        markers: [marker('m2')],
        comments: [{ ...comment('c1', ['m2']), linkedModels: ['lid.step', 'other.step'] }],
      }),
    );
    expect(b.project.comments[0]?.linkedParts).toEqual([lid.partId]);
    const l = link(
      b.project,
      '/work/bracket/lid_v2.step',
      H('d'),
      '/work/bracket/lid.step',
      H('c'),
    );
    const ref = must(findVersion(l.project, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    const read = notesOf(l.project, ref, b.marks, FOLDER, P);
    expect(read.comments[0]?.linkedModels).toEqual(['lid_v2.step', 'other.step']);
  });

  it('a comment never links to its own part: dropped when saved and when read', () => {
    const a = apply(undefined, '/work/bracket/bracket.step', notes({ markers: [marker('m1')] }));
    const l = link(
      a.project,
      '/work/bracket/bracket_v2.step',
      H('b'),
      '/work/bracket/bracket.step',
      H('a'),
    );
    const saved = apply(
      l.project,
      '/work/bracket/bracket_v2.step',
      notes({
        fileName: 'bracket_v2.step',
        hash: H('b'),
        markers: [marker('m1')],
        comments: [
          { ...comment('c1', ['m1']), linkedModels: ['BRACKET.step', 'lid.step'] },
          { ...comment('c2', ['m1']), linkedModels: ['bracket.step'] },
        ],
      }),
    );
    const [c1, c2] = saved.project.comments;
    expect(c1?.linkedModels).toEqual(['lid.step']);
    expect(c1?.linkedParts).toBeUndefined();
    expect(c2?.linkedModels).toBeUndefined();
    // An older project that kept such a name: the window never gets it.
    const old: Project = {
      ...saved.project,
      comments: saved.project.comments.map((c) =>
        c.id === 'c2' ? { ...c, linkedModels: ['bracket.step'] } : c,
      ),
    };
    const ref = must(findVersion(old, FOLDER, '/work/bracket/bracket_v2.step', H('b'), P));
    const read = notesOf(old, ref, saved.marks, FOLDER, P);
    expect(read.comments.map((c) => c.linkedModels)).toEqual([['lid.step'], undefined]);
    expect(read.comments[1]).not.toHaveProperty('linkedModels');
  });

  it('two parts becoming one lose the links between them (and say how many)', () => {
    const lid = apply(
      undefined,
      '/work/bracket/lid.step',
      notes({
        fileName: 'lid.step',
        hash: H('c'),
        markers: [marker('m1')],
        comments: [{ ...comment('c1', ['m1']), linkedModels: ['bracket.step'] }],
      }),
    );
    const b = apply(
      lid.project,
      '/work/bracket/bracket.step',
      notes({
        markers: [marker('m2')],
        comments: [
          { ...comment('c2', ['m2']), linkedModels: ['lid.step', 'other.step'] },
          { ...comment('c3', ['m2']), linkedModels: ['other.step'] },
        ],
      }),
    );
    expect(b.project.comments.map((c) => c.linkedParts)).toEqual([
      undefined, // bracket.step wasn't a part yet when the lid's comment was saved
      [lid.partId],
      undefined,
    ]);
    const box = apply(
      b.project,
      '/work/bracket/box.step',
      notes({
        fileName: 'box.step',
        hash: H('e'),
        markers: [marker('m3')],
        comments: [{ ...comment('c4', ['m3']), linkedModels: ['lid.step'] }],
      }),
    );
    const l = link(
      box.project,
      '/work/bracket/lid.step',
      H('c'),
      '/work/bracket/bracket.step',
      H('a'),
    );
    expect(l.outcome).toEqual({
      kind: 'linked',
      removedLinks: { count: 2, partName: 'bracket' },
    });
    expect(l.project.models).toHaveLength(2);
    expect(l.project.comments.map((c) => [c.id, c.linkedModels, c.linkedParts])).toEqual([
      ['c1', undefined, undefined],
      ['c2', ['other.step'], undefined],
      ['c3', ['other.step'], undefined],
      // Another part's link to the lid now points to the part the lid joined.
      ['c4', ['lid.step'], [b.partId]],
    ]);
    // Linking again changes nothing and says nothing.
    const again = link(
      l.project,
      '/work/bracket/lid.step',
      H('c'),
      '/work/bracket/bracket.step',
      H('a'),
    );
    expect(again.outcome).toEqual({ kind: 'already' });
  });

  it('versionFacts: a file saved over since is "replaced"; after replaceContents it is listed', () => {
    const a = apply(undefined, '/work/bracket/bracket.step', notes({ markers: [marker('m1')] }));
    const f = versionFacts(a.project, FOLDER, '/work/bracket/bracket.step', H('b'), P);
    expect(f.version).toBeUndefined();
    expect(f.replaced?.version.contentHash).toBe(H('a'));
    const r = replaceContents(a.project, FOLDER, '/work/bracket/bracket.step', H('a'), H('b'), P);
    const after = versionFacts(r.project, FOLDER, '/work/bracket/bracket.step', H('b'), P);
    expect(after.version?.version.contentHash).toBe(H('b'));
    expect(after.replaced).toBeUndefined();
  });

  it('an earlier version outside the folder is listed first, then linked', () => {
    const l = link(
      undefined,
      '/work/bracket/bracket_v2.step',
      H('e'),
      '/work/out/old.step',
      H('d'),
    );
    const versions = must(l.project.models[0]).versions;
    expect(versions.map((v) => v.path)).toEqual(['../out/old.step', 'bracket_v2.step']);
    expect(versions[1]?.from).toBe(versions[0]?.id);
  });

  it('a single-version part linked to another part moves into it with its comments', () => {
    const a = apply(undefined, '/work/bracket/bracket.step', notes({ markers: [marker('m1')] }));
    const lone = apply(
      a.project,
      '/work/bracket/b2.step',
      notes({ fileName: 'b2.step', hash: H('f'), comments: [comment('c9', [])] }),
    );
    expect(lone.project.models).toHaveLength(2);
    const l = link(
      lone.project,
      '/work/bracket/b2.step',
      H('f'),
      '/work/bracket/bracket.step',
      H('a'),
    );
    expect(l.project.models).toHaveLength(1);
    expect(l.project.comments.map((c) => c.modelId)).toEqual([a.partId]);
  });

  it('no circles: a version can’t be made from itself or one made from it; twice = already', () => {
    const a = apply(undefined, '/work/bracket/a.step', notes({ fileName: 'a.step' }));
    const b = link(a.project, '/work/bracket/b.step', H('b'), '/work/bracket/a.step', H('a'));
    const c = link(b.project, '/work/bracket/c.step', H('c'), '/work/bracket/b.step', H('b'));
    expect(
      link(c.project, '/work/bracket/a.step', H('a'), '/work/bracket/c.step', H('c')).outcome,
    ).toEqual({ kind: 'circle' });
    expect(
      link(c.project, '/work/bracket/a.step', H('a'), '/work/bracket/a.step', H('a')).outcome,
    ).toEqual({ kind: 'circle' });
    const twice = link(c.project, '/work/bracket/c.step', H('c'), '/work/bracket/b.step', H('b'));
    expect(twice.outcome).toEqual({ kind: 'already' });
    expect(twice.project).toBe(c.project);
    const A = { file: '/work/bracket/a.step', contentHash: H('a') };
    const C = { file: '/work/bracket/c.step', contentHash: H('c') };
    expect(isEarlierVersion(c.project, FOLDER, A, C, P)).toBe(true);
    expect(isEarlierVersion(c.project, FOLDER, C, A, P)).toBe(false);
    // Another parent: linked, and the one it had is reported.
    const moved = link(c.project, '/work/bracket/c.step', H('c'), '/work/bracket/a.step', H('a'));
    expect(moved.outcome).toMatchObject({
      kind: 'linked',
      before: { version: { path: 'b.step' } },
    });
  });

  it('linked to a version of another part: it moves with the versions made from it; no comment lost', () => {
    // Part A: a.step ← b.step ← c.step, one comment.
    const a = apply(
      undefined,
      '/work/bracket/a.step',
      notes({ fileName: 'a.step', hash: H('a'), comments: [comment('c1', [], 'on A')] }),
    );
    const b = link(a.project, '/work/bracket/b.step', H('b'), '/work/bracket/a.step', H('a'));
    const c = link(b.project, '/work/bracket/c.step', H('c'), '/work/bracket/b.step', H('b'));
    // Part X: x.step with its own comment.
    const x = apply(
      c.project,
      '/work/bracket/x.step',
      notes({ fileName: 'x.step', hash: H('d'), comments: [comment('c9', [], 'on X')] }),
    );
    expect(x.project.models).toHaveLength(2);
    // b is now said to be made from x.
    const moved = link(x.project, '/work/bracket/b.step', H('b'), '/work/bracket/x.step', H('d'));
    const [partA, partX] = moved.project.models;
    expect(partA?.versions.map((v) => v.path)).toEqual(['a.step']);
    expect(partX?.versions.map((v) => v.path).sort()).toEqual(['b.step', 'c.step', 'x.step']);
    const texts = (partId: string | undefined) =>
      moved.project.comments
        .filter((cm) => cm.modelId === partId)
        .map((cm) => cm.text)
        .sort();
    expect(texts(partA?.id)).toEqual(['on A']);
    expect(texts(partX?.id)).toEqual(['on X']);
  });

  it('windowComments: only comments the window was shown can be deleted by leaving them out', () => {
    const a = apply(
      undefined,
      '/work/bracket/bracket.step',
      notes({ comments: [comment('c1', [], 'one'), comment('c2', [], 'two')] }),
    );
    seed++;
    const r = applyNotes({
      project: a.project,
      folder: FOLDER,
      path: P,
      file: '/work/bracket/bracket.step',
      notes: notes({ comments: [] }),
      now: NOW,
      random,
      windowComments: new Set(['c1']),
    });
    expect(r.project.comments.map((c) => c.text)).toEqual(['two']);
  });

  it('mesh notes have no tessellation', () => {
    const n: Annotations = {
      schemaVersion: 1,
      model: { fileName: 'scan.stl', format: 'stl', contentHash: H('9') },
      markers: [marker('m1')],
      comments: [],
    };
    const r = apply(undefined, '/work/bracket/scan.stl', n);
    expect(r.marks.tessellation).toBeUndefined();
    expect(r.project.models[0]?.versions[0]?.format).toBe('stl');
  });

  it('stores Windows paths relative with / and another drive as outside', () => {
    const l = link(
      undefined,
      'C:\\work\\bracket\\out\\Bracket.step',
      H('a'),
      'D:\\exports\\old.step',
      H('d'),
      { folder: 'C:\\work\\bracket', path: W },
    );
    const versions = must(l.project.models[0]).versions;
    expect(versions[1]?.path).toBe('out/Bracket.step');
    expect(versions[0]).toMatchObject({ path: 'D:\\exports\\old.step', outside: true });
  });
});

describe('the version list (Versions ▾)', () => {
  const v3 = {
    id: 'ver0000003',
    path: 'bracket_v3.step',
    contentHash: H('c'),
    format: 'step' as const,
    added: '2026-11-21T12:00:00.000Z',
    from: 'ver0000002',
  };
  /** v1 → v2 → v3, plus a side branch v2b made from v1. */
  function three(): Project {
    const project = sampleProject();
    const part = must(project.models[0]);
    part.versions.push(v3, {
      id: 'ver000002b',
      path: 'bracket_alt.step',
      contentHash: H('d'),
      format: 'step',
      added: '2026-11-21T11:30:00.000Z',
      from: 'ver0000001',
    });
    return project;
  }
  const ids = (p: Project) => p.models.map((m) => m.versions.map((v) => [v.id, v.from]));

  it('lists every version of the part, side branches too, newest first; the shown one ticked', () => {
    const list = must(partVersions(three(), FOLDER, '/work/bracket/bracket.step', H('a'), P));
    expect(list.partId).toBe('part000001');
    expect(list.rows.map((r) => [r.name, r.shown])).toEqual([
      ['bracket_v3.step', false],
      ['bracket_alt.step', false],
      ['bracket_v2.step', false],
      ['bracket.step', true],
    ]);
    expect(list.rows[2]?.file).toBe('/work/exports/bracket_v2.step');
    expect(partVersions(three(), FOLDER, '/work/bracket/bracket.step', H('z'), P)).toBeUndefined();
  });

  it('same time: a version comes before the one it was made from', () => {
    const project = three();
    for (const v of must(project.models[0]).versions) v.added = '2026-11-21T10:00:00.000Z';
    const list = must(partVersions(project, FOLDER, '/work/bracket/bracket_v3.step', H('c'), P));
    expect(list.rows.map((r) => r.name).at(0)).toBe('bracket_v3.step');
    expect(list.rows.map((r) => r.name).at(-1)).toBe('bracket.step');
  });

  it('a version added to the project after the one made from it still comes below it', () => {
    const project = three();
    // v1 listed late (opened after v3 existed), then linked as v2's parent.
    must(must(project.models[0]).versions[0]).added = '2026-11-22T00:00:00.000Z';
    const list = must(partVersions(project, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    expect(list.rows.map((r) => r.name).at(-1)).toBe('bracket.step');
    expect(list.rows.map((r) => r.name).indexOf('bracket_v3.step')).toBeLessThan(
      list.rows.map((r) => r.name).indexOf('bracket_v2.step'),
    );
  });

  it('Remove: the versions made from it get its earlier one; it leaves with the mark, comments stay', () => {
    const p = removeFromVersions(three(), 'ver0000002', NOW, FOLDER, P, random);
    expect(ids(p)).toEqual([
      [
        ['ver0000001', undefined],
        ['ver0000003', 'ver0000001'],
        ['ver000002b', 'ver0000001'],
      ],
      [['ver0000002', undefined]],
    ]);
    expect(p.models[1]?.versions[0]?.unlinked).toBe(NOW.toISOString());
    expect(p.models[1]?.name).toBe('bracket_v2');
    expect(p.comments.every((c) => c.modelId === 'part000001')).toBe(true);
    // The list of the shown part no longer has it; its own list is itself only.
    const list = must(partVersions(p, FOLDER, '/work/bracket/bracket.step', H('a'), P));
    expect(list.rows.map((r) => r.name)).not.toContain('bracket_v2.step');
    const own = must(partVersions(p, FOLDER, '/work/exports/bracket_v2.step', H('b'), P));
    expect(own.rows.map((r) => r.name)).toEqual(['bracket_v2.step']);
  });

  it('Remove the first version: the ones made from it are made from none', () => {
    const p = removeFromVersions(three(), 'ver0000001', NOW, FOLDER, P, random);
    expect(ids(p)[0]).toEqual([
      ['ver0000002', undefined],
      ['ver0000003', 'ver0000002'],
      ['ver000002b', undefined],
    ]);
  });

  it('Remove, then add it back as a new version: one part again, mark gone, comments and marks kept', () => {
    const first = apply(
      undefined,
      '/work/bracket/a.step',
      notes({ fileName: 'a.step', markers: [marker('m1')], comments: [comment('c1', ['m1'])] }),
    );
    const l = link(first.project, '/work/bracket/b.step', H('b'), '/work/bracket/a.step', H('a'));
    const second = apply(
      l.project,
      '/work/bracket/b.step',
      notes({
        fileName: 'b.step',
        hash: H('b'),
        markers: [marker('m1', 4)],
        comments: [comment('c1', ['m1'])],
      }),
    );
    const removed = removeFromVersions(second.project, second.versionId, NOW, FOLDER, P, random);
    expect(removed.models).toHaveLength(2);
    // Opened alone: it is marked "removed" (left out of guesses), no comments of the part.
    const alone = must(findVersion(removed, FOLDER, '/work/bracket/b.step', H('b'), P));
    expect(alone.version.unlinked).toBeDefined();
    expect(removed.comments.filter((c) => c.modelId === alone.part.id)).toEqual([]);
    // Add file… → New version of a.step.
    const back = link(removed, '/work/bracket/b.step', H('b'), '/work/bracket/a.step', H('a'));
    expect(back.outcome).toEqual({ kind: 'linked' });
    expect(back.project.models).toHaveLength(1);
    const ref = must(findVersion(back.project, FOLDER, '/work/bracket/b.step', H('b'), P));
    expect(ref.part.id).toBe(first.partId);
    expect(ref.version.from).toBe(first.versionId);
    expect(ref.version.unlinked).toBeUndefined();
    expect(back.project.comments.map((c) => [c.id, c.modelId])).toEqual([['c1', first.partId]]);
    const list = must(partVersions(back.project, FOLDER, '/work/bracket/a.step', H('a'), P));
    expect(list.rows.map((r) => r.name)).toEqual(['b.step', 'a.step']);
    // … and removed again: still works (no circle, no duplicate).
    const again = removeFromVersions(back.project, ref.version.id, NOW, FOLDER, P, random);
    expect(again.models.map((m) => m.versions.map((v) => v.path))).toEqual([
      ['a.step'],
      ['b.step'],
    ]);
  });

  it('Locate…: the version points to the new place; Windows paths stored relative with /', () => {
    const p = relocateVersion(three(), 'ver0000002', '/work/bracket/moved/v2.step', FOLDER, P);
    expect(must(p.models[0]).versions[1]).toMatchObject({ path: 'moved/v2.step' });
    expect(must(p.models[0]).versions[1]?.outside).toBeUndefined();
    const w = relocateVersion(
      three(),
      'ver0000003',
      'C:\\work\\bracket\\sub\\v3.step',
      'C:\\work\\bracket',
      W,
    );
    expect(must(w.models[0]).versions[2]?.path).toBe('sub/v3.step');
    const out = relocateVersion(three(), 'ver0000003', '/elsewhere/v3.step', FOLDER, P);
    expect(must(out.models[0]).versions[2]).toMatchObject({ path: '../../elsewhere/v3.step' });
  });

  it('Locate… onto a file another version with the same contents stands for: refused', () => {
    const project = three();
    must(project.models[0]).versions.push({ ...v3, id: 'ver0000009', path: 'copy_v3.step' });
    expect(() =>
      relocateVersion(project, 'ver0000003', '/work/bracket/copy_v3.step', FOLDER, P),
    ).toThrow(/already listed/);
  });
});

describe('addFileAsPart', () => {
  const opts = { folder: FOLDER, path: P, now: NOW, random };
  it('lists a file as a part of its own at once; twice changes nothing', () => {
    const f = { file: '/work/bracket/lid.step', contentHash: H('e'), format: 'step' as const };
    const p = addFileAsPart(sampleProject(), f, opts);
    expect(p.models.map((m) => m.name)).toEqual(['bracket', 'lid']);
    expect(p.models[1]?.versions[0]).toMatchObject({ path: 'lid.step', contentHash: H('e') });
    expect(addFileAsPart(p, f, opts)).toBe(p);
    // An empty project gets made.
    const first = addFileAsPart(undefined, f, opts);
    expect(first.models).toHaveLength(1);
    // Its later notes save into that version (same part, no second one).
    const saved = apply(
      first,
      '/work/bracket/lid.step',
      notes({ fileName: 'lid.step', hash: H('e') }),
    );
    expect(saved.project.models.map((m) => m.versions.length)).toEqual([1]);
  });
});
