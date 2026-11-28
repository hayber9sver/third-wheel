import { describe, expect, it } from 'vitest';
import {
  isEarlierVersionName,
  earlierVersions,
  nextVersionName,
  sameBodyNames,
  sameModelName,
  sameOverallSize,
  differentPartReason,
  versionName,
} from './versions.js';

describe('versionName', () => {
  it.each([
    ['part.step', 'part', 0],
    ['part_v2.step', 'part', 2],
    ['Part-V3.STP', 'part', 3],
    ['part-rev3.step', 'part', 3],
    ['part rev 4.step', 'part', 4],
    ['part_r5.step', 'part', 5],
    ['part (2).step', 'part', 2],
    ['part copy.step', 'part', 1],
    ['part copy 3.step', 'part', 3],
    ['part - Copy.step', 'part', 1],
    ['motor2.step', 'motor2', 0],
    ['gear_20.step', 'gear_20', 0],
    ['v2.step', 'v2', 0],
  ])('%s → %s, %d', (name, stem, version) => {
    expect(versionName(name)).toEqual({ stem, version });
  });

  it('orders a copy of v2 between v2 and v3', () => {
    const v = (n: string): number => versionName(n).version;
    expect(v('part_v2 (1).step')).toBeGreaterThan(v('part_v2.step'));
    expect(v('part_v2 (1).step')).toBeLessThan(v('part_v3.step'));
  });
});

describe('version names', () => {
  it('same model, earlier version', () => {
    expect(sameModelName('part.step', 'part_v2.step')).toBe(true);
    expect(sameModelName('part.step', 'part.step')).toBe(false);
    expect(sameModelName('lid.step', 'box_v2.step')).toBe(false);
    expect(isEarlierVersionName('part.step', 'part_v2.step')).toBe(true);
    expect(isEarlierVersionName('part_v1.step', 'part_v2.step')).toBe(true);
    expect(isEarlierVersionName('part_v3.step', 'part_v2.step')).toBe(false);
    expect(isEarlierVersionName('part_v2.step', 'part_v2.stp')).toBe(false);
  });

  it('next export name', () => {
    expect(nextVersionName('part.step')).toBe('part_v2.step');
    expect(nextVersionName('part_v2.step')).toBe('part_v3.step');
    expect(nextVersionName('part-rev09.stp')).toBe('part-rev10.stp');
    expect(nextVersionName('part (2).step')).toBe('part (3).step');
    expect(nextVersionName('motor2.step')).toBe('motor2_v2.step');
  });

  it('body names: same named set, not generic ones', () => {
    expect(sameBodyNames(['Bracket', 'Pin'], ['pin', 'Bracket'])).toBe(true);
    expect(sameBodyNames(['Bracket', 'Pin'], ['Bracket'])).toBe(false);
    expect(sameBodyNames(['Body 1'], ['Body 1'])).toBe(false);
    expect(sameBodyNames(['Solid1', 'Solid2'], ['Solid1', 'Solid2'])).toBe(false);
  });
});

describe('earlierVersions', () => {
  const file = { path: '/d/part_v3.step', name: 'part_v3.step', bodyNames: ['Bracket'] };
  it('takes the highest earlier version, then the newest sidecar', () => {
    const [got] = earlierVersions(file, [
      { path: '/d/part.step', name: 'part.step', sidecarMtimeMs: 9 },
      { path: '/d/part_v2.step', name: 'part_v2.step', sidecarMtimeMs: 1 },
      { path: '/d/part_v4.step', name: 'part_v4.step', sidecarMtimeMs: 10 },
      { path: '/d/part_v3.step', name: 'part_v3.step', sidecarMtimeMs: 10 },
    ]);
    expect(got?.name).toBe('part_v2.step');
  });
  it('finds a renamed file of this session by its body names', () => {
    const [got] = earlierVersions(file, [
      {
        path: '/e/holder.step',
        name: 'holder.step',
        session: { bodyNames: ['Bracket'], order: 1 },
      },
      { path: '/e/other.step', name: 'other.step', session: { bodyNames: ['Pin'], order: 2 } },
    ]);
    expect(got?.name).toBe('holder.step');
  });
  it('body names only when no file shares the name', () => {
    expect(
      earlierVersions({ ...file, name: 'part_v0.step', path: '/d/part_v0.step' }, [
        { path: '/d/part_v2.step', name: 'part_v2.step', sidecarMtimeMs: 1 },
        {
          path: '/e/holder.step',
          name: 'holder.step',
          session: { bodyNames: ['Bracket'], order: 1 },
        },
      ]),
    ).toEqual([]);
  });
  it('nothing fits → none (a later version is never offered)', () => {
    expect(
      earlierVersions(file, [
        { path: '/d/lid.step', name: 'lid.step' },
        {
          path: '/d/part_v4.step',
          name: 'part_v4.step',
          session: { bodyNames: ['Bracket'], order: 1 },
        },
      ]),
    ).toEqual([]);
  });
});

describe('sameOverallSize', () => {
  const box = (size: number[], centre = [0, 0, 0]) => ({ size, centre });
  it('matches a turned, moved export of the same part (sides sorted)', () => {
    // A printed part: STL Y-up vs STEP.
    expect(
      sameOverallSize(
        [box([58.0741, 98.5595, 36.54], [78, 89, 67])],
        [box([58.0741, 36.34, 98.5595], [-58, 104, 190])],
      ),
    ).toBe(true);
  });
  it('uses the box around all bodies', () => {
    const two = [box([10, 10, 10], [0, 0, 0]), box([10, 10, 10], [30, 0, 0])];
    expect(sameOverallSize(two, [box([40, 10, 10])])).toBe(true);
    expect(sameOverallSize(two, [box([10, 10, 10])])).toBe(false);
  });
  it('refuses other sizes and empty lists', () => {
    expect(sameOverallSize([box([50, 20, 10])], [box([50, 20, 12])])).toBe(false);
    expect(sameOverallSize([], [box([1, 1, 1])])).toBe(false);
  });
});

describe('differentPartReason', () => {
  const box = (size: number[], centre = [0, 0, 0]) => ({ size, centre });
  const bracket = [box([40, 20, 10])];
  it('says nothing for an edited version of the same part', () => {
    expect(differentPartReason(bracket, [box([44, 20, 9])], { held: 4, lost: 1 })).toBeUndefined();
    // Turned 90° on export: same sorted sides.
    expect(differentPartReason(bracket, [box([20, 10, 40])], { held: 0, lost: 0 })).toBeUndefined();
  });
  it('names a very different size, sides as they are', () => {
    expect(differentPartReason(bracket, [box([120, 80, 5.25])], { held: 0, lost: 0 })).toBe(
      'size 40 × 20 × 10 mm → 120 × 80 × 5.3 mm',
    );
  });
  it('names most markers lost (at least two)', () => {
    expect(differentPartReason(bracket, bracket, { held: 8, lost: 6 })).toBe('6 of 8 markers lost');
    expect(differentPartReason(bracket, bracket, { held: 2, lost: 1 })).toBeUndefined();
    expect(differentPartReason(bracket, bracket, { held: 1, lost: 1 })).toBeUndefined();
  });
  it('gives both signs; no earlier box = markers only', () => {
    expect(differentPartReason(bracket, [box([200, 20, 10])], { held: 3, lost: 3 })).toBe(
      '3 of 3 markers lost; size 40 × 20 × 10 mm → 200 × 20 × 10 mm',
    );
    expect(
      differentPartReason(undefined, [box([200, 20, 10])], { held: 3, lost: 0 }),
    ).toBeUndefined();
  });
});
