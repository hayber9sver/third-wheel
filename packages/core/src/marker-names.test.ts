import { describe, expect, it } from 'vitest';
import {
  copyMarkerName,
  isMarkerNameTaken,
  markerNameKey,
  otherMarkers,
  renamedMarkersText,
  uniqueMarkerNames,
} from './marker-names.js';
import type { Project } from './project-schema.js';
import { sampleProject } from './testing/fixtures.js';

function withMarkers(names: readonly string[]): Project {
  return {
    ...sampleProject(),
    markers: names.map((name, i) => ({
      id: `mk${String(i).padStart(8, '0')}`,
      name,
      color: '#ff8a1f',
      visible: true,
    })),
  };
}

describe('marker names', () => {
  it('compares names without case or extra spaces', () => {
    expect(markerNameKey('  Marker   2 ')).toBe('marker 2');
    expect(isMarkerNameTaken('marker 2', ['Marker 1', 'MARKER  2'])).toBe(true);
    expect(isMarkerNameTaken('Marker 3', ['Marker 1', 'Marker 2'])).toBe(false);
  });

  it('makes "(2)", "(3)" copies and keeps them within the name length', () => {
    expect(copyMarkerName('Hole', new Set(['hole']))).toBe('Hole (2)');
    expect(copyMarkerName('Hole', new Set(['hole', 'hole (2)']))).toBe('Hole (3)');
    const long = 'x'.repeat(60);
    const copy = copyMarkerName(long, new Set([long]));
    expect(copy).toHaveLength(60);
    expect(copy.endsWith(' (2)')).toBe(true);
  });

  it('renames later duplicates in an old project, first one keeps its name', () => {
    const p = withMarkers(['Marker 1', 'Marker 2', 'marker 1', 'Marker 1', 'Marker 1 (2)']);
    const r = uniqueMarkerNames(p);
    expect(r.project.markers.map((m) => m.name)).toEqual([
      'Marker 1',
      'Marker 2',
      'marker 1 (3)',
      'Marker 1 (4)',
      'Marker 1 (2)',
    ]);
    expect(r.renamed).toEqual([
      { from: 'marker 1', to: 'marker 1 (3)' },
      { from: 'Marker 1', to: 'Marker 1 (4)' },
    ]);
    expect(r.project.markers.map((m) => m.id)).toEqual(p.markers.map((m) => m.id));
  });

  it('leaves a project with unique names as it is', () => {
    const p = withMarkers(['Marker 1', 'Marker 2']);
    expect(uniqueMarkerNames(p).project).toBe(p);
    expect(uniqueMarkerNames(p).renamed).toEqual([]);
  });

  it('says what was renamed', () => {
    expect(renamedMarkersText([{ from: 'A', to: 'A (2)' }])).toMatch(
      /^1 marker was renamed .*"A" → "A \(2\)"\.$/,
    );
    const four = ['A', 'B', 'C', 'D'].map((n) => ({ from: n, to: `${n} (2)` }));
    expect(renamedMarkersText(four)).toMatch(/^4 markers were renamed .*, …\.$/);
  });
});

describe('otherMarkers', () => {
  it('lists the names of markers the window does not show', () => {
    const p = withMarkers(['A', 'B', 'C']);
    expect(otherMarkers(p, [{ id: 'mk00000001' }])).toEqual([
      { id: 'mk00000000', name: 'A' },
      { id: 'mk00000002', name: 'C' },
    ]);
  });
});
