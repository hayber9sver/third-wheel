import { describe, expect, it } from 'vitest';
import { Selection, selectionBodies, selectionSummary, type SelectionItem } from './selection.js';

const face3: SelectionItem = { kind: 'face', id: 3 };
const edge1: SelectionItem = { kind: 'edge', id: 1 };
const body0: SelectionItem = { kind: 'body', id: 0 };

describe('Selection', () => {
  it('toggle adds, toggling again removes; order is kept (multi-select by default)', () => {
    const s = new Selection();
    s.toggle(face3);
    s.toggle(edge1);
    s.toggle(body0);
    expect(s.list()).toEqual([face3, edge1, body0]);
    s.toggle(edge1);
    expect(s.list()).toEqual([face3, body0]);
  });

  it('two toggles of the same item cancel out (two slow clicks)', () => {
    const s = new Selection();
    s.toggle(edge1);
    s.toggle(face3);
    s.toggle(face3);
    expect(s.list()).toEqual([edge1]);
  });

  it('same kind+id is one item; a face and a body with the same id are different', () => {
    const s = new Selection();
    s.toggle({ kind: 'face', id: 0 });
    s.toggle(body0);
    expect(s.size).toBe(2);
    expect(s.has({ kind: 'face', id: 0 })).toBe(true);
    expect(s.has({ kind: 'vertex', id: 0 })).toBe(false);
  });

  it('reports changes only when something changed', () => {
    const s = new Selection();
    const calls: number[] = [];
    s.onChange = (items) => calls.push(items.length);
    s.toggle(face3);
    s.clear();
    s.clear(); // already empty
    s.removeAll([face3]); // not selected
    s.addAll([]);
    expect(calls).toEqual([1, 0]);
  });

  it('stores copies (a pick hit with extra fields is not kept)', () => {
    const s = new Selection();
    s.toggle({ kind: 'vertex', id: 2, body: 5 } as SelectionItem);
    expect(s.list()).toEqual([{ kind: 'vertex', id: 2 }]);
  });
});

describe('Selection.toggleAll / addAll / removeAll', () => {
  const b = (id: number): SelectionItem => ({ kind: 'body', id });

  it('toggleAll adds the missing items, or removes all when all are selected', () => {
    const s = new Selection();
    s.toggle(b(1));
    s.toggleAll([b(1), b(2)]);
    expect(s.list()).toEqual([b(1), b(2)]);
    s.toggle(face3);
    s.toggleAll([b(1), b(2)]);
    expect(s.list()).toEqual([face3]);
  });

  it('addAll keeps what is selected and adds only new items (left→right box, Shift range)', () => {
    const s = new Selection();
    const calls: number[] = [];
    s.onChange = (items) => calls.push(items.length);
    s.toggle(face3);
    s.addAll([b(1), face3]);
    s.addAll([b(1)]);
    expect(s.list()).toEqual([face3, b(1)]);
    expect(calls).toEqual([1, 2]);
  });

  it('removeAll removes only the given items (right→left box)', () => {
    const s = new Selection();
    s.addAll([face3, edge1, b(1)]);
    s.removeAll([edge1, b(2)]);
    expect(s.list()).toEqual([face3, b(1)]);
  });
});

describe('selectionSummary', () => {
  it('counts per kind', () => {
    expect(selectionSummary([])).toBe('');
    expect(selectionSummary([face3])).toBe('1 face selected');
    expect(
      selectionSummary([face3, { kind: 'face', id: 4 }, edge1, body0, { kind: 'body', id: 2 }]),
    ).toBe('2 bodies, 2 faces, 1 edge selected');
  });
});

describe('selectionBodies', () => {
  it('collects selected bodies and the bodies of selected entities', () => {
    const bodyOf = { face: [0, 0, 2], edge: [1, 2], vertex: [3] };
    const items = [
      { kind: 'face' as const, id: 2 },
      { kind: 'edge' as const, id: 0 },
      { kind: 'vertex' as const, id: 0 },
      { kind: 'body' as const, id: 5 },
      { kind: 'face' as const, id: 9 }, // unknown id: ignored
    ];
    expect([...selectionBodies(items, bodyOf)].sort()).toEqual([1, 2, 3, 5]);
    expect(selectionBodies([], bodyOf).size).toBe(0);
  });
});
