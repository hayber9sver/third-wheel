import { describe, expect, it } from 'vitest';
import { UndoHistory, type UndoStep } from './undo.js';

/** A counter step: redo adds `by`, undo subtracts it. */
function counter(): { value: number; step: (by: number, label?: string) => UndoStep } {
  const c = {
    value: 0,
    step: (by: number, label = `+${String(by)}`): UndoStep => {
      c.value += by;
      return {
        label,
        undo: () => (c.value -= by),
        redo: () => (c.value += by),
      };
    },
  };
  return c;
}

describe('UndoHistory', () => {
  it('undoes and redoes in order, with labels', () => {
    const h = new UndoHistory();
    const c = counter();
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBeUndefined();
    h.push(c.step(1, 'one'));
    h.push(c.step(10, 'ten'));
    expect(h.undoLabel()).toBe('ten');
    expect(h.undo()).toBe('ten');
    expect(c.value).toBe(1);
    expect(h.redoLabel()).toBe('ten');
    expect(h.undo()).toBe('one');
    expect(c.value).toBe(0);
    expect(h.canUndo()).toBe(false);
    expect(h.redo()).toBe('one');
    expect(h.redo()).toBe('ten');
    expect(c.value).toBe(11);
    expect(h.canRedo()).toBe(false);
  });

  it('a new step forgets the redo steps', () => {
    const h = new UndoHistory();
    const c = counter();
    h.push(c.step(1));
    h.push(c.step(2));
    h.undo();
    h.push(c.step(5));
    expect(h.canRedo()).toBe(false);
    h.undo();
    h.undo();
    expect(c.value).toBe(0);
  });

  it('keeps at most `limit` steps (drops the oldest)', () => {
    const h = new UndoHistory(3);
    const c = counter();
    for (let i = 1; i <= 5; i++) h.push(c.step(i));
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(3);
    expect(c.value).toBe(1 + 2); // steps 1 and 2 stay done
  });

  it('merges steps with the same key pushed close together', () => {
    let now = 0;
    const h = new UndoHistory(100, () => now, 1000);
    const c = counter();
    h.push(c.step(1), { mergeKey: 'k' });
    now = 500;
    h.push(c.step(2), { mergeKey: 'k' });
    now = 900;
    h.push(c.step(3, 'last'), { mergeKey: 'k' });
    now = 3000; // too late → own step
    h.push(c.step(4), { mergeKey: 'k' });
    now = 3100;
    h.push(c.step(5), { mergeKey: 'other' });
    expect(h.undo()).toBe('+5');
    expect(h.undo()).toBe('+4');
    expect(h.undoLabel()).toBe('last');
    // The merged step undoes only the first change; its redo re-applies only the last — fine for
    // state-setting steps (colour), which is what merging is for.
    h.undo();
    expect(h.canUndo()).toBe(false);
  });

  it('a step that was undone and redone never merges', () => {
    let now = 0;
    const h = new UndoHistory(100, () => now, 1000);
    const c = counter();
    h.push(c.step(1), { mergeKey: 'k' });
    h.undo();
    h.redo();
    now = 10;
    h.push(c.step(2), { mergeKey: 'k' });
    h.undo();
    expect(h.canUndo()).toBe(true);
  });

  it('clear empties both stacks and reports the change', () => {
    const h = new UndoHistory();
    let changes = 0;
    h.onChange = () => changes++;
    const c = counter();
    h.push(c.step(1));
    h.push(c.step(1));
    h.undo();
    h.clear();
    expect(h.canUndo() || h.canRedo()).toBe(false);
    expect(changes).toBe(4);
    h.clear();
    expect(changes).toBe(4);
  });

  it('group makes the steps pushed inside one step; empty groups record nothing', () => {
    const h = new UndoHistory();
    const c = counter();
    h.group('Both', () => {
      h.push(c.step(1));
      h.group('inner', () => {
        h.push(c.step(10));
      });
    });
    h.group('Nothing', () => undefined);
    expect(c.value).toBe(11);
    expect(h.undoLabel()).toBe('Both');
    h.undo();
    expect(c.value).toBe(0);
    expect(h.canUndo()).toBe(false);
    h.redo();
    expect(c.value).toBe(11);
  });
});
