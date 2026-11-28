import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatJson, type Annotations } from '@third-wheel/core';
import { FsError, MemoryFs, counterRandom } from '@third-wheel/core/testing';
import type { ProjectState } from '../shared/ipc.js';
import { ProjectSession, type LockHolder } from './project-session.js';

const P = path.posix;
const W = path.win32;
const H = (c: string): string => `sha256:${c.repeat(64)}`;
const TESS = { linearDeflection: 0.1, angularDeflection: 0.5 };

/** MemoryFs where some folders can't be written (read-only checkout, zip). */
class Fs extends MemoryFs {
  readonly lockedDirs: string[] = [];
  private refuse(p: string): void {
    if (this.lockedDirs.some((d) => this.path.resolve(p).startsWith(d)))
      throw new FsError('EACCES');
  }
  override async makeDir(dir: string): Promise<void> {
    this.refuse(dir);
    await super.makeDir(dir);
  }
  override async writeText(file: string, text: string): Promise<void> {
    this.refuse(file);
    await super.writeText(file, text);
  }
}

interface Setup {
  fs: Fs;
  session: ProjectSession;
  notices: string[];
  states: (ProjectState | undefined)[];
  asked: LockHolder[];
}

function setup(
  opts: {
    win?: boolean;
    takeOver?: boolean;
    confirm?: boolean;
    pid?: number;
    host?: string;
    fs?: Fs;
    realpath?: (p: string) => Promise<string>;
  } = {},
): Setup {
  const pathApi = opts.win ? W : P;
  const fs = opts.fs ?? new Fs(pathApi);
  const notices: string[] = [];
  const states: (ProjectState | undefined)[] = [];
  const asked: LockHolder[] = [];
  const session = new ProjectSession({
    fs,
    path: pathApi,
    home: opts.win ? 'C:\\Users\\me' : '/home/me',
    self: {
      host: opts.host ?? 'mac',
      pid: opts.pid ?? 100,
      isAlive: (pid) => pid === 100 || pid === 200,
    },
    now: () => new Date('2026-11-22T09:00:00.000Z'),
    random: counterRandom(),
    realpath: opts.realpath ?? ((p) => Promise.resolve(p)),
    confirm: () => Promise.resolve(opts.confirm ?? true),
    askTakeOver: (h) => {
      asked.push(h);
      return Promise.resolve(opts.takeOver ?? false);
    },
    notice: (t) => notices.push(t),
    stateChanged: (s) => states.push(s),
  });
  return { fs, session, notices, states, asked };
}

const marker = (id: string) => ({
  id,
  name: `Marker ${id}`,
  color: '#00ff00',
  visible: true,
  entities: [{ kind: 'face' as const, id: 3, seq: 1 }],
  paint: { faces: [{ faceId: 3, triangles: [[30, 2]] as [number, number][] }] },
});

function notes(file: string, hash: string, over: Partial<Annotations> = {}): Annotations {
  return {
    schemaVersion: 1,
    model: { fileName: file, format: 'step', contentHash: hash },
    tessellation: TESS,
    markers: [marker('m1')],
    comments: [
      {
        id: 'c1',
        text: 'wall too thin',
        markerIds: ['m1'],
        status: 'open',
        author: 'human',
        createdAt: '2026-11-22T08:00:00.000Z',
        updatedAt: '2026-11-22T08:00:00.000Z',
      },
    ],
    ...over,
  };
}

/** The notes text the window gets for a model file (null = none). */
async function readNotes(
  session: { open(file: string, hash?: string): Promise<{ notes: string | null }> },
  file: string,
  hash?: string,
): Promise<string | null> {
  return (await session.open(file, hash)).notes;
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}

const MODEL = '/home/me/work/bracket.step';
const DIR = '/home/me/work/.thirdwheel';

