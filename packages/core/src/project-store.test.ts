import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatJson } from './format-json.js';
import { lockText, parseLock } from './project-lock.js';
import { projectFiles, type ProjectFiles } from './project-paths.js';
import { parseChatLog } from './project-schema.js';
import { sampleMarks, sampleProject, must } from './testing/fixtures.js';
import {
  MAX_PROJECT_FILE_BYTES,
  RENAME_RETRY_MS,
  acquireLock,
  appendChatEntry,
  copyAside,
  findProjectFolder,
  moveAside,
  readChat,
  readMarks,
  readProject,
  releaseLock,
  saveProject,
  strayProjectFiles,
} from './project-store.js';
import { MemoryFs, counterRandom } from './testing/memory-fs.js';

const T = '2026-11-21T10:00:00.000Z';

for (const [os, p, folder] of [
  ['macOS', path.posix, '/Users/me/cad'],
  ['Windows', path.win32, 'C:\\Users\\me\\cad'],
] as const) {
  describe(`project store (${os} paths)`, () => {
    let fs: MemoryFs;
    let files: ProjectFiles;
    beforeEach(() => {
      fs = new MemoryFs(p);
      fs.addFile(p.join(folder, 'bracket.step'), 'ISO-10303-21;');
      files = projectFiles(folder, p);
    });

    it('saves and reads back a project with its marks', async () => {
      await saveProject(fs, files, { project: sampleProject(), marks: [sampleMarks()] });
      const r = await readProject(fs, files);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') expect(r.data).toEqual(sampleProject());
      const m = await readMarks(fs, files, 'ver0000001');
      expect(m.kind).toBe('ok');
      expect(fs.temps()).toEqual([]);
      expect(fs.read(files.project)).toMatch(/\n$/);
      expect(fs.read(files.project)).not.toMatch(/\r/);
    });

    it('writes .thirdwheel/.gitignore (chats, lock) when missing, never over an edited one', async () => {
      await saveProject(fs, files, { project: sampleProject() });
      expect(fs.read(files.gitignore)).toMatch(/^chats\/$/m);
      expect(fs.read(files.gitignore)).toMatch(/^lock$/m);
      fs.addFile(files.gitignore, 'lock\n');
      await saveProject(fs, files, { project: sampleProject() });
      expect(fs.read(files.gitignore)).toBe('lock\n');
      expect(await strayProjectFiles(fs, files)).toEqual([]);
    });

    it('renames marks before project.json (the project never lists marks not yet there)', async () => {
      await saveProject(fs, files, { project: sampleProject(), marks: [sampleMarks()] });
      expect(fs.renames.map((r) => p.basename(r.to))).toEqual(['ver0000001.json', 'project.json']);
    });

    it('retries a rename Windows refuses for a moment (antivirus, OneDrive)', async () => {
      fs.renameFails.set(p.resolve(files.project), ['EPERM', 'EBUSY']);
      await saveProject(fs, files, { project: sampleProject() });
      expect(fs.sleeps).toEqual([50, 100]);
      expect((await readProject(fs, files)).kind).toBe('ok');
    });

    it('gives up after the retries, keeps the old file and leaves no temp file', async () => {
      await saveProject(fs, files, { project: sampleProject() });
      const before = fs.read(files.project);
      fs.renameFails.set(p.resolve(files.project), Array(10).fill('EPERM') as string[]);
      const changed = { ...sampleProject(), name: 'changed' };
      await expect(saveProject(fs, files, { project: changed })).rejects.toMatchObject({
        code: 'EPERM',
      });
      expect(fs.sleeps).toEqual(RENAME_RETRY_MS);
      expect(fs.read(files.project)).toBe(before);
      expect(fs.temps()).toEqual([]);
    });

    it('does not retry errors that will not go away (ENOENT)', async () => {
      fs.renameFails.set(p.resolve(files.project), ['ENOENT']);
      await expect(saveProject(fs, files, { project: sampleProject() })).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(fs.sleeps).toEqual([]);
    });

    it('a failed temp write (disk full) renames nothing: old files stay whole', async () => {
      await saveProject(fs, files, { project: sampleProject(), marks: [sampleMarks()] });
      const oldProject = fs.read(files.project);
      const oldMarks = fs.read(files.marks('ver0000001'));
      fs.writeFails.push('project.json');
      const marks = sampleMarks();
      must(marks.markers[0]).entities = [];
      await expect(
        saveProject(fs, files, { project: { ...sampleProject(), name: 'x' }, marks: [marks] }),
      ).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(fs.read(files.project)).toBe(oldProject);
      expect(fs.read(files.marks('ver0000001'))).toBe(oldMarks);
      expect(fs.temps()).toEqual([]);
    });

    it('refuses to write a project that would not read back, before touching the disk', async () => {
      const bad = sampleProject();
      must(bad.comments[0]).markerIds = ['missing'];
      await expect(saveProject(fs, files, { project: bad })).rejects.toThrow();
      expect(await fs.isDirectory(files.dir)).toBe(false);
    });

    it('refuses marks of one version given twice in one save', async () => {
      await expect(
        saveProject(fs, files, { marks: [sampleMarks(), sampleMarks()] }),
      ).rejects.toThrow(/twice/);
    });

    it('reads: missing, too big, not readable, broken, newer', async () => {
      expect((await readProject(fs, files)).kind).toBe('missing');

      fs.addFile(files.project, formatJson(sampleProject()));
      fs.fakeSize.set(p.resolve(files.project), MAX_PROJECT_FILE_BYTES + 1);
      expect(await readProject(fs, files)).toMatchObject({
        kind: 'unreadable',
        errors: ['larger than 256 MB'],
      });
      fs.fakeSize.clear();

      fs.unreadable.add(p.resolve(files.project));
      expect(await readProject(fs, files)).toMatchObject({ kind: 'unreadable' });
      fs.unreadable.clear();

      fs.addFile(files.project, '{ "schemaVersion": 2, "id": ');
      expect((await readProject(fs, files)).kind).toBe('unreadable');

      fs.addFile(files.project, JSON.stringify({ ...sampleProject(), schemaVersion: 7 }));
      expect((await readProject(fs, files)).kind).toBe('newer');
    });

    it('a marks file copied over another version is refused (its triangles belong elsewhere)', async () => {
      fs.addFile(files.marks('ver0000002'), formatJson(sampleMarks()));
      const r = await readMarks(fs, files, 'ver0000002');
      expect(r).toMatchObject({ kind: 'unreadable' });
    });

    it('appends chat lines and never glues one onto a half-written line', async () => {
      const entry = (seq: number) => ({ seq, kind: 'user', text: `m${String(seq)}`, at: T });
      await appendChatEntry(fs, files, 'chat000001', entry(1));
      fs.addFile(
        files.chat('chat000001'),
        `${fs.read(files.chat('chat000001')) ?? ''}{"seq":2,"ki`,
      );
      await appendChatEntry(fs, files, 'chat000001', entry(3));
      const r = await readChat(fs, files, 'chat000001');
      if (r.kind !== 'ok') throw new Error(r.kind);
      expect(r.data.entries.map((e) => e.seq)).toEqual([1, 3]);
      expect(r.data.badLines).toEqual([2]);
    });

    it('reads a chat log rewritten with \\r\\n by git', async () => {
      await appendChatEntry(fs, files, 'chat000001', { seq: 1, kind: 'user', text: 'a', at: T });
      await appendChatEntry(fs, files, 'chat000001', { seq: 2, kind: 'agent', text: 'b', at: T });
      const crlf = (fs.read(files.chat('chat000001')) ?? '').replace(/\n/g, '\r\n');
      expect(parseChatLog(crlf).entries).toHaveLength(2);
    });

    it('moves an unreadable file aside without overwriting an earlier backup', async () => {
      fs.addFile(files.project, 'broken');
      const at = new Date(2026, 10, 21, 14, 5, 9);
      fs.addFile(p.join(files.dir, 'project.2026-11-21-140509.bak.json'), 'older backup');
      const to = await moveAside(fs, files.project, at, p);
      expect(p.basename(to)).toBe('project.2026-11-21-140509.bak-2.json');
      expect(fs.read(to)).toBe('broken');
      expect(fs.read(files.project)).toBeUndefined();
      expect(fs.read(p.join(files.dir, 'project.2026-11-21-140509.bak.json'))).toBe('older backup');
    });

    it('copies a file aside before a save that loses data', async () => {
      fs.addFile(files.project, 'old');
      const to = await copyAside(fs, files.project, new Date(2026, 10, 21, 14, 5, 9), p);
      expect(fs.read(to)).toBe('old');
      expect(fs.read(files.project)).toBe('old');
    });

    it('names conflict copies and stray files, not our own temp and backup files', async () => {
      await saveProject(fs, files, { project: sampleProject(), marks: [sampleMarks()] });
      fs.addFile(p.join(files.dir, 'project (1).json'), '{}');
      fs.addFile(p.join(files.dir, 'project.2026-11-21-140509.bak.json'), '{}');
      fs.addFile(p.join(files.marksDir, 'ver0000001-DESKTOP.json'), '{}');
      fs.addFile(p.join(files.marksDir, 'ver0000001.json.abc.tmp'), '');
      expect(await strayProjectFiles(fs, files)).toEqual([
        'marks/ver0000001-DESKTOP.json',
        'project (1).json',
      ]);
    });

    it('finds the nearest project upwards; a sub-folder project wins over the parent', async () => {
      const sub = p.join(folder, 'out');
      const home = p.dirname(p.dirname(folder));
      fs.addFile(p.join(sub, 'part.step'), 'x');
      expect(await findProjectFolder(fs, sub, home, p)).toBeUndefined();
      await fs.makeDir(p.join(folder, '.thirdwheel'));
      expect(await findProjectFolder(fs, sub, home, p)).toBe(p.resolve(folder));
      await fs.makeDir(p.join(sub, '.thirdwheel'));
      expect(await findProjectFolder(fs, sub, home, p)).toBe(p.resolve(sub));
    });

    it('never takes a project above the home folder', async () => {
      const home = p.dirname(folder); // …/me
      await fs.makeDir(p.join(p.dirname(home), '.thirdwheel')); // …/Users/.thirdwheel
      expect(await findProjectFolder(fs, folder, home, p)).toBeUndefined();
    });
  });
}

