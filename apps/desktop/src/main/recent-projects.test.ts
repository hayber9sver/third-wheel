import { describe, expect, it } from 'vitest';
import { MAX_RECENT, addRecent, folderLabel, parseRecent, recentLabel } from './recent-projects.js';

const r = (n: number) => ({
  folder: `/p/${String(n)}`,
  name: `p${String(n)}`,
  model: `/p/${String(n)}/a.step`,
});

describe('recent projects', () => {
  it('newest first, a folder once, at most 10', () => {
    let list = [r(1), r(2)];
    list = addRecent(list, { ...r(2), model: '/p/2/b.step' });
    expect(list.map((x) => x.folder)).toEqual(['/p/2', '/p/1']);
    expect(list[0]?.model).toBe('/p/2/b.step');
    for (let i = 3; i < 20; i++) list = addRecent(list, r(i));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]?.folder).toBe('/p/19');
  });

  it('a broken or hand-edited file gives what is usable', () => {
    expect(parseRecent('{ nope')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent(JSON.stringify([r(1), { folder: 3 }, r(1), null, r(2)]))).toEqual([
      r(1),
      r(2),
    ]);
  });

  it('label: name and folder, home shortened', () => {
    expect(
      recentLabel({ folder: '/Users/me/cad/wheel', name: 'wheel', model: '' }, '/Users/me'),
    ).toBe('wheel — ~/cad/wheel');
    expect(
      recentLabel({ folder: 'D:\\cad\\wheel', name: 'wheel', model: '' }, 'C:\\Users\\me'),
    ).toBe('wheel — D:\\cad\\wheel');
  });

  it('keeps when a project was opened; ~ only for the home folder itself or under it', () => {
    expect(
      parseRecent(JSON.stringify([{ folder: '/a', name: 'a', model: '', opened: '2026-11-21' }])),
    ).toEqual([{ folder: '/a', name: 'a', model: '', opened: '2026-11-21' }]);
    expect(
      parseRecent(JSON.stringify([{ folder: '/a', name: 'a', model: '', opened: 3 }])),
    ).toEqual([{ folder: '/a', name: 'a', model: '' }]);
    expect(folderLabel('/Users/me/cad', '/Users/me')).toBe('~/cad');
    expect(folderLabel('/Users/me', '/Users/me')).toBe('~');
    expect(folderLabel('/Users/me2/cad', '/Users/me')).toBe('/Users/me2/cad');
    expect(folderLabel('C:\\Users\\me\\cad', 'C:\\Users\\me')).toBe('~\\cad');
  });
});
