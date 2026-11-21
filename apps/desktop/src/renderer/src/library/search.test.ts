import { describe, expect, it } from 'vitest';
import catalogueText from './data/catalogue.json?raw';
import { parseCatalogue } from './catalogue.js';
import { describeOption, rankClasses, searchParts } from './search.js';

// The real shipped catalogue: what the tool answers from.
const catalogue = parseCatalogue(JSON.parse(catalogueText));
const names = (r: { hits: readonly { cls: string }[] }): string[] => r.hits.map((h) => h.cls);

describe('searchParts: query', () => {
  it('finds parts by English and Chinese words', () => {
    expect(names(searchParts(catalogue, { query: 'seal' }))).toContain('ORing');
    expect(names(searchParts(catalogue, { query: '螺絲' }))).toContain('SocketHeadCapScrew');
    expect(names(searchParts(catalogue, { query: '軸承' })).length).toBeGreaterThan(0);
  });

  it('ranks the part matching most words first and says when not all words match', () => {
    const r = searchParts(catalogue, { query: 'socket head screw' });
    expect(r.hits[0]?.cls).toBe('SocketHeadCapScrew');
    expect(r.hits[0]?.matched).toBe(3);
    expect(r.note).toBeUndefined();
    const partial = searchParts(catalogue, { query: 'screw waterproof' });
    expect(partial.total).toBeGreaterThan(0);
    expect(partial.note).toContain('No part matches all 2 words');
  });

  it('says what to do when nothing matches', () => {
    const r = searchParts(catalogue, { query: 'zzzzqqq' });
    expect(r.total).toBe(0);
    expect(r.hits).toEqual([]);
    expect(r.note).toContain('Nothing matched');
  });

  it('limits the hits but reports the total', () => {
    const r = searchParts(catalogue, { query: 'screw', limit: 3 });
    expect(r.hits).toHaveLength(3);
    expect(r.total).toBeGreaterThan(3);
  });

  it('gives the facts an AI needs to choose, with long lists shortened', () => {
    const screw = searchParts(catalogue, { query: 'SocketHeadCapScrew' }).hits[0];
    expect(screw).toMatchObject({
      cls: 'SocketHeadCapScrew',
      label: 'Socket Head Cap Screw',
      module: 'Fasteners',
      operation: false,
    });
    const size = screw?.options.find((o) => o.kind === 'size');
    expect(size?.count).toBeGreaterThanOrEqual(30); // the longest list of one standard
    expect(size?.examples).toHaveLength(5);
    expect(size).not.toHaveProperty('sizes'); // the full list comes with cls
    expect(screw?.options.find((o) => o.kind === 'flag')).toMatchObject({
      name: 'simple',
      on: 'No thread (simple)',
      off: 'With thread',
    });
    expect(screw?.options.find((o) => o.name === 'length')).toMatchObject({
      kind: 'number',
      unit: 'mm',
    });
    const bearing = searchParts(catalogue, { query: 'SingleRowDeepGrooveBallBearing' }).hits[0];
    expect(bearing?.exampleSize?.length).toBe(3);
    const op = searchParts(catalogue, { query: 'ClearanceHole' }).hits[0];
    expect(op?.operation).toBe(true);
  });
});

describe('searchParts: cls', () => {
  it('gives every buildable size of a class, by standard, without the ones the library cannot build', () => {
    const r = searchParts(catalogue, { cls: 'SocketHeadCapScrew' });
    expect(r.total).toBe(1);
    const size = r.hits[0]?.options.find((o) => o.kind === 'size');
    expect(size?.typeParam).toBe('fastener_type');
    const bySize = size?.sizes as Record<string, string[]>;
    expect(Object.keys(bySize).sort()).toEqual(['asme_b18.3', 'iso4762']);
    expect(bySize['asme_b18.3']).toContain('#3-48');
    expect(bySize['asme_b18.3']).not.toContain('#1-64'); // bd_warehouse 0.4.0 cannot build it
    expect(bySize['iso4762']).toContain('M5-0.8');
  });

  it('is case-insensitive and keeps sub-part names', () => {
    const r = searchParts(catalogue, { cls: 'singlerowcylindricalrollerbearing' });
    expect(r.hits[0]?.cls).toBe('SingleRowCylindricalRollerBearing');
    expect(Object.keys(r.hits[0]?.subparts ?? {}).length).toBeGreaterThan(0);
  });

  it('suggests similar classes for an unknown name', () => {
    expect(() => searchParts(catalogue, { cls: 'Screw' })).toThrow(
      /No class "Screw".*similar: .*Screw/,
    );
    expect(() => searchParts(catalogue, { cls: 'NoSuchThing' })).toThrow(/No class "NoSuchThing"/);
  });
});

describe('describeOption / rankClasses', () => {
  it('shortens only long choice lists', () => {
    const short = describeOption({ name: 'k', kind: 'choice', choices: ['a', 'b'] }, false);
    expect(short.choices).toEqual(['a', 'b']);
    const longChoices = Array.from({ length: 20 }, (_, i) => `v${String(i)}`);
    const long = describeOption({ name: 'k', kind: 'choice', choices: longChoices }, false);
    expect(long).toMatchObject({ count: 20 });
    expect(long.choices).toBeUndefined();
    expect(
      describeOption({ name: 'k', kind: 'choice', choices: longChoices }, true).choices,
    ).toHaveLength(20);
  });

  it('ranks by matched words then catalogue order', () => {
    const r = rankClasses(catalogue, 'nut');
    expect(r.length).toBeGreaterThan(3);
    expect(r.every((x) => x.matched === 1)).toBe(true);
  });
});