describe('lock', () => {
  const p = path.posix;
  let fs: MemoryFs;
  let files: ProjectFiles;
  const now = new Date(T);
  const alive = new Set<number>();
  const self = (pid: number, host = 'mac.local') => ({
    host,
    pid,
    isAlive: (x: number) => alive.has(x),
  });
  beforeEach(() => {
    fs = new MemoryFs(p);
    files = projectFiles('/p', p);
    alive.clear();
  });

  it('takes a free lock and releases it', async () => {
    expect(await acquireLock(fs, files, self(10), now)).toEqual({ kind: 'acquired' });
    expect(parseLock(fs.read(files.lock) ?? '')).toMatchObject({ host: 'mac.local', pid: 10 });
    await releaseLock(fs, files, self(10));
    expect(fs.read(files.lock)).toBeUndefined();
  });

  it('a second window on this computer gets busy; it never removes the first one’s lock', async () => {
    alive.add(10);
    await acquireLock(fs, files, self(10), now);
    expect(await acquireLock(fs, files, self(11), now)).toMatchObject({ kind: 'busy' });
    await releaseLock(fs, files, self(11));
    expect(fs.read(files.lock)).toBeDefined();
  });

  it('takes over a stale lock (the app crashed: its process is gone)', async () => {
    await acquireLock(fs, files, self(10), now);
    expect(await acquireLock(fs, files, self(11), now)).toEqual({
      kind: 'acquired',
      tookOver: 'stale',
    });
    expect(parseLock(fs.read(files.lock) ?? '')?.pid).toBe(11);
  });

  it('takes over a half-written lock file', async () => {
    fs.addFile(files.lock, '{"host": "mac');
    expect(await acquireLock(fs, files, self(11), now)).toEqual({
      kind: 'acquired',
      tookOver: 'broken',
    });
  });

  it('a lock from another computer (shared OneDrive folder) only warns, unless forced', async () => {
    await acquireLock(fs, files, self(10, 'DESKTOP-PC'), now);
    const r = await acquireLock(fs, files, self(10), now);
    expect(r).toMatchObject({ kind: 'other-host', lock: { host: 'DESKTOP-PC' } });
    expect(await acquireLock(fs, files, self(10), now, true)).toEqual({
      kind: 'acquired',
      tookOver: 'forced',
    });
  });

  it('a lock whose pid now belongs to another program (reboot) can be taken over with force', async () => {
    alive.add(10);
    await acquireLock(fs, files, self(10), now);
    expect(await acquireLock(fs, files, self(11), now)).toMatchObject({ kind: 'busy' });
    expect(await acquireLock(fs, files, self(11), now, true)).toEqual({
      kind: 'acquired',
      tookOver: 'forced',
    });
  });

  it('host names compare without case and without .local', async () => {
    await acquireLock(fs, files, self(10, 'MyMac.local'), now);
    expect(await acquireLock(fs, files, self(10, 'mymac'), now)).toEqual({ kind: 'acquired' });
  });

  it('two windows taking over the same stale lock: the one that loses is told busy', async () => {
    fs.addFile(files.lock, lockText({ host: 'mac.local', pid: 5, started: T }));
    // Window 12 writes its take-over right after ours (simulated by the rename hook).
    const realRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      await realRename(from, to);
      if (to === p.resolve(files.lock)) {
        alive.add(12);
        fs.files.set(to, lockText({ host: 'mac.local', pid: 12, started: T }));
      }
    };
    expect(await acquireLock(fs, files, self(11), now)).toMatchObject({
      kind: 'busy',
      lock: { pid: 12 },
    });
  });
});

describe('ids from a counter are deterministic (test helper)', () => {
  it('counterRandom gives different ids', async () => {
    const { newId } = await import('./project-paths.js');
    const r = counterRandom();
    expect(newId(r)).not.toBe(newId(r));
  });
});
