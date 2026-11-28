import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewRequests, type ReviewModel } from './review-request.js';

const model = (modelId: string, name = `${modelId}.step`): ReviewModel => ({
  modelId,
  name,
  path: `/parts/${name}`,
});
const abc = model('abc');

describe('ReviewRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a waiting long-poll when the user sends', async () => {
    const r = new ReviewRequests();
    const shown: (string | undefined)[] = [];
    r.onChange = (open) => shown.push(open?.message);
    const req = r.request([abc], ' Check the hole ');
    expect(req.message).toBe('Check the hole');
    const wait = r.wait(req.id, 60_000);
    r.send([{ modelId: 'abc', name: 'abc.step', openComments: 3 }]);
    await expect(wait).resolves.toEqual({
      reviewId: req.id,
      state: 'sent',
      modelId: 'abc',
      openComments: 3,
    });
    expect(shown).toEqual(['Check the hole', undefined]);
    expect(r.open()).toBeUndefined();
  });

  it('answers waiting after the timeout, sent when asked later', async () => {
    const r = new ReviewRequests();
    const req = r.request([abc]);
    expect(req.message).toBeUndefined();
    const wait = r.wait(req.id, 1000);
    vi.advanceTimersByTime(1000);
    await expect(wait).resolves.toMatchObject({ state: 'waiting' });
    r.send([{ modelId: 'abc', name: 'abc.step', openComments: 0 }]);
    await expect(r.wait(req.id, 1000)).resolves.toMatchObject({ state: 'sent', openComments: 0 });
  });

  it('cancels the old request when a new one comes, and on dismiss', async () => {
    const r = new ReviewRequests();
    const first = r.request([abc]);
    const wait = r.wait(first.id, 60_000);
    const second = r.request([abc], 'again');
    expect(second.id).not.toBe(first.id);
    await expect(wait).resolves.toMatchObject({ state: 'cancelled', reason: /Replaced/ });
    r.cancel('Dismissed');
    await expect(r.wait(second.id, 10)).resolves.toMatchObject({
      state: 'cancelled',
      reason: 'Dismissed',
    });
  });

  it('covers several models; Send answers with the total and a count per model', async () => {
    const r = new ReviewRequests();
    const req = r.request([abc, model('def'), abc], 'Two parts');
    expect(req.models.map((m) => m.modelId)).toEqual(['abc', 'def']);
    expect(r.covers('def')).toBe(true);
    expect(r.covers('xyz')).toBe(false);
    const wait = r.wait(req.id, 60_000);
    r.send([
      { modelId: 'abc', name: 'abc.step', openComments: 2 },
      { modelId: 'def', name: 'def.step', openComments: 1 },
    ]);
    await expect(wait).resolves.toEqual({
      reviewId: req.id,
      state: 'sent',
      modelId: 'abc',
      openComments: 3,
      models: [
        { modelId: 'abc', name: 'abc.step', openComments: 2 },
        { modelId: 'def', name: 'def.step', openComments: 1 },
      ],
    });
    expect(r.covers('abc')).toBe(false);
  });

  it('rejects unknown review ids', async () => {
    const r = new ReviewRequests();
    await expect(r.wait('nope', 10)).rejects.toThrow(/Unknown review/);
  });
});