describe('ProjectSession', () => {
  it('looking at a model writes nothing; the first change makes the project', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    const state = await session.shown(MODEL);
    expect(state).toEqual({
      name: 'work',
      folder: '/home/me/work',
      exists: false,
    });
    expect(await readNotes(session, MODEL)).toBeNull();
    expect([...fs.dirs].some((d) => d.endsWith('.thirdwheel'))).toBe(false);

    const doc = notes('bracket.step', H('a'));
    expect(await session.save(MODEL, formatJson(doc), false)).toEqual({ ok: true });
    expect(fs.read(`${DIR}/project.json`)).toContain('"wall too thin"');
    expect(fs.read(`${DIR}/lock`)).toContain('"pid": 100');
    expect(session.state()?.exists).toBe(true);
    // Read back: the same notes.
    expect(JSON.parse((await readNotes(session, MODEL)) ?? 'null')).toEqual(doc);
  });

  it("a model in a subfolder joins the parent folder's project", async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const sub = '/home/me/work/out/bracket_v2.step';
    fs.addFile(sub, 'step2');
    const state = await session.shown(sub);
    expect(state.folder).toBe('/home/me/work');
    await session.save(
      sub,
      formatJson(notes('bracket_v2.step', H('b'), { comments: [], markers: [] })),
      false,
    );
    const project = JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}') as {
      models: { versions: { path: string }[] }[];
    };
    expect(project.models.flatMap((m) => m.versions.map((v) => v.path)).sort()).toEqual([
      'bracket.step',
      'out/bracket_v2.step',
    ]);
    expect([...fs.dirs].includes('/home/me/work/out/.thirdwheel')).toBe(false);
  });

  it('old notes files move into the project when the folder is first shown; they stay as they were', async () => {
    const { fs, session, notices } = setup();
    fs.addFile(MODEL, 'step');
    const old = formatJson(notes('bracket.step', H('a')));
    fs.addFile(`${MODEL}.thirdwheel.json`, old);
    fs.addFile('/home/me/work/lid.step', 'lid');
    fs.addFile('/home/me/work/lid.step.thirdwheel.json', formatJson(notes('lid.step', H('c'))));
    await session.shown(MODEL);
    expect(fs.read(`${DIR}/project.json`)).toBeDefined();
    expect(notices.join('\n')).toMatch(/Your notes moved into the project.*2 notes files, 2 parts/);
    expect(fs.read(`${MODEL}.thirdwheel.json`)).toBe(old);
    const read = JSON.parse((await readNotes(session, MODEL)) ?? 'null') as Annotations;
    expect(read.comments.map((c) => c.text)).toEqual(['wall too thin']);
    expect(read.markers[0]?.paint.faces[0]?.triangles).toEqual([[30, 2]]);
  });

  it("two markers with one name (old notes files of two parts) are renamed once; open lists the other parts' markers", async () => {
    const { fs, session, notices } = setup();
    fs.addFile(MODEL, 'step');
    fs.addFile(`${MODEL}.thirdwheel.json`, formatJson(notes('bracket.step', H('a'))));
    fs.addFile('/home/me/work/lid.step', 'lid');
    fs.addFile('/home/me/work/lid.step.thirdwheel.json', formatJson(notes('lid.step', H('c'))));
    await session.shown(MODEL);
    expect(notices.join('\n')).toMatch(
      /1 marker was renamed so you and the AI can tell them apart.*"Marker m1" → "Marker m1 \(2\)"/,
    );
    const project = JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}') as {
      markers: { name: string }[];
    };
    expect(project.markers.map((m) => m.name)).toEqual(['Marker m1', 'Marker m1 (2)']);
    const opened = await session.open(MODEL);
    const own = JSON.parse(opened.notes ?? 'null') as Annotations;
    // Every marker of the project (a shown one deleted may still be held by another version).
    expect(own.markers.map((m) => m.name)).toEqual(['Marker m1']);
    expect(opened.otherMarkers?.map((m) => m.name)).toEqual(['Marker m1', 'Marker m1 (2)']);
    // Read again (next app start): nothing left to rename.
    const again = setup({ fs });
    await again.session.shown(MODEL);
    expect(again.notices.join('\n')).not.toMatch(/renamed/);
  });

  it('a model copied in later with its own notes file is merged on open', async () => {
    const { fs, session, notices } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const later = '/home/me/work/pin.step';
    fs.addFile(later, 'pin');
    fs.addFile(`${later}.thirdwheel.json`, formatJson(notes('pin.step', H('d'))));
    await session.shown(later);
    const read = JSON.parse((await readNotes(session, later)) ?? 'null') as Annotations;
    expect(read.comments).toHaveLength(1);
    expect(notices.join('\n')).toContain('The notes of pin.step moved into the project');
    const project = JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}') as {
      models: unknown[];
      comments: unknown[];
    };
    expect(project.models).toHaveLength(2);
    expect(project.comments).toHaveLength(2); // one per part, ids kept apart
  });

  it('a project open on another computer: read-only unless taken over; nothing written', async () => {
    const { fs, session, asked, notices } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    await session.close();
    expect(fs.read(`${DIR}/lock`)).toBeUndefined();
    fs.addFile(
      `${DIR}/lock`,
      JSON.stringify({ host: 'WIN-PC', pid: 5, started: '2026-11-22T08:00:00.000Z' }),
    );
    const before = fs.read(`${DIR}/project.json`);

    const other = setup({ fs });
    const state = await other.session.shown(MODEL);
    expect(other.asked[0]).toMatchObject({ host: 'WIN-PC', otherHost: true });
    expect(state.readOnly).toMatch(/open on WIN-PC/);
    await readNotes(other.session, MODEL); // the window reads before it saves
    const edited = notes('bracket.step', H('a'), { comments: [] });
    const r = await other.session.save(MODEL, formatJson(edited), false);
    expect(r).toMatchObject({ ok: true, readOnly: expect.stringMatching(/WIN-PC/) as unknown });
    expect(fs.read(`${DIR}/project.json`)).toBe(before);
    // The session still shows its own (unsaved) change.
    expect(
      (JSON.parse((await readNotes(other.session, MODEL)) ?? 'null') as Annotations).comments,
    ).toEqual([]);
    expect(asked).toEqual([]);
    expect(notices).toBeDefined();
  });

  it('take over: saves from then on', async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    fs.addFile(
      `${DIR}/lock`,
      JSON.stringify({ host: 'WIN-PC', pid: 5, started: '2026-11-22T08:00:00.000Z' }),
    );
    const { session } = setup({ fs, takeOver: true });
    await session.shown(MODEL);
    expect(await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false)).toEqual({
      ok: true,
    });
    expect(fs.read(`${DIR}/lock`)).toContain('"host": "mac"');
  });

  it('a lock left by a crashed app on this computer is taken without asking', async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    fs.addFile(
      `${DIR}/lock`,
      JSON.stringify({ host: 'mac', pid: 999, started: '2026-11-22T08:00:00.000Z' }),
    );
    const { session, asked } = setup({ fs });
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(asked).toEqual([]);
    expect(fs.read(`${DIR}/lock`)).toContain('"pid": 100');
  });

  it('another app on this computer holds it: asked too (another user, a test profile)', async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    fs.addFile(
      `${DIR}/lock`,
      JSON.stringify({ host: 'mac', pid: 200, started: '2026-11-22T08:00:00.000Z' }),
    );
    const { session, asked } = setup({ fs });
    await session.shown(MODEL);
    expect(asked).toEqual([]); // no project yet: nothing to lock until the first change
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(asked[0]).toMatchObject({ otherHost: false });
    expect(session.state()?.readOnly).toMatch(/another Third Wheel/);
  });

  it("a folder that can't be written opens read-only; changes stay in memory", async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    fs.lockedDirs.push('/home/me/work');
    const { session, notices } = setup({ fs });
    await session.shown(MODEL);
    const r = await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(r).toMatchObject({
      ok: true,
      readOnly: expect.stringMatching(/can't be written/) as unknown,
    });
    expect(notices.join()).toMatch(/can't be written/);
    expect(
      (JSON.parse((await readNotes(session, MODEL)) ?? 'null') as Annotations).comments,
    ).toHaveLength(1);
  });

  it('a project made by a newer app is refused, never overwritten', async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    const newer = JSON.stringify({ schemaVersion: 3, id: 'x', name: 'n' });
    fs.addFile(`${DIR}/project.json`, newer);
    const { session, notices } = setup({ fs });
    const state = await session.shown(MODEL);
    expect(state.readOnly).toMatch(/newer version/);
    expect(notices.join()).toMatch(/newer version/);
    const r = await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(r.ok).toBe(false);
    expect(fs.read(`${DIR}/project.json`)).toBe(newer);
  });

  it('an unreadable project file is moved aside; the old notes files come in again', async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    fs.addFile(`${MODEL}.thirdwheel.json`, formatJson(notes('bracket.step', H('a'))));
    fs.addFile(`${DIR}/project.json`, '{ broken');
    const { session, notices } = setup({ fs });
    await session.shown(MODEL);
    expect(notices.join('\n')).toMatch(
      /could not be read.*moved to \.thirdwheel\/project\..*\.bak\.json/,
    );
    expect([...fs.files.keys()].some((f) => /project\..*\.bak\.json$/.test(f))).toBe(true);
    expect(
      (JSON.parse((await readNotes(session, MODEL)) ?? 'null') as Annotations).comments,
    ).toHaveLength(1);
  });

  it('names sync conflict copies in a notice', async () => {
    const { fs, session, notices } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    fs.addFile(`${DIR}/project (1).json`, '{}');
    const again = setup({ fs });
    await again.session.shown(MODEL);
    expect(again.notices.join()).toMatch(/project \(1\)\.json.*sync service/);
    expect(notices.join()).not.toMatch(/sync/);
  });

  it('a folder path that is too long gives a clear read-only message', async () => {
    const long = `/home/me/${'x'.repeat(220)}/part.step`;
    const { fs, session, notices } = setup();
    fs.addFile(long, 'step');
    const state = await session.shown(long);
    expect(state.readOnly).toMatch(/too long/);
    expect(notices.join()).toMatch(/too long/);
    expect((await session.save(long, formatJson(notes('part.step', H('a'))), false)).ok).toBe(true);
  });

  it('backupFirst copies the project files before the save', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const r = await session.save(
      MODEL,
      formatJson(notes('bracket.step', H('a'), { comments: [] })),
      true,
    );
    expect(r).toMatchObject({
      ok: true,
      backup: expect.stringMatching(/^project\..*\.bak\.json$/) as unknown,
    });
  });

  it("backup moves the version's marks aside; comments stay", async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(await session.backup(MODEL, H('a'))).toMatch(/\.bak\.json$/);
    const after = JSON.parse((await readNotes(session, MODEL)) ?? 'null') as Annotations;
    expect(after.comments).toHaveLength(1);
    expect(after.markers[0]?.paint.faces).toEqual([]);
    expect(fs.read(`${DIR}/project.json`)).toContain('wall too thin');
  });

  it('link: a new version joins the part; open tells both ways; comments are the part’s', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    const v2 = '/home/me/work/bracket_v2.step';
    fs.addFile(v2, 'step2');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    await session.shown(v2);
    // Not listed yet: every marker of the project is another one (its name is taken).
    expect(await session.open(v2, H('b'))).toEqual({
      notes: null,
      listed: false,
      hasMarks: false,
      otherMarkers: [{ id: 'm1', name: 'Marker m1' }],
    });
    expect(await session.link(v2, H('b'), { file: MODEL, contentHash: H('a') })).toEqual({
      kind: 'linked',
    });
    const opened = await session.open(v2, H('b'));
    expect(opened).toMatchObject({
      listed: true,
      hasMarks: false,
      parent: { path: MODEL, name: 'bracket.step', contentHash: H('a'), hasNotes: true },
    });
    // No paint of its own yet; the part's comment shows.
    expect((JSON.parse(opened.notes ?? 'null') as Annotations).comments[0]?.text).toBe(
      'wall too thin',
    );
    expect((await session.open(MODEL, H('a'))).newer).toMatchObject({ name: 'bracket_v2.step' });
    // Twice: nothing changes. The other way round: a circle, refused.
    expect(await session.link(v2, H('b'), { file: MODEL, contentHash: H('a') })).toEqual({
      kind: 'already',
    });
    expect(await session.link(MODEL, H('a'), { file: v2, contentHash: H('b') })).toEqual({
      kind: 'circle',
    });
    expect(
      await session.isEarlier(
        { file: MODEL, contentHash: H('a') },
        { file: v2, contentHash: H('b') },
      ),
    ).toBe(true);
    expect(
      await session.isEarlier(
        { file: v2, contentHash: H('b') },
        { file: MODEL, contentHash: H('a') },
      ),
    ).toBe(false);
  });

  it('link: ids handed out for a part that merges belong to the part it joined (no copies)', async () => {
    const { fs, session } = setup();
    const v2 = '/home/me/work/bracket_v2.step';
    fs.addFile(MODEL, 'step');
    fs.addFile(v2, 'step2');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    await session.shown(v2);
    const own = notes('bracket_v2.step', H('b'), {
      markers: [marker('m5')],
      comments: [
        { ...must(notes('x', H('b')).comments[0]), id: 'c5', markerIds: ['m5'], text: 'on v2' },
      ],
    });
    await session.save(v2, formatJson(own), false);
    // v2 (a part of its own) is linked to bracket.step: its part merges into bracket's.
    await session.link(v2, H('b'), { file: MODEL, contentHash: H('a') });
    // bracket.step's window now shows both comments and saves them back: c5 stays c5.
    await session.shown(MODEL);
    const shown = JSON.parse((await readNotes(session, MODEL, H('a'))) ?? 'null') as Annotations;
    expect(shown.comments.map((c) => c.id).sort()).toEqual(['c1', 'c5']);
    await session.save(MODEL, formatJson(shown), false);
    const project = JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}') as {
      models: unknown[];
      comments: { id: string }[];
    };
    expect(project.models).toHaveLength(1);
    expect(project.comments.map((c) => c.id).sort()).toEqual(['c1', 'c5']);
  });

  it('link: an earlier version the project does not list yet (an STL without notes) comes in; no marks', async () => {
    const { fs, session } = setup();
    const stl = '/home/me/work/plain.stl';
    const step = '/home/me/work/plain-cad.step';
    fs.addFile(stl, 'mesh');
    fs.addFile(step, 'step');
    await session.shown(step);
    await session.link(step, H('f'), { file: stl, contentHash: H('e') });
    const opened = await session.open(stl, H('e'));
    expect(opened).toMatchObject({ listed: true, notes: null, newer: { name: 'plain-cad.step' } });
    const project = JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}') as {
      models: { versions: { format: string }[] }[];
    };
    expect(project.models[0]?.versions.map((v) => v.format)).toEqual(['stl', 'step']);
    expect([...fs.files.keys()].some((f) => f.includes('/marks/'))).toBe(false);
  });

  it('Versions ▾: list, Remove, Locate…, refusals', async () => {
    const { fs, session } = setup();
    const v2 = '/home/me/work/bracket_v2.step';
    const v3 = '/home/me/work/bracket_v3.step';
    for (const f of [MODEL, v2, v3]) fs.addFile(f, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    await session.shown(v2);
    await session.link(v2, H('b'), { file: MODEL, contentHash: H('a') });
    await session.save(v2, formatJson(notes('bracket_v2.step', H('b'))), false);
    await session.shown(v3);
    await session.link(v3, H('c'), { file: v2, contentHash: H('b') });
    await session.save(v3, formatJson(notes('bracket_v3.step', H('c'))), false);
    const list = await session.versions(v3, H('c'));
    expect(list?.rows.map((r) => [r.name, r.shown])).toEqual([
      ['bracket_v3.step', true],
      ['bracket_v2.step', false],
      ['bracket.step', false],
    ]);
    const id2 = list?.rows[1]?.id ?? '';
    await expect(session.removeVersion(v3, H('c'), list?.rows[0]?.id ?? '')).rejects.toThrow(
      /shown version/,
    );
    await expect(session.removeVersion(v3, H('z'), id2)).rejects.toThrow(/not in the project/);
    // v2 removed: v3 is made from v1 now, and a save of v3 keeps it so (links aren't in notes).
    await session.removeVersion(v3, H('c'), id2);
    await session.save(v3, formatJson(notes('bracket_v3.step', H('c'))), false);
    expect((await session.versions(v3, H('c')))?.rows.map((r) => r.name)).toEqual([
      'bracket_v3.step',
      'bracket.step',
    ]);
    expect((await session.open(v3, H('c'))).parent?.name).toBe('bracket.step');
    const project = JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}') as { models: unknown[] };
    expect(project.models).toHaveLength(2);
    expect((await session.open(v2, H('b'))).unlinked).toBe(true);
    // Another part's version can't be changed from here.
    await expect(session.removeVersion(v3, H('c'), id2)).rejects.toThrow(/shown part/);
    // Locate… the first version at its new place.
    const moved = '/home/me/work/old/bracket.step';
    fs.addFile(moved, 'step');
    const id1 = (await session.versions(v3, H('c')))?.rows[1]?.id ?? '';
    await session.locateVersion(v3, H('c'), id1, moved);
    expect((await session.open(v3, H('c'))).parent?.path).toBe(moved);
    expect(fs.read(`${DIR}/project.json`)).toContain('"old/bracket.step"');
  });

  it('a file saved over in place stays one version; its paint stays until the window saves', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const before = await session.open(MODEL, H('b'));
    expect(before).toMatchObject({ listed: false, replaced: { contentHash: H('a') } });
    await session.replaceContents(MODEL, H('a'), H('b'));
    const after = await session.open(MODEL, H('b'));
    expect(after).toMatchObject({ listed: true, hasMarks: true });
    expect(after.replaced).toBeUndefined();
    // The old contents are no longer listed; no backup was made.
    expect(await readNotes(session, MODEL, H('a'))).toBeNull();
    expect([...fs.files.keys()].some((f) => f.endsWith('.bak.json'))).toBe(false);
    // The window saves the paint it moved; or, when it can't move it, moves it aside.
    await session.save(MODEL, formatJson(notes('bracket.step', H('b'))), false);
    expect((await session.versions(MODEL, H('b')))?.rows).toHaveLength(1);
    expect(await session.backup(MODEL, H('b'))).toMatch(/\.bak\.json$/);
    expect(await session.open(MODEL, H('b'))).toMatchObject({ listed: true, hasMarks: false });
    // Contents the project never saw: the file's listed version was saved over.
    expect((await session.open(MODEL, H('z'))).replaced?.contentHash).toBe(H('b'));
    await expect(session.replaceContents(MODEL, H('a'), H('c'))).rejects.toThrow(/not a version/);
  });

  it('notesTime: versions with marks and old notes files count as having notes', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    fs.addFile('/home/me/work/other.step', 'o');
    expect(await session.notesTime(MODEL)).toBeUndefined();
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(await session.notesTime(MODEL)).toBeTypeOf('number');
    expect(await session.notesTime('/home/me/work/other.step')).toBeUndefined();
  });

  it('works with Windows paths (relative with /, lock, read back)', async () => {
    const { fs, session } = setup({ win: true });
    const model = 'C:\\Users\\me\\work\\out\\Bracket.step';
    fs.addFile(model, 'step');
    await fs.makeDir('C:\\Users\\me\\work\\.thirdwheel'); // a project folder above
    const state = await session.shown(model);
    expect(state.folder).toBe('C:\\Users\\me\\work');
    const doc = notes('Bracket.step', H('a'));
    expect(await session.save(model, formatJson(doc), false)).toEqual({ ok: true });
    expect(fs.read('C:\\Users\\me\\work\\.thirdwheel\\project.json')).toContain(
      '"path": "out/Bracket.step"',
    );
    expect(JSON.parse((await readNotes(session, model)) ?? 'null')).toEqual(doc);
  });

  it('changes made on disk while the app runs are read on the next open (git checkout)', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const file = `${DIR}/project.json`;
    fs.addFile(file, (fs.read(file) ?? '').replace('wall too thin', 'edited elsewhere'));
    await session.shown(MODEL);
    const read = JSON.parse((await readNotes(session, MODEL)) ?? 'null') as Annotations;
    expect(read.comments[0]?.text).toBe('edited elsewhere');
    expect(fs.read(`${DIR}/lock`)).toContain('"pid": 100'); // still held
  });

  it('New project in this folder: the part, its comments and paint move; the parent keeps the rest', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    const sub = '/home/me/work/lid/lid.step';
    fs.addFile(sub, 'lid');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    await session.shown(sub);
    const lidNotes = notes('lid.step', H('c'), {
      markers: [marker('m7')],
      comments: [
        {
          ...notes('x', H('c')).comments[0],
          id: 'c7',
          text: 'lid gap',
          markerIds: ['m7'],
        } as Annotations['comments'][number],
      ],
    });
    await session.save(sub, formatJson(lidNotes), false);
    expect(JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}')).toMatchObject({ models: [{}, {}] });

    const state = await session.newProjectHere(sub);
    expect(state).toMatchObject({ folder: '/home/me/work/lid', name: 'lid', exists: true });
    const parent = JSON.parse(fs.read(`${DIR}/project.json`) ?? '{}') as {
      models: unknown[];
      comments: { text: string }[];
      markers: { id: string }[];
    };
    expect(parent.models).toHaveLength(1);
    expect(parent.comments.map((c) => c.text)).toEqual(['wall too thin']);
    expect(parent.markers.map((m) => m.id)).toEqual(['m1']);
    const child = JSON.parse(fs.read('/home/me/work/lid/.thirdwheel/project.json') ?? '{}') as {
      models: { versions: { path: string }[] }[];
      comments: { text: string }[];
    };
    expect(child.models[0]?.versions[0]?.path).toBe('lid.step');
    expect(child.comments.map((c) => c.text)).toEqual(['lid gap']);
    expect([...fs.files.keys()].filter((f) => f.startsWith(`${DIR}/marks/`))).toHaveLength(1);
    // The lid now reads from its own project; the lock moved with it.
    expect(
      (JSON.parse((await readNotes(session, sub)) ?? 'null') as Annotations).comments[0]?.text,
    ).toBe('lid gap');
    expect(fs.read(`${DIR}/lock`)).toBeUndefined();
    expect(fs.read('/home/me/work/lid/.thirdwheel/lock')).toBeDefined();
    // Cancelled or already its own: nothing changes.
    expect((await session.newProjectHere(sub))?.folder).toBe('/home/me/work/lid');
  });

  it('New project in this folder: cancelled → nothing written', async () => {
    const { fs, session } = setup({ confirm: false });
    fs.addFile(MODEL, 'step');
    const sub = '/home/me/work/lid/lid.step';
    fs.addFile(sub, 'lid');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    await session.shown(sub);
    expect(await session.newProjectHere(sub)).toBeUndefined();
    expect([...fs.dirs].includes('/home/me/work/lid/.thirdwheel')).toBe(false);
  });

  it('New project folder: made at once, current with no model; a folder with a project is left as it is', async () => {
    const { fs, session, states } = setup();
    const r = await session.newFolderProject('/home/me/cad/wheel');
    expect(r).toMatchObject({ state: { folder: '/home/me/cad/wheel', exists: true } });
    expect(fs.read('/home/me/cad/wheel/.thirdwheel/project.json')).toContain('"models": []');
    expect(fs.read('/home/me/cad/wheel/.thirdwheel/lock')).toBeDefined();
    expect(session.state()?.folder).toBe('/home/me/cad/wheel');
    expect(states.at(-1)?.folder).toBe('/home/me/cad/wheel');
    // A model added there finds it, also from a subfolder.
    const sub = '/home/me/cad/wheel/out/wheel.step';
    fs.addFile(sub, 'step');
    expect(await session.placeOf(sub)).toEqual({ place: 'inside', listed: false });
    expect((await session.shown(sub)).folder).toBe('/home/me/cad/wheel');
    // Picked again: the project already there (it is the shown one).
    expect(await session.newFolderProject('/home/me/cad/wheel')).toMatchObject({
      existing: { folder: '/home/me/cad/wheel' },
      models: 0,
      comments: 0,
      shown: true,
    });
  });

  it('New project folder: refused inside a project that lists models there', async () => {
    const { fs, session } = setup();
    const lid = '/home/me/work/lid/lid.step';
    fs.addFile(lid, 'lid');
    await session.shown(lid);
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    await session.shown(lid);
    await session.save(lid, formatJson(notes('lid.step', H('b'))), false);
    const r = await session.newFolderProject('/home/me/work/lid');
    expect(r).toMatchObject({ parent: { folder: '/home/me/work' } });
    expect([...fs.dirs].includes('/home/me/work/lid/.thirdwheel')).toBe(false);
    // An empty subfolder is fine: its own project.
    expect(await session.newFolderProject('/home/me/work/new')).toMatchObject({
      state: { folder: '/home/me/work/new' },
    });
    // The other project, not shown now: what's in it, nothing changes.
    expect(await session.newFolderProject('/home/me/work')).toMatchObject({
      existing: { folder: '/home/me/work' },
      models: 2,
      shown: false,
    });
    expect(session.state()?.folder).toBe('/home/me/work/new');
  });

  it('Add file with nothing shown: the newest version of a part whose name matches', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const v2 = '/home/me/work/bracket_v2.step';
    fs.addFile(v2, 'step2');
    await session.link(v2, H('b'), { file: MODEL, contentHash: H('a') });
    const v3 = '/home/me/work/bracket_v3.step';
    expect(await session.namedPart(v3)).toMatchObject({ path: v2, contentHash: H('b') });
    // Listed already, or a name that matches nothing: none.
    expect(await session.namedPart(v2)).toBeUndefined();
    expect(await session.namedPart('/home/me/work/lid.step')).toBeUndefined();
  });

  it('Add file: inside, listed, in a sub-project, or outside the project folder', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    expect(await session.placeOf('/home/me/work/bracket_v2.step')).toEqual({
      place: 'inside',
      listed: false,
    });
    // Adding writes: the project is on disk now, so a subfolder's model finds it.
    expect(fs.read(`${DIR}/project.json`)).toBeDefined();
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(await session.placeOf(MODEL)).toEqual({ place: 'inside', listed: true });
    expect(await session.placeOf('/home/me/other/x.step')).toEqual({ place: 'outside' });
    // A folder beside it whose name starts the same is still outside.
    expect(await session.placeOf('/home/me/work2/x.step')).toEqual({ place: 'outside' });
    fs.addFile('/home/me/work/lid/.thirdwheel/project.json', 'x');
    await fs.makeDir('/home/me/work/lid/.thirdwheel');
    expect(await session.placeOf('/home/me/work/lid/lid.step')).toMatchObject({
      place: 'other',
      project: { folder: '/home/me/work/lid' },
    });
  });

  it('load_model (AI): outside the project folder or in a sub-project → refused, nothing written', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    fs.addFile('/home/me/work/lid.step', 'l');
    const before = new Map(fs.files);
    const out = await session.checkAiLoad('/home/me/Downloads/bracket_v2.step', H('b'), true);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The exact path to use, and a way out instead of a retry loop.
    expect(out.message).toContain('outside the project folder /home/me/work');
    expect(out.message).toContain('Save or copy it as /home/me/work/bracket_v2.step');
    expect(out.message).toContain("don't try again: tell the user");
    // Also without revisionOf (a separate part); a taken name gets the next free one.
    const lid = await session.checkAiLoad('/home/me/other/lid.step', H('c'), false);
    expect(lid).toMatchObject({ ok: false });
    expect(lid.ok ? '' : lid.message).toContain('as /home/me/work/lid_v2.step');
    // No project is looked for or made in the other folder.
    expect(fs.files).toEqual(before);
    expect(session.state()?.folder).toBe('/home/me/work');
    // A subfolder with its own project is another project.
    await fs.makeDir('/home/me/work/sub/.thirdwheel');
    const sub = await session.checkAiLoad('/home/me/work/sub/x.step', H('d'), false);
    expect(sub.ok ? '' : sub.message).toContain(
      'is in /home/me/work/sub, a folder with its own project',
    );
    // A plain subfolder is inside.
    expect(await session.checkAiLoad('/home/me/work/out/x.step', H('e'), false)).toEqual({
      ok: true,
      saveNextAs: '/home/me/work/out/x_v2.step',
    });
  });

  it('load_model (AI): a new version saved over a listed file → refused with a free name; without revisionOf allowed', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    fs.addFile('/home/me/work/bracket_v2.step', 'v2');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    // Same contents as listed: fine; saveNextAs skips names on disk.
    expect(await session.checkAiLoad(MODEL, H('a'), true)).toEqual({
      ok: true,
      saveNextAs: '/home/me/work/bracket_v3.step',
    });
    const over = await session.checkAiLoad(MODEL, H('b'), true);
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.message).toMatch(
      /bracket\.step is already a version in the project with other contents.*save it as \/home\/me\/work\/bracket_v3\.step and load that with revisionOf/,
    );
    // Without revisionOf: the same version with new contents (as Reload), not refused.
    expect(await session.checkAiLoad(MODEL, H('b'), false)).toMatchObject({ ok: true });
    // A name the project lists but whose file is gone is not offered either.
    fs.files.delete('/home/me/work/bracket_v2.step');
    await session.link('/home/me/work/bracket_v2.step', H('c'), {
      file: MODEL,
      contentHash: H('a'),
    });
    expect(await session.checkAiLoad(MODEL, H('a'), true)).toMatchObject({
      saveNextAs: '/home/me/work/bracket_v3.step',
    });
  });

  it('load_model (AI): no project shown → passes; its folder gives saveNextAs', async () => {
    const { fs, session } = setup();
    fs.addFile('/home/me/elsewhere/part.step', 'p');
    expect(await session.checkAiLoad('/home/me/elsewhere/part.step', H('a'), false)).toEqual({
      ok: true,
      saveNextAs: '/home/me/elsewhere/part_v2.step',
    });
    expect(session.state()).toBeUndefined();
  });

  it('load_model (AI) on Windows: another drive is outside; case-insensitive folder', async () => {
    const { fs, session } = setup({ win: true });
    const model = 'C:\\Users\\me\\cad\\a.step';
    fs.addFile(model, 'step');
    await session.shown(model);
    const out = await session.checkAiLoad('D:\\cad\\a_v2.step', H('b'), true);
    expect(out.ok ? '' : out.message).toContain('as C:\\Users\\me\\cad\\a_v2.step');
    expect(await session.checkAiLoad('C:\\Users\\me\\cad\\out\\a_v2.step', H('b'), true)).toEqual({
      ok: true,
      saveNextAs: 'C:\\Users\\me\\cad\\out\\a_v3.step',
    });
  });

  it("quitting while the window's lock release is under way still names the lock (removed on quit)", async () => {
    let letGo: () => void = () => undefined;
    class SlowFs extends Fs {
      override async remove(file: string): Promise<void> {
        await new Promise<void>((r) => (letGo = r)); // the app exits before this finishes
        await super.remove(file);
      }
    }
    const fs = new SlowFs(P);
    fs.addFile(MODEL, 'step');
    const { session } = setup({ fs });
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const lock = session.heldLock();
    expect(lock).toBeDefined();
    const closing = session.close(); // the window closed (quit)
    await new Promise((r) => setTimeout(r, 0));
    expect(session.heldLock()).toBe(lock); // will-quit removes it now
    letGo();
    await closing;
    expect(session.heldLock()).toBeUndefined();
  });

  it("Windows: one project folder under two spellings is one project (the AI's revisionOf check)", async () => {
    // The real Windows file system: any case, the stored spelling comes back from realpath.
    const real = 'C:\\Users\\me\\Cad';
    const realpath = (p: string): Promise<string> =>
      Promise.resolve(
        p.toLowerCase().startsWith(real.toLowerCase()) ? real + p.slice(real.length) : p,
      );
    const { fs, session } = setup({ win: true, realpath });
    const model = `${real}\\a.step`;
    fs.addFile(model, 'step');
    await fs.makeDir(`${real}\\.thirdwheel`);
    expect((await session.shown(model)).folder).toBe(real);
    // The window compares these strings (load_model: revisionOf of "another project").
    expect(await session.projectFolders(['c:\\users\\me\\cad\\a_v2.step', model])).toEqual([
      real,
      real,
    ]);
    expect(await session.placeOf('c:\\users\\me\\cad\\b.step')).toMatchObject({
      place: 'inside',
    });
  });

  it('Add file on Windows: case and drive letters', async () => {
    const { fs, session } = setup({ win: true });
    const model = 'C:\\Users\\me\\cad\\a.step';
    fs.addFile(model, 'step');
    await session.shown(model);
    expect(await session.placeOf('C:\\Users\\me\\cad\\out\\b.step')).toMatchObject({
      place: 'inside',
    });
    expect(await session.placeOf('D:\\cad\\b.step')).toEqual({ place: 'outside' });
  });

  it('Open folder with nothing to show: its project becomes current, nothing written', async () => {
    const { fs, session } = setup();
    const state = await session.openEmpty('/home/me/empty');
    expect(state).toMatchObject({ folder: '/home/me/empty', exists: false });
    expect([...fs.dirs].some((d) => d.endsWith('.thirdwheel'))).toBe(false);
    expect(session.state()?.folder).toBe('/home/me/empty');
  });

  it('Save project as: a read-only project copied to another folder, saved there from then on', async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    fs.addFile(`${MODEL}.thirdwheel.json`, formatJson(notes('bracket.step', H('a'))));
    fs.lockedDirs.push('/home/me/work');
    const { session } = setup({ fs });
    const state = await session.shown(MODEL);
    expect(state.readOnly).toMatch(/can't be written/);
    await readNotes(session, MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'), { comments: [] })), false);
    const copy = await session.saveAs('/home/me/copies');
    expect(copy).toMatchObject({ folder: '/home/me/copies', name: 'copies', exists: true });
    const project = JSON.parse(fs.read('/home/me/copies/.thirdwheel/project.json') ?? '{}') as {
      models: { versions: { path: string }[] }[];
      comments: unknown[];
    };
    expect(project.models[0]?.versions[0]?.path).toBe('../work/bracket.step');
    expect(project.comments).toEqual([]); // the unsaved change came along
    // Later saves go to the copy.
    expect(await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false)).toEqual({
      ok: true,
    });
    expect(fs.read('/home/me/copies/.thirdwheel/project.json')).toContain('wall too thin');
    await expect(session.saveAs('/home/me/copies')).rejects.toThrow(/already has a project/);
  });

  it('Open Folder: the model shown last, else the newest version on disk', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    const v2 = '/home/me/work/bracket_v2.step';
    fs.addFile(v2, 'step2');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    expect(await session.modelOf('/home/me/work', undefined)).toBe(MODEL);
    expect(await session.modelOf('/home/me/work', v2)).toBe(MODEL); // not in the project
    expect(await session.modelOf('/home/me/empty', undefined)).toBeUndefined();
  });

  it('another computer took the lock over meanwhile: asked again on the next open', async () => {
    const { fs, session, asked } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    fs.addFile(
      `${DIR}/lock`,
      JSON.stringify({ host: 'WIN-PC', pid: 5, started: '2026-11-22T08:00:00.000Z' }),
    );
    const state = await session.shown(MODEL);
    expect(asked).toHaveLength(1);
    expect(state.readOnly).toMatch(/WIN-PC/);
  });
});

