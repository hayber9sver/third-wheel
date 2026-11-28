import { describe, expect, it } from 'vitest';
import type { ProjectVersionRow } from '../../shared/ipc.js';
import { addFileQuestion, versionDetail, versionLabel, versionRows } from './version-list.js';

const hash = (c: string): string => `sha256:${c.repeat(64)}`;
const row = (
  name: string,
  c: string,
  more: Partial<ProjectVersionRow> = {},
): ProjectVersionRow => ({
  id: `v-${name}`,
  path: `/m/${name}`,
  name,
  contentHash: hash(c),
  added: '2026-11-09T14:02:00.000Z',
  shown: false,
  onDisk: hash(c),
  ...more,
});

describe('versionRows', () => {
  it('keeps the project order (newest first) and ticks the shown version', () => {
    const rows = versionRows([
      row('final.step', 'd'),
      row('widget8.step', 'c', { shown: true }),
      row('first.step', 'a'),
    ]);
    expect(rows.map((r) => [r.name, r.state, r.id])).toEqual([
      ['final.step', 'found', 'v-final.step'],
      ['widget8.step', 'shown', 'v-widget8.step'],
      ['first.step', 'found', 'v-first.step'],
    ]);
  });

  it('tells missing, changed and overwritten files apart', () => {
    const rows = versionRows([
      row('widget8.step', 'e', { shown: true }),
      row('widget8.step', 'b', { overwritten: true, onDisk: hash('e') }),
      row('moved.step', 'c', { onDisk: null }),
      row('replaced.step', 'd', { onDisk: hash('f') }),
    ]);
    expect(rows.map((r) => r.state)).toEqual(['shown', 'overwritten', 'missing', 'changed']);
    expect(rows.map((r) => versionDetail(r))).toEqual([
      'shown',
      'overwritten',
      'not found',
      'file changed since',
    ]);
    expect(rows[1] && versionLabel(rows[1])).toBe('earlier contents of widget8.step');
  });

  it('shows the date added for a found version', () => {
    const [r] = versionRows([row('a.step', 'a')]);
    expect(r && versionDetail(r, 'en-GB')).toMatch(/9 Nov/);
    const [bad] = versionRows([row('b.step', 'b', { added: 'not a date' })]);
    expect(bad && versionDetail(bad)).toBe('');
  });
});

describe('addFileQuestion', () => {
  const step = { fromMesh: false, fileIsMesh: false };
  it('STEP onto STEP: markers move over; the name hint only for matching names', () => {
    expect(addFileQuestion('bracket_v2.step', 'bracket.step', { ...step, sameName: true })).toBe(
      'Is it a new version of bracket.step (its markers and comments move over) or a separate part of this project? Its name looks like a version of bracket.step.',
    );
    expect(addFileQuestion('lid.step', 'bracket.step', { ...step, sameName: false })).not.toContain(
      'looks like',
    );
  });
  it('STEP onto a mesh: paint moves onto the STEP faces; no name hint when the names differ', () => {
    const text = addFileQuestion('cover-import.step', 'cover.stl', {
      fromMesh: true,
      fileIsMesh: false,
      sameName: false,
    });
    expect(text).toContain('its paint and comments move onto the faces of cover-import.step');
    expect(text).not.toContain('looks like');
  });
  it('a mesh onto a mesh: the general wording (it is refused as a version later)', () => {
    expect(
      addFileQuestion('b.stl', 'a.stl', { fromMesh: true, fileIsMesh: true, sameName: false }),
    ).toContain('its markers and comments move over');
  });
});
