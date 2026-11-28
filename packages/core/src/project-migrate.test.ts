import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatJson } from './format-json.js';
import { collectSidecars, migrateSidecars, type SidecarInput } from './project-migrate.js';
import { projectFiles, type PathApi } from './project-paths.js';
import { parseProject, type Project, type ProjectVersion } from './project-schema.js';
import { readMarks, readProject, saveProject } from './project-store.js';
import type { Annotations, CommentData, MarkerData, VersionLink } from './schema.js';
import { H, must } from './testing/fixtures.js';
import { MemoryFs, counterRandom } from './testing/memory-fs.js';

const posix = path.posix;
const win = path.win32;
const NOW = new Date('2026-11-21T12:00:00.000Z');
const day = (d: number): string => `2026-11-${String(d).padStart(2, '0')}T10:00:00.000Z`;

function marker(id: string, faceId: number, name = `Marker ${id}`): MarkerData {
  return {
    id,
    name,
    color: '#ff0000',
    visible: true,
    entities: [{ kind: 'face', id: faceId, seq: 1 }],
    paint: { faces: [{ faceId, triangles: [[faceId * 10, 2]] }] },
  };
}

function comment(
  id: string,
  markerIds: string[],
  created: number,
  extra: Partial<CommentData> = {},
): CommentData {
  return {
    id,
    text: `comment ${id}`,
    markerIds,
    status: 'open',
    author: 'human',
    createdAt: day(created),
    updatedAt: day(created),
    ...extra,
  };
}

function sidecar(
  fileName: string,
  hash: string,
  opts: {
    markers?: MarkerData[];
    comments?: CommentData[];
    earlier?: VersionLink[];
    newer?: VersionLink[];
    extra?: Partial<Annotations>;
  } = {},
): Annotations {
  return {
    schemaVersion: 1,
    model: { fileName, format: 'step', contentHash: hash },
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
    markers: opts.markers ?? [],
    comments: opts.comments ?? [],
    ...(opts.earlier || opts.newer
      ? {
          versions: {
            ...(opts.earlier ? { earlier: opts.earlier } : {}),
            ...(opts.newer ? { newer: opts.newer } : {}),
          },
        }
      : {}),
    ...opts.extra,
  };
}

const link = (
  p: string,
  hash: string,
  d: number,
  extra: Partial<VersionLink> = {},
): VersionLink => ({
  path: p,
  name: p.split(/[\\/]/).pop() ?? p,
  contentHash: hash,
  date: day(d),
  ...extra,
});

function migrate(folder: string, sidecars: SidecarInput[], p: PathApi = posix, existing?: Project) {
  const r = migrateSidecars({
    folder,
    sidecars,
    path: p,
    now: NOW,
    random: counterRandom(),
    ...(existing ? { existing } : {}),
  });
  // Whatever the input, the output must be a valid project.
  const check = parseProject(JSON.parse(formatJson(r.project)));
  if (!check.ok) throw new Error(check.errors.join('\n'));
  return r;
}

const versionAt = (p: Project, rel: string): ProjectVersion | undefined =>
  p.models.flatMap((m) => m.versions).find((v) => v.path === rel);

