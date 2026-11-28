import { describe, expect, it } from 'vitest';
import { START_RECENT_ROWS, openedLabel, shortFolder, startPageView } from './start-page.js';

describe('openedLabel', () => {
  const now = new Date(2026, 10, 21, 15, 0);
  it('today, yesterday, then a short date (year only when not this year)', () => {
    expect(openedLabel(new Date(2026, 10, 21, 0, 5).toISOString(), now, 'en-GB')).toBe('Today');
    expect(openedLabel(new Date(2026, 10, 20, 23, 0).toISOString(), now, 'en-GB')).toBe(
      'Yesterday',
    );
    expect(openedLabel(new Date(2026, 10, 12).toISOString(), now, 'en-GB')).toBe('12 Nov');
    expect(openedLabel(new Date(2025, 0, 3).toISOString(), now, 'en-GB')).toBe('3 Jan 2025');
  });
  it('unknown or broken dates show nothing', () => {
    expect(openedLabel(undefined, now)).toBe('');
    expect(openedLabel('soon', now)).toBe('');
  });
  it('a date in the future (clock change) counts as today', () => {
    expect(openedLabel(new Date(2026, 10, 23).toISOString(), now)).toBe('Today');
  });
});

describe('startPageView', () => {
  const recent = Array.from({ length: START_RECENT_ROWS + 2 }, (_, i) => ({
    name: `p${String(i)}`,
    folder: `/x/p${String(i)}`,
    folderLabel: `~/p${String(i)}`,
  }));
  it('no project open: icon, welcome, New project folder, Open folder, recent projects', () => {
    const v = startPageView({ recent });
    expect(v.logo).toBe(true);
    expect(v.title).toBe('Third Wheel');
    expect(v.folder).toBeUndefined();
    expect(v.addModel).toBe(false);
    expect(v.newProject).toBe(true);
    expect(v.openLabel).toBe('Open folder…');
    expect(v.recent).toHaveLength(START_RECENT_ROWS);
  });
  it('an open project with no model: its name and folder, Add file…, Open another folder…, no recent list', () => {
    const v = startPageView({
      recent,
      project: { name: 'wheel', folder: '/x/wheel', exists: true },
    });
    expect(v.logo).toBe(false);
    expect(v.title).toBe('wheel');
    expect(v.folder).toBe('/x/wheel');
    expect(v.addModel).toBe(true);
    expect(v.newProject).toBe(false);
    expect(v.openLabel).toBe('Open another folder…');
    expect(v.recent).toEqual([]);
  });
});

describe('shortFolder', () => {
  it('keeps a short folder as it is', () => {
    expect(shortFolder('~/cad/bracket')).toBe('~/cad/bracket');
  });
  it('cuts the middle of a long one: its start and last folders stay', () => {
    const long = '~/Documents/clients/2026/acme-industries/prototypes/bracket-redesign';
    const out = shortFolder(long, 40);
    expect(out.startsWith('~/…/')).toBe(true);
    expect(out.endsWith('/prototypes/bracket-redesign')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
  });
  it('Windows folders: drive kept, backslashes', () => {
    expect(shortFolder('D:\\Work\\clients\\acme\\very-long-project-name\\bracket', 36)).toBe(
      'D:\\…\\very-long-project-name\\bracket',
    );
  });
  it('a last folder longer than the limit: start + last folder (CSS cuts the rest)', () => {
    const name = 'x'.repeat(70);
    expect(shortFolder(`/Volumes/disk/${name}`)).toBe(`/…/${name}`);
  });
});
