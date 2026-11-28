import { describe, expect, it } from 'vitest';
import { formatJson } from './format-json.js';
import { sampleMarks, sampleProject, must } from './testing/fixtures.js';
import {
  chatLine,
  isFileId,
  parseChatLog,
  parseProject,
  parseProjectJson,
  parseVersionMarks,
} from './project-schema.js';

const errorsOf = (r: { ok: boolean; errors?: readonly string[] }): string =>
  (r.errors ?? []).join('\n');

describe('project.json', () => {
  it('accepts a valid project', () => {
    expect(parseProject(sampleProject()).ok).toBe(true);
  });

  it('keeps unknown fields at every level through a save and a read', () => {
    const p = sampleProject();
    Object.assign(p, { futureTop: { a: 1 } });
    Object.assign(must(p.models[0]), { futurePart: 'x' });
    Object.assign(must(must(p.models[0]).versions[1]), { futureVersion: [1, 2] });
    Object.assign(must(p.comments[0]), { futureComment: true });
    Object.assign(must(p.markers[0]), { futureMarker: 'y' });
    const r = parseProject(JSON.parse(JSON.stringify(p)));
    if (!r.ok) throw new Error(errorsOf(r));
    const again = parseProjectJson(formatJson(r.data));
    if (!again.ok) throw new Error(errorsOf(again));
    expect(again.data).toEqual(p);
    expect(again.data).toMatchObject({ futureTop: { a: 1 } });
  });

  it('refuses a newer schemaVersion as "newer" (never as broken)', () => {
    const r = parseProject({ ...sampleProject(), schemaVersion: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('newer');
      expect(r.errors[0]).toMatch(/please update/);
    }
  });

  it('refuses a v1 sidecar given as a project', () => {
    const r = parseProject({ schemaVersion: 1, model: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('reads JSON with a BOM and Windows line endings', () => {
    const text = `\uFEFF${formatJson(sampleProject()).replace(/\n/g, '\r\n')}`;
    expect(parseProjectJson(text).ok).toBe(true);
  });

  it('reports a syntax error as a readable line, not a throw', () => {
    const r = parseProjectJson('{"schemaVersion": 2,');
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toMatch(/not valid JSON/);
  });

  it.each([
    ['backslashes', 'exports\\bracket.step'],
    ['absolute POSIX path without outside', '/Users/me/bracket.step'],
    ['absolute Windows path without outside', 'C:/work/bracket.step'],
    ['empty part', 'exports//bracket.step'],
    ['"." part', './bracket.step'],
  ])('refuses a version path with %s', (_what, path) => {
    const p = sampleProject();
    (must(p.models[0]).versions[0] as { path: string }).path = path;
    expect(errorsOf(parseProject(p))).toMatch(/relative to the project folder/);
  });

  it('accepts outside paths only when absolute', () => {
    const p = sampleProject();
    Object.assign(must(must(p.models[0]).versions[0]), {
      path: 'D:\\exports\\b.step',
      outside: true,
    });
    expect(parseProject(p).ok).toBe(true);
    Object.assign(must(must(p.models[0]).versions[0]), { path: 'exports/b.step', outside: true });
    expect(errorsOf(parseProject(p))).toMatch(/outside path must be absolute/);
  });

  it.each(['CON', 'con', 'nul', 'com1', 'lpt9', 'ab.c', '../x', 'a b', '', 'x'.repeat(33)])(
    'refuses %j as a version id (it becomes a file name)',
    (id) => {
      const p = sampleProject();
      (must(p.models[0]).versions[0] as { id: string }).id = id;
      must(must(p.models[0]).versions[1]).from = id;
      expect(parseProject(p).ok).toBe(false);
    },
  );

  it('refuses a version made from a version of another part, itself, or in a circle', () => {
    const p = sampleProject();
    must(must(p.models[0]).versions[1]).from = 'nope000001';
    expect(errorsOf(parseProject(p))).toMatch(/not another version of this part/);
    must(must(p.models[0]).versions[1]).from = 'ver0000002';
    expect(errorsOf(parseProject(p))).toMatch(/not another version/);
    must(must(p.models[0]).versions[1]).from = 'ver0000001';
    must(must(p.models[0]).versions[0]).from = 'ver0000002';
    expect(errorsOf(parseProject(p))).toMatch(/circle/);
  });

  it('refuses the same version id in two parts (their marks files would collide)', () => {
    const p = sampleProject();
    p.models.push({
      id: 'part000002',
      name: 'lid',
      versions: [{ ...must(must(p.models[0]).versions[0]) }],
    });
    expect(errorsOf(parseProject(p))).toMatch(/duplicate version id/);
  });

  it('refuses comments on unknown parts or markers', () => {
    const p = sampleProject();
    must(p.comments[0]).modelId = 'part000009';
    must(p.comments[0]).markerIds = ['m9'];
    const e = errorsOf(parseProject(p));
    expect(e).toMatch(/unknown part/);
    expect(e).toMatch(/unknown marker "m9"/);
  });

  it('drops a malformed meshHash or bodyTree, never the project', () => {
    const p = sampleProject();
    Object.assign(must(must(p.models[0]).versions[0]), { meshHash: 'md5:1' });
    Object.assign(must(p.models[0]), { bodyTree: { folders: 'broken' } });
    const r = parseProject(p);
    if (!r.ok) throw new Error(errorsOf(r));
    expect(must(must(r.data.models[0]).versions[0]).meshHash).toBeUndefined();
    expect(must(r.data.models[0]).bodyTree).toBeUndefined();
  });
});

describe('marks file', () => {
  it('accepts valid marks and keeps unknown fields in paint', () => {
    const m = sampleMarks() as unknown as { markers: { paint: { faces: object[] } }[] };
    Object.assign(must(must(m.markers[0]).paint.faces[0]), { futureFace: 1 });
    const r = parseVersionMarks(m);
    if (!r.ok) throw new Error(errorsOf(r));
    expect((must(r.data.markers[0]).paint.faces[0] as Record<string, unknown>).futureFace).toBe(1);
  });

  it('refuses a triangle painted by two markers (same rule as v1)', () => {
    const m = sampleMarks();
    m.markers.push({
      id: 'm2',
      entities: [],
      paint: { faces: [{ faceId: 3, triangles: [[12, 1]] }] },
    });
    expect(errorsOf(parseVersionMarks(m))).toMatch(/already painted by marker "m1"/);
  });

  it('refuses the same marker twice', () => {
    const m = sampleMarks();
    m.markers.push({ ...must(m.markers[0]), paint: { faces: [] }, entities: [] });
    expect(errorsOf(parseVersionMarks(m))).toMatch(/duplicate marker id/);
  });
});

const T = '2026-11-21T10:00:00.000Z';

describe('chat log', () => {
  const entry = (seq: number, text = 'hi'): string => chatLine({ seq, kind: 'user', text, at: T });

  it('reads Windows line endings and blank lines', () => {
    const text = `${entry(1)}\r\n\r\n${entry(2)}`.replace(/\n/g, '\r\n');
    const r = parseChatLog(text);
    expect(r.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(r.badLines).toEqual([]);
  });

  it('skips a half-written last line (crash while appending) and keeps the rest', () => {
    const text = `${entry(1)}${entry(2)}{"seq":3,"kind":"us`;
    const r = parseChatLog(text);
    expect(r.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(r.badLines).toEqual([3]);
  });

  it('keeps a message with line breaks on one line', () => {
    const line = entry(1, 'two\nlines\r\nand "quotes"');
    expect(line.split('\n')).toHaveLength(2); // the line + the final break
    expect(must(parseChatLog(line).entries[0]).text).toBe('two\nlines\r\nand "quotes"');
  });

  it('keeps kinds and fields from a newer app', () => {
    const r = parseChatLog(`{"seq":1,"kind":"voice","text":"","at":"${T}","audio":"x"}\n`);
    expect(r.entries[0]).toMatchObject({ kind: 'voice', audio: 'x' });
  });

  it('refuses to write a broken entry', () => {
    expect(() => chatLine({ seq: -1, kind: 'user', text: '', at: T })).toThrow();
  });
});

describe('isFileId', () => {
  it('allows lower-case a-z0-9 only and no Windows device names', () => {
    expect(isFileId('k3f9x2a1qz')).toBe(true);
    expect(isFileId('console')).toBe(true);
    for (const bad of ['con', 'aux', 'Abc', 'a_b', 'a.', 'a ', 'é'])
      expect(isFileId(bad)).toBe(false);
  });
});
