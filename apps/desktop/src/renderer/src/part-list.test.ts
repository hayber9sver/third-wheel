import { describe, expect, it } from 'vitest';
import type { ProjectPartRow } from '../../shared/ipc.js';
import { partDetail, partRows, partTitle } from './part-list.js';

const hash = (c: string): string => `sha256:${c.repeat(64)}`;
const part = (name: string, more: Partial<ProjectPartRow> = {}): ProjectPartRow => ({
  partId: `p-${name}`,
  name,
  path: `/m/${name}_v2.step`,
  fileName: `${name}_v2.step`,
  contentHash: hash('a'),
  openComments: 0,
  shown: false,
  onDisk: hash('a'),
  ...more,
});

describe('Parts menu rows', () => {
  it('state from the shown part and the newest file on disk', () => {
    const rows = partRows([
      part('bracket', { shown: true }),
      part('lid'),
      part('hinge', { onDisk: hash('b') }),
      part('clip', { onDisk: null }),
    ]);
    expect(rows.map((r) => r.state)).toEqual(['shown', 'found', 'changed', 'missing']);
  });

  it('the shown part at an earlier version opens its newest; a missing newest stays shown', () => {
    const list = [part('bracket', { shown: true }), part('lid', { shown: true, onDisk: null })];
    const older = { path: '/m/bracket.step', contentHash: hash('z') };
    expect(partRows(list, older).map((r) => r.state)).toEqual(['shownOlder', 'shown']);
    expect(partRows(list, { path: '/m/bracket_v2.step', contentHash: hash('a') })[0]?.state).toBe(
      'shown',
    );
  });

  it('detail: newest file or why not, then open comments', () => {
    const [shown, found, changed, missing] = partRows([
      part('bracket', { shown: true, openComments: 2 }),
      part('lid'),
      part('hinge', { onDisk: hash('b'), openComments: 1 }),
      part('clip', { onDisk: null }),
    ]);
    if (!shown || !found || !changed || !missing) throw new Error('rows');
    expect(partDetail(shown)).toBe('bracket_v2.step · 2 open');
    expect(partDetail(found)).toBe('lid_v2.step');
    expect(partDetail(changed)).toBe('file changed since · 1 open');
    expect(partDetail(missing)).toBe('not found');
    expect(partTitle(missing)).toBe(
      '/m/clip_v2.step is not there any more (moved, renamed or deleted).',
    );
    expect(partTitle(changed)).toContain('1 open comment.');
    expect(partTitle(found)).toBe('Open its newest version: /m/lid_v2.step.');
  });
});
