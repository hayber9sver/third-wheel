import { describe, expect, it } from 'vitest';
import { DialogQuestion, type QuestionDialog } from './dialog-question.js';

/** A dialog whose "close" events wait until `fireClose` (the browser fires them in a later task). */
function fakeDialog(): QuestionDialog & { fireClose(): void; answer(v: string): void } {
  const listeners: (() => void)[] = [];
  let queued = 0;
  const d = {
    open: false,
    returnValue: '',
    showModal() {
      d.open = true;
    },
    close(v?: string) {
      if (!d.open) return;
      d.open = false;
      if (v !== undefined) d.returnValue = v;
      queued++;
    },
    addEventListener(_type: 'close', l: () => void) {
      listeners.push(l);
    },
    fireClose() {
      for (; queued > 0; queued--) for (const l of listeners) l();
    },
    answer(v: string) {
      d.close(v);
    },
  };
  return d;
}

describe('DialogQuestion', () => {
  it('resolves with the button pressed', async () => {
    const d = fakeDialog();
    const q = new DialogQuestion(d);
    const a = q.ask(() => undefined);
    d.answer('first');
    d.fireClose();
    expect(await a).toBe('first');
  });

  it("a new question opened before the earlier one's close event keeps its own answer", async () => {
    const d = fakeDialog();
    const q = new DialogQuestion(d);
    const one = q.ask(() => undefined);
    d.answer('second'); // closed; its close event not fired yet
    const two = q.ask(() => undefined);
    d.fireClose(); // the late close of question one: skipped, two is open
    expect(d.open).toBe(true);
    expect(await one).toBe('second');
    d.answer('first');
    d.fireClose();
    expect(await two).toBe('first');
  });

  it('asking while one is open closes it without an answer', async () => {
    const d = fakeDialog();
    const q = new DialogQuestion(d);
    const one = q.ask(() => undefined);
    const two = q.ask(() => undefined);
    d.fireClose();
    expect(await one).toBe('');
    d.answer('');
    d.fireClose();
    expect(await two).toBe('');
  });
});