describe('ProjectSession chats', () => {
  const line = (seq: number, kind: string, text: string, extra: object = {}) => ({
    seq,
    kind,
    text,
    at: '2026-11-22T09:00:00.000Z',
    ...extra,
  });

  it('the first chat line makes the project; lines append, the index keeps title and count', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    const folder = '/home/me/work';
    expect(await session.chatIndex(folder)).toEqual([]);
    expect(await session.appendChatLines(folder, 'k1', [line(1, 'user', 'Hi')], 'Hi')).toBe(
      'saved',
    );
    expect(fs.read(`${DIR}/chats/k1.jsonl`)).toBe(`${JSON.stringify(line(1, 'user', 'Hi'))}\n`);
    expect(await session.appendChatLines(folder, 'k1', [line(2, 'agent', 'Hello')], 'x')).toBe(
      'saved',
    );
    expect(await session.chatIndex(folder)).toEqual([
      {
        id: 'k1',
        title: 'Hi',
        created: '2026-11-22T09:00:00.000Z',
        last: '2026-11-22T09:00:00.000Z',
        entries: 2,
      },
    ]);
    expect(fs.read(`${DIR}/project.json`)).toContain('"k1"');
    expect((await session.chatLines(folder, 'k1')).map((l) => l.text)).toEqual(['Hi', 'Hello']);
    expect(await session.chatLines(folder, 'nope')).toEqual([]);
  });

  it("the agent's summary goes into the index; a catch-up gets parts, open comments, summary", async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const folder = '/home/me/work';
    await session.appendChatLines(folder, 'k1', [line(1, 'user', 'Hi')], 'Hi');
    await session.appendChatLines(folder, 'k1', [line(2, 'summary', 'x')], 'Hi', 'Wall Ø2');
    expect((await session.chatIndex(folder))[0]?.summary).toBe('Wall Ø2');
    // Added at 09:00 (test clock): new since 08:00, not since 10:00.
    const early = Date.parse('2026-11-22T08:00:00.000Z');
    expect(await session.chatFacts(folder, early, 'k1')).toEqual({
      name: 'work',
      parts: [{ file: 'bracket.step', newVersions: ['bracket.step'], openComments: 1 }],
      summary: { of: 'this topic', text: 'Wall Ø2' },
    });
    const late = Date.parse('2026-11-22T10:00:00.000Z');
    expect(await session.chatFacts(folder, late, 'k2')).toEqual({
      name: 'work',
      parts: [{ file: 'bracket.step', openComments: 1 }],
      summary: { of: 'earlier topic', text: 'Wall Ø2' },
    });
    expect(await session.chatFacts('/elsewhere', undefined, undefined)).toBeUndefined();
  });

  it('a model file stands for its version and part; a part links to its newest version', async () => {
    const { fs, session } = setup();
    fs.addFile(MODEL, 'step');
    await session.shown(MODEL);
    await session.save(MODEL, formatJson(notes('bracket.step', H('a'))), false);
    const folder = '/home/me/work';
    const place = must(await session.versionPlace(folder, MODEL));
    expect(await session.partLink(folder, place.partId)).toEqual({
      path: MODEL,
      name: 'bracket.step',
    });
    expect(await session.versionPlace(folder, '/home/me/work/other.step')).toBeUndefined();
    expect(await session.partLink(folder, 'gone')).toBeUndefined();
  });

  it("another project's chat is written without showing it (lock taken quietly, released); open elsewhere: waits", async () => {
    const { fs, session, asked } = setup();
    fs.addFile(MODEL, 'step');
    fs.addFile('/home/me/other/part.step', 'step');
    await session.shown(MODEL);
    const work = '/home/me/work';
    await session.appendChatLines(work, 'k1', [line(1, 'user', 'Thicker wall?')], 'Thicker wall?');
    await session.shown('/home/me/other/part.step'); // the user moved on to another project
    expect(fs.read(`${DIR}/lock`)).toBeUndefined();
    expect(await session.appendChatLines(work, 'k1', [line(2, 'agent', 'Done: 3 mm')], 'x')).toBe(
      'saved',
    );
    expect(fs.read(`${DIR}/chats/k1.jsonl`)?.trim().split('\n')).toHaveLength(2);
    expect(fs.read(`${DIR}/project.json`)).toContain('"entries": 2');
    expect(fs.read(`${DIR}/lock`)).toBeUndefined(); // released again
    expect(asked).toEqual([]);
    // Open in another Third Wheel: never asks, the lines wait.
    fs.addFile(
      `${DIR}/lock`,
      JSON.stringify({ host: 'WIN-PC', pid: 5, started: '2026-11-22T08:00:00.000Z' }),
    );
    expect(await session.appendChatLines(work, 'k1', [line(3, 'agent', 'More')], 'x')).toBe(
      'not-shown',
    );
    expect(fs.read(`${DIR}/chats/k1.jsonl`)?.trim().split('\n')).toHaveLength(2);
    expect(asked).toEqual([]);
  });

  it('a read-only project or another folder: nothing is written', async () => {
    const fs = new Fs(P);
    fs.addFile(MODEL, 'step');
    fs.lockedDirs.push('/home/me/work');
    const { session } = setup({ fs });
    await session.shown(MODEL);
    expect(
      await session.appendChatLines('/home/me/work', 'k1', [line(1, 'user', 'Hi')], 'Hi'),
    ).toBe('read-only');
    // Another folder without a project: nothing there to add a topic to.
    expect(await session.appendChatLines('/elsewhere', 'k1', [line(1, 'user', 'Hi')], 'Hi')).toBe(
      'read-only',
    );
    expect([...fs.dirs].some((d) => d.endsWith('.thirdwheel'))).toBe(false);
  });
});