describe('migrateSidecars', () => {
  it('part requests come along; their target markers are renamed with the comment’s', () => {
    const parts = (m: string) => [
      {
        id: 'p1',
        source: {
          kind: 'library' as const,
          library: 'bd_warehouse',
          cls: 'HexNut',
          params: { size: 'M5-0.8' },
        },
        copies: 2,
        scope: 'whole' as const,
        target: { markerIds: [m] },
      },
    ];
    const one = sidecar('bracket.step', H('a'), {
      markers: [marker('m1', 1)],
      comments: [comment('c1', ['m1'], 1, { parts: parts('m1') })],
    });
    const two = sidecar('lid.step', H('b'), {
      markers: [marker('m1', 2)],
      comments: [comment('c1', ['m1'], 2, { parts: parts('m1') })],
    });
    const { project, report } = migrate('/cad', [
      { modelPath: '/cad/bracket.step', data: one },
      { modelPath: '/cad/lid.step', data: two },
    ]);
    expect(report.renamedMarkers).toBe(1);
    for (const c of project.comments) {
      expect(c.parts?.[0]).toMatchObject({ id: 'p1', copies: 2, source: { cls: 'HexNut' } });
      expect(c.parts?.[0]?.target?.markerIds).toEqual(c.markerIds);
    }
  });

  it('one sidecar → one part, one version, marks and comments', () => {
    const s = sidecar('bracket.step', H('a'), {
      markers: [marker('m1', 3)],
      comments: [comment('c1', ['m1'], 1)],
    });
    const { project, marks, report } = migrate('/cad', [
      { modelPath: '/cad/bracket.step', data: s },
    ]);
    expect(project.name).toBe('cad');
    expect(project.models).toHaveLength(1);
    const part = must(project.models[0]);
    expect(part.name).toBe('bracket');
    expect(part.versions).toMatchObject([
      { path: 'bracket.step', contentHash: H('a'), format: 'step' },
    ]);
    expect(project.comments).toMatchObject([{ id: 'c1', modelId: part.id, markerIds: ['m1'] }]);
    expect(project.markers).toEqual([
      { id: 'm1', name: 'Marker m1', color: '#ff0000', visible: true },
    ]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ versionId: must(part.versions[0]).id, contentHash: H('a') });
    expect(must(must(must(marks[0]).markers[0]).paint.faces[0]).triangles).toEqual([[30, 2]]);
    expect(project.sidecars).toEqual([
      { path: 'bracket.step', contentHash: H('a'), at: NOW.toISOString() },
    ]);
    expect(project.tessellation).toEqual({ linearDeflection: 0.1, angularDeflection: 0.5 });
    expect(report).toMatchObject({
      sidecars: 1,
      newParts: 1,
      newVersions: 1,
      versionsWithoutNotes: 0,
    });
  });

  it('a chain of three sidecars → one part; each comment once, the last edited copy wins', () => {
    const c1 = comment('c1', ['m1'], 1);
    const v1 = sidecar('b.step', H('1'), { markers: [marker('m1', 1)], comments: [c1] });
    const v2 = sidecar('b_v2.step', H('2'), {
      markers: [marker('m1', 2)],
      comments: [c1],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const resolved = { ...c1, status: 'resolved' as const, updatedAt: day(3) };
    const v3 = sidecar('b_v3.step', H('3'), {
      markers: [marker('m1', 4, 'Renamed in v3')],
      comments: [resolved],
      earlier: [link('/cad/b_v2.step', H('2'), 3), link('/cad/b.step', H('1'), 2)],
    });
    const { project, marks } = migrate('/cad', [
      { modelPath: '/cad/b_v3.step', data: v3 },
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_v2.step', data: v2 },
    ]);
    expect(project.models).toHaveLength(1);
    const [a, b, c] = must(project.models[0]).versions;
    expect([a?.path, b?.path, c?.path]).toEqual(['b.step', 'b_v2.step', 'b_v3.step']);
    expect(a?.from).toBeUndefined();
    expect(b?.from).toBe(a?.id);
    expect(c?.from).toBe(b?.id);
    expect(project.comments).toHaveLength(1);
    expect(must(project.comments[0]).status).toBe('resolved');
    expect(project.markers).toEqual([
      { id: 'm1', name: 'Renamed in v3', color: '#ff0000', visible: true },
    ]);
    // Paint per version stays that version's.
    expect(marks.map((m) => must(must(m.markers[0]).paint.faces[0]).faceId)).toEqual([1, 2, 4]);
  });

  it('a comment the user deleted in a newer version is not brought back', () => {
    const v1 = sidecar('b.step', H('1'), {
      comments: [comment('gone', [], 1), comment('kept', [], 1)],
    });
    const v2 = sidecar('b_v2.step', H('2'), {
      comments: [comment('kept', [], 1)],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const { project, report } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_v2.step', data: v2 },
    ]);
    expect(project.comments.map((c) => c.id)).toEqual(['kept']);
    expect(report.deletedComments).toBe(1);
  });

  it('a comment deleted two versions later is not brought back (v1 → v2 → v3, deleted in v3)', () => {
    const c = comment('c1', [], 1);
    const v1 = sidecar('b.step', H('1'), { comments: [c] });
    const v2 = sidecar('b_v2.step', H('2'), {
      comments: [c],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const v3 = sidecar('b_v3.step', H('3'), { earlier: [link('/cad/b_v2.step', H('2'), 3)] });
    const { project, report } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_v2.step', data: v2 },
      { modelPath: '/cad/b_v3.step', data: v3 },
    ]);
    expect(project.comments).toEqual([]);
    expect(report.deletedComments).toBe(1);
  });

  it('two variants that each added their own "c1" keep both comments', () => {
    const v1 = sidecar('b.step', H('1'));
    const a = sidecar('b_a.step', H('a'), {
      comments: [{ ...comment('c1', [], 3), text: 'hole too small' }],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const b = sidecar('b_b.step', H('b'), {
      comments: [{ ...comment('c1', [], 4), text: 'fillet bigger' }],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_a.step', data: a },
      { modelPath: '/cad/b_b.step', data: b },
    ]);
    expect(project.comments.map((c) => c.text)).toEqual(['hole too small', 'fillet bigger']);
    expect(new Set(project.comments.map((c) => c.id)).size).toBe(2);
  });

  it('back on an older version: its new "c2" and the newer version’s own "c2" both stay', () => {
    const v1 = sidecar('b.step', H('1'), {
      comments: [{ ...comment('c2', [], 5), text: 'added on v1 later' }],
    });
    const v2 = sidecar('b_v2.step', H('2'), {
      comments: [{ ...comment('c2', [], 3), text: 'added on v2' }],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_v2.step', data: v2 },
    ]);
    expect(project.comments.map((c) => c.text).sort()).toEqual([
      'added on v1 later',
      'added on v2',
    ]);
  });

  it('two variants that each added their own "m3" get two markers; comments keep theirs', () => {
    const v1 = sidecar('b.step', H('1'), { markers: [marker('m1', 1)] });
    const a = sidecar('b_a.step', H('a'), {
      markers: [marker('m1', 1), marker('m3', 2, 'Hole')],
      comments: [comment('ca', ['m3'], 3)],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const b = sidecar('b_b.step', H('b'), {
      markers: [marker('m1', 1), marker('m3', 4, 'Fillet')],
      comments: [comment('cb', ['m3'], 4)],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const { project, report } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_a.step', data: a },
      { modelPath: '/cad/b_b.step', data: b },
    ]);
    // m1 came down from v1 into both variants: one marker.
    expect(project.markers.map((m) => m.name).sort()).toEqual(['Fillet', 'Hole', 'Marker m1']);
    const name = (cid: string): string | undefined => {
      const c = project.comments.find((x) => x.id === cid);
      return project.markers.find((m) => m.id === c?.markerIds[0])?.name;
    };
    expect(name('ca')).toBe('Hole');
    expect(name('cb')).toBe('Fillet');
    expect(report.renamedMarkers).toBe(1);
  });

  it('a comment added to an older version after the newer one was made is kept', () => {
    const v1 = sidecar('b.step', H('1'), { comments: [comment('late', [], 5)] });
    const v2 = sidecar('b_v2.step', H('2'), { earlier: [link('/cad/b.step', H('1'), 2)] });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_v2.step', data: v2 },
    ]);
    expect(project.comments.map((c) => c.id)).toEqual(['late']);
  });

  it('variants: deleted in one, still in the other → kept', () => {
    const v1 = sidecar('b.step', H('1'), { comments: [comment('c', [], 1)] });
    const a = sidecar('b_a.step', H('a'), { earlier: [link('/cad/b.step', H('1'), 2)] });
    const b = sidecar('b_b.step', H('b'), {
      comments: [comment('c', [], 1)],
      earlier: [link('/cad/b.step', H('1'), 3)],
    });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: v1 },
      { modelPath: '/cad/b_a.step', data: a },
      { modelPath: '/cad/b_b.step', data: b },
    ]);
    expect(project.models).toHaveLength(1);
    const v = must(project.models[0]).versions;
    expect(v.filter((x) => x.from === must(v[0]).id)).toHaveLength(2);
    expect(project.comments.map((c) => c.id)).toEqual(['c']);
  });

  it('two unrelated parts with the same marker and comment ids: the second gets new ids, links follow', () => {
    const one = sidecar('bracket.step', H('a'), {
      markers: [marker('m1', 1)],
      comments: [comment('c1', ['m1'], 1)],
    });
    const two = sidecar('lid.step', H('b'), {
      markers: [marker('m1', 2)],
      comments: [comment('c1', ['m1'], 2)],
    });
    const { project, marks, report } = migrate('/cad', [
      { modelPath: '/cad/bracket.step', data: one },
      { modelPath: '/cad/lid.step', data: two },
    ]);
    expect(project.models.map((m) => m.name).sort()).toEqual(['bracket', 'lid']);
    expect(project.markers).toHaveLength(2);
    expect(project.comments).toHaveLength(2);
    const [cA, cB] = project.comments;
    expect(must(cA).modelId).not.toBe(must(cB).modelId);
    expect(must(cA).markerIds[0]).not.toBe(must(cB).markerIds[0]);
    expect(must(cA).id).not.toBe(must(cB).id);
    // Each comment's marker is the one painted on its own part.
    for (const c of project.comments) {
      const part = must(project.models.find((m) => m.id === c.modelId));
      const m = must(marks.find((x) => x.versionId === must(part.versions[0]).id));
      expect(m.markers.map((x) => x.id)).toEqual(c.markerIds);
    }
    expect(report.renamedMarkers).toBe(1);
  });

  it('a folder moved after the links were made still lines up (content hash first)', () => {
    const v1 = sidecar('b.step', H('1'), { comments: [comment('c', [], 1)] });
    const v2 = sidecar('b_v2.step', H('2'), {
      comments: [comment('c', [], 1)],
      earlier: [link('/Users/old/Desktop/cad/b.step', H('1'), 2)],
    });
    const { project, report } = migrate('/Volumes/usb/cad', [
      { modelPath: '/Volumes/usb/cad/b.step', data: v1 },
      { modelPath: '/Volumes/usb/cad/b_v2.step', data: v2 },
    ]);
    expect(project.models).toHaveLength(1);
    expect(must(project.models[0]).versions.map((v) => v.path)).toEqual(['b.step', 'b_v2.step']);
    expect(report.versionsWithoutNotes).toBe(0);
  });

  it('two identical files: the link picks the one at its own path', () => {
    const a = sidecar('b.step', H('1'));
    const copy = sidecar('b copy.step', H('1'));
    const v2 = sidecar('b_v2.step', H('2'), { earlier: [link('/cad/b copy.step', H('1'), 2)] });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: a },
      { modelPath: '/cad/b copy.step', data: copy },
      { modelPath: '/cad/b_v2.step', data: v2 },
    ]);
    const parent = must(project.models.find((m) => m.versions.some((v) => v.path === 'b_v2.step')));
    expect(parent.versions.map((v) => v.path)).toEqual(['b copy.step', 'b_v2.step']);
  });

  it('a file overwritten in place: its earlier contents are left out (one file name = one version)', () => {
    const now = sidecar('b.step', H('2'), {
      markers: [marker('m1', 1)],
      earlier: [link('/cad/b.step', H('1'), 2, { overwritten: true })],
    });
    const { project, marks, report } = migrate('/cad', [{ modelPath: '/cad/b.step', data: now }]);
    const v = must(project.models[0]).versions;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ path: 'b.step', contentHash: H('2') });
    expect(v[0]?.from).toBeUndefined();
    expect(marks.map((m) => m.versionId)).toEqual([must(v[0]).id]);
    expect(report.versionsWithoutNotes).toBe(0);
  });

  it('overwritten contents in the middle of a chain: the next version is made from the one before', () => {
    const a = sidecar('a.step', H('a'), { markers: [marker('m1', 1)] });
    const b = sidecar('b.step', H('3'), {
      markers: [marker('m1', 3)],
      earlier: [
        link('/cad/b.step', H('2'), 2, { overwritten: true }),
        link('/cad/a.step', H('a'), 1),
      ],
    });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/a.step', data: a },
      { modelPath: '/cad/b.step', data: b },
    ]);
    expect(project.models).toHaveLength(1);
    const v = must(project.models[0]).versions;
    expect(v.map((x) => [x.path, x.contentHash])).toEqual([
      ['a.step', H('a')],
      ['b.step', H('3')],
    ]);
    expect(v[1]?.from).toBe(v[0]?.id);
  });

  it('links to itself and circles are cut, never followed', () => {
    const self = sidecar('s.step', H('5'), { earlier: [link('/cad/s.step', H('5'), 1)] });
    const a = sidecar('a.step', H('a'), { earlier: [link('/cad/b.step', H('b'), 2)] });
    const b = sidecar('b.step', H('b'), { earlier: [link('/cad/a.step', H('a'), 3)] });
    const { project, report } = migrate('/cad', [
      { modelPath: '/cad/s.step', data: self },
      { modelPath: '/cad/a.step', data: a },
      { modelPath: '/cad/b.step', data: b },
    ]);
    expect(report.cutLinks).toBe(2);
    expect(project.models.flatMap((m) => m.versions)).toHaveLength(3);
  });

  it('a long cache chain of versions without notes is walked, not trusted over a sidecar', () => {
    const earlier = Array.from({ length: 150 }, (_, i) =>
      link(`/cad/old${String(i)}.step`, `sha256:${String(i).padStart(64, '0')}`, 1),
    );
    const s = sidecar('b.step', H('f'), { earlier });
    const { project, report } = migrate('/cad', [{ modelPath: '/cad/b.step', data: s }]);
    expect(project.models).toHaveLength(1);
    expect(report.versionsWithoutNotes).toBe(100); // MAX_VERSION_LINKS
  });

  it('an earlier version outside the folder → ../ path; on another Windows drive → outside', () => {
    const s = sidecar('b_v2.step', H('2'), {
      earlier: [link('C:\\work\\exports\\b.step', H('1'), 1)],
    });
    const t = sidecar('c_v2.step', H('4'), {
      earlier: [link('D:\\other\\c.step', H('3'), 1)],
    });
    const { project } = migrate(
      'C:\\work\\proj',
      [
        { modelPath: 'C:\\work\\proj\\b_v2.step', data: s },
        { modelPath: 'C:\\work\\proj\\c_v2.step', data: t },
      ],
      win,
    );
    expect(versionAt(project, '../exports/b.step')).toBeDefined();
    expect(versionAt(project, 'D:\\other\\c.step')?.outside).toBe(true);
  });

  it('a Windows-made sidecar read on a Mac keeps its C:\\ link as an outside version', () => {
    const s = sidecar('b_v2.step', H('2'), { earlier: [link('C:\\Users\\pc\\b.step', H('1'), 1)] });
    const { project } = migrate('/cad', [{ modelPath: '/cad/b_v2.step', data: s }]);
    expect(versionAt(project, 'C:\\Users\\pc\\b.step')?.outside).toBe(true);
  });

  it('linkedModels names that match a part become linkedParts (own part left out)', () => {
    const lid = sidecar('lid.step', H('b'));
    const box = sidecar('box.step', H('a'), {
      comments: [comment('c', [], 1, { linkedModels: ['LID.step', 'box.step', 'unknown.step'] })],
    });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/lid.step', data: lid },
      { modelPath: '/cad/box.step', data: box },
    ]);
    const lidId = must(project.models.find((m) => m.name === 'lid')).id;
    expect(must(project.comments[0]).linkedParts).toEqual([lidId]);
    expect(must(project.comments[0]).linkedModels).toEqual([
      'LID.step',
      'box.step',
      'unknown.step',
    ]);
  });

  it('body-list folders point to bodies by name (index kept as fallback)', () => {
    const s = sidecar('b.step', H('a'), {
      extra: {
        bodies: [
          { name: 'Base', size: [1, 1, 1], centre: [0, 0, 0], area: 6 },
          { name: 'Pin', path: 'Asm', size: [1, 1, 1], centre: [0, 0, 0], area: 6 },
        ],
        bodyTree: {
          folders: [{ id: 'f1', name: 'Hardware', parent: 'top' }],
          bodies: [
            { body: 1, parent: { folder: 'f1' } },
            { body: 7, parent: 'top' },
          ],
          assemblies: [],
        },
      },
    });
    const { project } = migrate('/cad', [{ modelPath: '/cad/b.step', data: s }]);
    expect(must(project.models[0]).bodyTree?.bodies).toEqual([
      { body: { name: 'Pin', path: 'Asm', index: 1 }, parent: { folder: 'f1' } },
      { body: { name: '', index: 7 }, parent: 'top' },
    ]);
  });

  it('the old v1 "note" and thread replies come along unchanged', () => {
    const c = comment('c', [], 1, {
      note: 'old AI note',
      replies: [
        {
          id: 'r1',
          text: 'done',
          author: 'ai',
          createdAt: day(2),
          updatedAt: day(2),
          status: 'resolved',
        },
      ],
      awaitingConfirm: true,
    });
    const { project } = migrate('/cad', [
      { modelPath: '/cad/b.step', data: sidecar('b.step', H('a'), { comments: [c] }) },
    ]);
    expect(project.comments[0]).toMatchObject({
      note: 'old AI note',
      awaitingConfirm: true,
      replies: [{ id: 'r1' }],
    });
  });

  it('merging later: a sidecar already merged is skipped; a new version joins its part', () => {
    const v1 = sidecar('b.step', H('1'), {
      markers: [marker('m1', 1)],
      comments: [comment('c1', ['m1'], 1)],
    });
    const first = migrate('/cad', [{ modelPath: '/cad/b.step', data: v1 }]);
    Object.assign(must(first.project.markers[0]), { futureField: 1 }); // a newer app's field
    const again = migrate('/cad', [{ modelPath: '/cad/b.step', data: v1 }], posix, first.project);
    expect(again.marks).toEqual([]);
    expect(again.project.models).toEqual(first.project.models);
    expect(again.project.comments).toEqual(first.project.comments);
    expect(again.project.markers).toEqual(first.project.markers); // unknown field kept

    const v2 = sidecar('b_v2.step', H('2'), {
      markers: [marker('m1', 2)],
      comments: [comment('c1', ['m1'], 1), comment('c2', ['m1'], 3)],
      earlier: [link('/cad/b.step', H('1'), 2)],
    });
    const merged = migrate(
      '/cad',
      [{ modelPath: '/cad/sub/../b_v2.step', data: v2 }],
      posix,
      first.project,
    );
    expect(merged.project.models).toHaveLength(1);
    const vs = must(merged.project.models[0]).versions;
    expect(vs.map((v) => v.path)).toEqual(['b.step', 'b_v2.step']);
    expect(must(vs[1]).from).toBe(must(vs[0]).id);
    expect(merged.marks.map((m) => m.versionId)).toEqual([must(vs[1]).id]); // the existing marks untouched
    // Same part, same id = the same comment / marker: no duplicate, the project's copy wins.
    expect(merged.project.comments.find((c) => c.id === 'c1')).toEqual(first.project.comments[0]);
    expect(merged.project.comments.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(must(merged.project.comments[1]).markerIds).toEqual(['m1']);
    expect(merged.project.markers).toEqual(first.project.markers);
    expect(merged.report.renamedMarkers).toBe(0);
  });

  it('merging later: another part with the same marker / comment ids still gets new ids', () => {
    const one = sidecar('bracket.step', H('a'), {
      markers: [marker('m1', 1, 'Bracket marker')],
      comments: [comment('c1', ['m1'], 1)],
    });
    const first = migrate('/cad', [{ modelPath: '/cad/bracket.step', data: one }]);
    const lid = sidecar('lid.step', H('b'), {
      markers: [marker('m1', 2, 'Lid marker')],
      comments: [comment('c1', ['m1'], 2)],
    });
    const r = migrate('/cad', [{ modelPath: '/cad/lid.step', data: lid }], posix, first.project);
    expect(r.project.comments).toHaveLength(2);
    expect(r.project.markers.map((m) => m.name)).toEqual(['Bracket marker', 'Lid marker']);
    expect(r.report.renamedMarkers).toBe(1);
  });

  it('a sidecar of a version the project already has never overwrites its marks', () => {
    const v1 = sidecar('b.step', H('1'), { markers: [marker('m1', 1)] });
    const first = migrate('/cad', [{ modelPath: '/cad/b.step', data: v1 }]);
    const p = { ...first.project, sidecars: [] }; // as if made by v2 directly
    const r = migrate('/cad', [{ modelPath: '/cad/b.step', data: v1 }], posix, p);
    expect(r.marks).toEqual([]);
    expect(r.report.sidecars).toBe(0);
  });

  it('ids are unique and safe file names, even with many parts', () => {
    const sidecars = Array.from({ length: 60 }, (_, i) => ({
      modelPath: `/cad/p${String(i)}.step`,
      data: sidecar(`p${String(i)}.step`, `sha256:${String(i).padStart(64, '0')}`, {
        markers: [marker('m1', 1)],
      }),
    }));
    const { project, marks } = migrate('/cad', sidecars);
    const ids = [
      ...project.models.map((m) => m.id),
      ...project.models.flatMap((m) => m.versions.map((v) => v.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(project.markers.map((m) => m.id)).size).toBe(60);
    expect(marks).toHaveLength(60);
  });
});

describe('collectSidecars + save', () => {
  const setup = (p: PathApi, folder: string) => {
    const fs = new MemoryFs(p);
    fs.addFile(p.join(folder, 'b.step'), 'x');
    return fs;
  };

  it('reads every sidecar of the folder, skips backups and reports broken ones', async () => {
    const fs = setup(posix, '/cad');
    fs.addFile('/cad/b.step.thirdwheel.json', formatJson(sidecar('b.step', H('1'))));
    fs.addFile('/cad/lid.step.thirdwheel.json', formatJson(sidecar('lid.step', H('2'))));
    fs.addFile(
      '/cad/b.step.thirdwheel.2026-11-08-140509.bak.json',
      formatJson(sidecar('b.step', H('9'))),
    );
    fs.addFile('/cad/broken.step.thirdwheel.json', '{ not json');
    fs.addFile('/cad/newer.step.thirdwheel.json', JSON.stringify({ schemaVersion: 9 }));
    fs.addFile('/cad/sub/deep.step.thirdwheel.json', formatJson(sidecar('deep.step', H('3'))));
    const r = await collectSidecars(fs, '/cad', posix);
    expect(r.sidecars.map((s) => s.modelPath).sort()).toEqual(['/cad/b.step', '/cad/lid.step']);
    expect(r.unreadable.map((u) => posix.basename(u.file)).sort()).toEqual([
      'broken.step.thirdwheel.json',
      'newer.step.thirdwheel.json',
    ]);
    // The old sidecars are only read.
    expect(fs.renames).toEqual([]);
  });

  it('a renamed sidecar belongs to the file its name says, not the name inside it', async () => {
    const fs = setup(posix, '/cad');
    fs.addFile('/cad/renamed.step.thirdwheel.json', formatJson(sidecar('original.step', H('1'))));
    const r = await collectSidecars(fs, '/cad', posix);
    expect(must(r.sidecars[0]).modelPath).toBe('/cad/renamed.step');
    const { project } = migrate('/cad', r.sidecars);
    expect(must(must(project.models[0]).versions[0]).path).toBe('renamed.step');
  });

  it('follows chain links out of the folder, only to the contents linked, without looping', async () => {
    const fs = setup(posix, '/cad/proj');
    fs.addFile(
      '/cad/proj/b.step.thirdwheel.json',
      formatJson(sidecar('b.step', H('1'), { newer: [link('/cad/exports/b_v2.step', H('2'), 2)] })),
    );
    fs.addFile(
      '/cad/exports/b_v2.step.thirdwheel.json',
      formatJson(
        sidecar('b_v2.step', H('2'), {
          earlier: [link('/cad/proj/b.step', H('1'), 2)],
          newer: [link('/cad/exports/b_v3.step', H('3'), 3)],
        }),
      ),
    );
    // v3's sidecar now holds other contents (overwritten later): not taken as v3.
    fs.addFile('/cad/exports/b_v3.step.thirdwheel.json', formatJson(sidecar('b_v3.step', H('x'))));
    const r = await collectSidecars(fs, '/cad/proj', posix);
    expect(r.sidecars.map((s) => s.modelPath)).toEqual([
      '/cad/proj/b.step',
      '/cad/exports/b_v2.step',
    ]);
    const { project } = migrate('/cad/proj', r.sidecars);
    expect(must(project.models[0]).versions.map((v) => v.path)).toEqual([
      'b.step',
      '../exports/b_v2.step',
    ]);
  });

  it('unreadable sidecar file (permissions) is reported, the rest migrate', async () => {
    const fs = setup(win, 'C:\\cad');
    fs.addFile('C:\\cad\\b.step.thirdwheel.json', formatJson(sidecar('b.step', H('1'))));
    fs.addFile('C:\\cad\\x.step.thirdwheel.json', '{}');
    fs.unreadable.add('C:\\cad\\x.step.thirdwheel.json');
    const r = await collectSidecars(fs, 'C:\\cad', win);
    expect(r.sidecars).toHaveLength(1);
    expect(must(r.unreadable[0]).errors[0]).toMatch(/EACCES/);
  });

  it('end to end on Windows paths: migrate, save, read back', async () => {
    const fs = setup(win, 'C:\\Users\\me\\cad');
    fs.addFile(
      'C:\\Users\\me\\cad\\b.step.thirdwheel.json',
      formatJson(
        sidecar('b.step', H('1'), {
          markers: [marker('m1', 1)],
          comments: [comment('c1', ['m1'], 1)],
        }),
      ),
    );
    const { sidecars } = await collectSidecars(fs, 'C:\\Users\\me\\cad', win);
    const { project, marks } = migrate('C:\\Users\\me\\cad', sidecars, win);
    const files = projectFiles('C:\\Users\\me\\cad', win);
    await saveProject(fs, files, { project, marks });
    const back = await readProject(fs, files);
    expect(back).toEqual({ kind: 'ok', data: project });
    const m = await readMarks(fs, files, must(must(project.models[0]).versions[0]).id);
    expect(m.kind).toBe('ok');
    expect(fs.read(files.project)).not.toContain('\\\\cad'); // relative, not absolute
  });
});
