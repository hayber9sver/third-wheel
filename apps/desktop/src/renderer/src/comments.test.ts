import { MAX_LINKED_MODELS, type PartItemData } from '@third-wheel/core';
import { describe, expect, it } from 'vitest';
import { counterIds } from './markers.js';
import {
  cleanCommentText,
  Comments,
  commentsOnMarkers,
  liveMarkerIds,
  nextCommentMarkerName,
  resolvedMarkerIds,
  shownComments,
  type CommentEdit,
} from './comments.js';

function clock(): () => Date {
  let t = Date.UTC(2026, 10, 8, 12, 0, 0);
  return () => new Date((t += 1000));
}

describe('cleanCommentText', () => {
  it('trims the ends, keeps line breaks inside, rejects empty', () => {
    expect(cleanCommentText('  hole too small \n')).toBe('hole too small');
    expect(cleanCommentText('a\n\nb')).toBe('a\n\nb');
    expect(cleanCommentText('   \n ')).toBeUndefined();
  });
});

describe('nextCommentMarkerName', () => {
  it('counts above the highest "Comment N"', () => {
    expect(nextCommentMarkerName([])).toBe('Comment 1');
    expect(nextCommentMarkerName(['Marker 1', 'Comment 2', 'Comment 7x'])).toBe('Comment 3');
  });
});

describe('Comments', () => {
  it('adds open human comments with ids, times and unique markers', () => {
    const c = new Comments(clock(), counterIds('c'));
    const a = c.add(' Fillet this ', ['m1', 'm2', 'm1']);
    expect(a).toMatchObject({ id: 'c1', text: 'Fillet this', markerIds: ['m1', 'm2'] });
    expect(a).toMatchObject({ status: 'open', author: 'human' });
    expect(a?.createdAt).toBe(a?.updatedAt);
    expect(c.add('  ', ['m1'])).toBeUndefined();
    expect(c.add('AI says hi', [], 'ai')?.author).toBe('ai');
    expect(c.list().map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(c.numberOf('c2')).toBe(2);
    expect(c.numberOf('nope')).toBe(0);
  });

  it('edits text and markers; no-op edits change nothing', () => {
    const c = new Comments(clock(), counterIds('c'));
    const edits: CommentEdit[] = [];
    c.onEdit = (e) => edits.push(e);
    c.add('one', ['m1']);
    expect(c.edit('c1', { text: 'one' })).toBe(false);
    expect(c.edit('c1', { text: '' })).toBe(false);
    expect(c.edit('c1', { markerIds: ['m1'] })).toBe(false);
    expect(c.edit('c1', { text: 'two', markerIds: ['m2', 'm3'] })).toBe(true);
    const got = c.get('c1');
    expect(got?.text).toBe('two');
    expect(got?.markerIds).toEqual(['m2', 'm3']);
    expect(got && got.updatedAt > got.createdAt).toBe(true);
    expect(edits.map((e) => e.kind)).toEqual(['add', 'edit']);
  });

  it('links other model files; an empty list leaves the field out', () => {
    const c = new Comments(clock(), counterIds('c'));
    c.add('fits?', [], 'human', ['lid.step', 'lid.step']);
    expect(c.get('c1')?.linkedModels).toEqual(['lid.step']);
    expect(c.edit('c1', { linkedModels: ['lid.step'] })).toBe(false);
    expect(c.edit('c1', { linkedModels: ['lid.step', 'base.step'] })).toBe(true);
    expect(c.edit('c1', { text: 'still fits?' })).toBe(true);
    expect(c.get('c1')?.linkedModels).toEqual(['lid.step', 'base.step']);
    expect(c.edit('c1', { linkedModels: [] })).toBe(true);
    expect(c.get('c1')).not.toHaveProperty('linkedModels');
    expect(c.add('plain', [])).not.toHaveProperty('linkedModels');
    // More than the sidecar allows would make the file unreadable: capped.
    const many = Array.from({ length: MAX_LINKED_MODELS + 3 }, (_, i) => `p${String(i)}.step`);
    expect(c.add('many', [], 'human', many)?.linkedModels).toHaveLength(MAX_LINKED_MODELS);
    c.edit('c1', { linkedModels: many });
    expect(c.get('c1')?.linkedModels).toHaveLength(MAX_LINKED_MODELS);
  });

  it('sets status; a note becomes a reply carrying the status (one undo step)', () => {
    const c = new Comments(clock(), counterIds('c'));
    const edits: CommentEdit[] = [];
    c.onEdit = (e) => edits.push(e);
    c.add('x', []);
    expect(c.setStatus('c1', 'open')).toBe(false);
    expect(c.setStatus('c1', 'resolved', 'added a 2 mm fillet', 'ai')).toBe(true);
    expect(c.get('c1')).toMatchObject({
      status: 'resolved',
      replies: [{ id: 'r1', text: 'added a 2 mm fillet', author: 'ai', status: 'resolved' }],
    });
    expect(edits.map((e) => e.kind)).toEqual(['add', 'status']);
    // Same status with a note: still a reply.
    expect(c.setStatus('c1', 'resolved', 'also the other side', 'ai')).toBe(true);
    expect(c.get('c1')?.replies).toHaveLength(2);
    // A retry with the same note adds no second copy.
    expect(c.setStatus('c1', 'resolved', 'also the other side', 'ai')).toBe(false);
    // The user resolving what the AI resolved = confirming it; then nothing left to do.
    expect(c.setStatus('c1', 'resolved')).toBe(true);
    expect(c.get('c1')).not.toHaveProperty('awaitingConfirm');
    expect(c.setStatus('c1', 'resolved')).toBe(false);
    expect(c.setStatus('c1', 'open')).toBe(true);
    expect(c.get('c1')?.replies).toHaveLength(2); // the thread stays
    expect(c.setStatus('nope', 'wontfix')).toBe(false);
  });

  it('the AI closing a comment waits for the user to confirm', () => {
    const c = new Comments(clock(), counterIds('c'));
    const edits: CommentEdit[] = [];
    c.onEdit = (e) => edits.push(e);
    c.add('x', []);
    c.add('y', []);
    c.setStatus('c1', 'resolved', 'added a fillet', 'ai');
    c.setStatus('c2', 'wontfix', 'needed for the clip', 'ai');
    expect(c.get('c1')?.awaitingConfirm).toBe(true);
    expect(c.get('c2')?.awaitingConfirm).toBe(true);
    // Still listed (and pinned) though closed, until confirmed.
    expect(shownComments(c.list(), false).map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(c.confirm('c1')).toBe(true);
    expect(c.get('c1')).toMatchObject({ status: 'resolved' });
    expect(c.get('c1')).not.toHaveProperty('awaitingConfirm');
    expect(c.confirm('c1')).toBe(false);
    expect(edits.at(-1)?.kind).toBe('confirm');
    expect(shownComments(c.list(), false).map((x) => x.id)).toEqual(['c2']);
    // Reopen (button) or a reply of the user ends the wait too.
    c.reply('c2', 'no, please do it');
    expect(c.get('c2')).toMatchObject({ status: 'open' });
    expect(c.get('c2')).not.toHaveProperty('awaitingConfirm');
    // The AI reopening: nothing to confirm.
    c.setStatus('c2', 'resolved', 'done', 'ai');
    c.setStatus('c2', 'open', 'oops', 'ai');
    expect(c.get('c2')).not.toHaveProperty('awaitingConfirm');
  });

  it('replies: AI keeps the status, the user reopens a closed comment', () => {
    const c = new Comments(clock(), counterIds('c'));
    c.add('x', []);
    c.setStatus('c1', 'resolved');
    const ai = c.reply('c1', ' Which side? ', 'ai');
    expect(ai).toMatchObject({ id: 'r1', text: 'Which side?', author: 'ai' });
    expect(ai).not.toHaveProperty('status');
    expect(c.get('c1')?.status).toBe('resolved');
    const me = c.reply('c1', 'still too thin');
    expect(me).toMatchObject({ id: 'r2', author: 'human', status: 'open' });
    expect(c.get('c1')?.status).toBe('open');
    const again = c.reply('c1', 'left one');
    expect(again).not.toHaveProperty('status');
    expect(c.reply('c1', '   ')).toBeUndefined();
    expect(c.reply('nope', 'x')).toBeUndefined();
  });

  it('edits and deletes replies (undoable)', () => {
    const c = new Comments(clock(), counterIds('c'));
    const edits: CommentEdit[] = [];
    c.onEdit = (e) => edits.push(e);
    c.add('x', []);
    c.reply('c1', 'one');
    c.reply('c1', 'two');
    expect(c.editReply('c1', 'r1', 'one')).toBe(false);
    expect(c.editReply('c1', 'r1', ' ')).toBe(false);
    expect(c.editReply('c1', 'r1', 'uno')).toBe(true);
    const r1 = c.get('c1')?.replies?.[0];
    expect(r1?.text).toBe('uno');
    expect(r1?.updatedAt).not.toBe(r1?.createdAt);
    expect(c.removeReply('c1', 'r1')).toBe(true);
    expect(c.removeReply('c1', 'r1')).toBe(false);
    expect(c.get('c1')?.replies?.map((r) => r.id)).toEqual(['r2']);
    // A new reply never reuses a live id.
    expect(c.reply('c1', 'three')?.id).toBe('r3');
    c.removeReply('c1', 'r2');
    c.removeReply('c1', 'r3');
    expect(c.get('c1')).not.toHaveProperty('replies');
    expect(edits.map((e) => e.kind)).toEqual([
      'add',
      'reply',
      'reply',
      'edit-reply',
      'remove-reply',
      'reply',
      'remove-reply',
      'remove-reply',
    ]);
    const before = edits[4]?.before;
    if (before) c.restore(before);
    expect(c.get('c1')?.replies?.map((r) => r.text)).toEqual(['uno', 'two']);
  });

  it('removes, and restore puts any earlier state back (undo)', () => {
    const c = new Comments(clock(), counterIds('c'));
    const edits: CommentEdit[] = [];
    c.onEdit = (e) => edits.push(e);
    c.add('a', []);
    c.add('b', []);
    expect(c.remove('c1')).toBe(true);
    expect(c.remove('c1')).toBe(false);
    const del = edits[2];
    expect(del?.kind).toBe('remove');
    if (!del) return;
    c.restore(del.before);
    expect(c.list().map((x) => x.text)).toEqual(['a', 'b']);
    c.restore(del.after);
    expect(c.list().map((x) => x.text)).toEqual(['b']);
    // ids are never reused
    expect(c.add('d', [])?.id).toBe('c3');
  });

  it('reset empties the list without an edit', () => {
    const c = new Comments(clock(), counterIds('c'));
    c.add('a', []);
    let edited = false;
    c.onEdit = () => (edited = true);
    c.reset();
    expect(c.list()).toEqual([]);
    expect(edited).toBe(false);
  });
});

describe('filters', () => {
  const c = new Comments(clock(), counterIds('c'));
  c.add('a', ['m1']);
  c.add('b', ['m2', 'm3']);
  c.add('c', []);
  c.setStatus('c2', 'resolved');
  c.setStatus('c3', 'wontfix');
  const list = c.list();

  it('commentsOnMarkers finds comments naming any of the markers', () => {
    expect(commentsOnMarkers(list, new Set(['m3'])).map((x) => x.id)).toEqual(['c2']);
    expect(commentsOnMarkers(list, new Set(['m1', 'm2'])).map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(commentsOnMarkers(list, new Set())).toEqual([]);
  });

  it('shownComments hides closed ones unless asked or kept', () => {
    expect(shownComments(list, false).map((x) => x.id)).toEqual(['c1']);
    expect(shownComments(list, true).map((x) => x.id)).toEqual(['c1', 'c2', 'c3']);
    expect(shownComments(list, false, new Set(['c3'])).map((x) => x.id)).toEqual(['c1', 'c3']);
  });

  it('liveMarkerIds drops deleted markers', () => {
    const b = c.get('c2');
    if (!b) throw new Error('missing');
    expect(liveMarkerIds(b, (id) => id === 'm3')).toEqual(['m3']);
  });
});

describe('resolvedMarkerIds', () => {
  it('a marker is resolved once every comment on it is closed', () => {
    const c = new Comments(clock(), counterIds('c'));
    c.add('a', ['m1']);
    c.add('b', ['m1', 'm2']);
    c.add('general', []);
    expect(resolvedMarkerIds(c.list())).toEqual(new Set());
    c.setStatus('c2', 'resolved');
    // m1 still has the open c1; m2 only had c2.
    expect(resolvedMarkerIds(c.list())).toEqual(new Set(['m2']));
    c.setStatus('c1', 'wontfix');
    expect(resolvedMarkerIds(c.list())).toEqual(new Set(['m1', 'm2']));
    c.setStatus('c1', 'open'); // reopen brings it back
    expect(resolvedMarkerIds(c.list())).toEqual(new Set(['m2']));
  });

  it("the AI's close waits for your Confirm", () => {
    const c = new Comments(clock(), counterIds('c'));
    c.add('a', ['m1']);
    c.setStatus('c1', 'resolved', 'added a fillet', 'ai');
    expect(resolvedMarkerIds(c.list())).toEqual(new Set());
    c.confirm('c1');
    expect(resolvedMarkerIds(c.list())).toEqual(new Set(['m1']));
  });

  it('markers without comments are never resolved', () => {
    expect(resolvedMarkerIds([])).toEqual(new Set());
  });
});

describe('AI edits and undo', () => {
  /** Comments wired like the window (`wiring/edit-history.ts`): user edits on a stack, AI edits not; undo / redo via `apply`. */
  function setup() {
    const c = new Comments(clock(), counterIds('c'));
    const stack: CommentEdit[] = [];
    c.onEdit = (e) => {
      if (e.by === 'human') stack.push(e);
    };
    const undo = () => {
      const e = stack.pop();
      if (e) c.apply(e.after, e.before);
      return e;
    };
    return { c, stack, undo };
  }

  it('marks who made each edit', () => {
    const c = new Comments(clock(), counterIds('c'));
    const by: string[] = [];
    c.onEdit = (e) => by.push(`${e.kind}:${e.by}`);
    c.add('Fillet this', []);
    c.reply('c1', 'Which radius?', 'ai');
    c.setStatus('c1', 'resolved', 'Done', 'ai');
    c.reply('c1', '2 mm');
    expect(by).toEqual(['add:human', 'reply:ai', 'status:ai', 'reply:human']);
  });

  it('undoing a user step keeps the AI reply and status that came after it', () => {
    const { c, undo } = setup();
    c.add('Fillet this', []);
    c.add('Hole too small', []);
    c.edit('c1', { text: 'Fillet this edge' });
    c.setStatus('c1', 'resolved', 'Added a 2 mm fillet', 'ai');
    c.reply('c2', 'How much bigger?', 'ai');

    expect(undo()?.kind).toBe('edit');
    const c1 = c.get('c1');
    expect(c1?.text).toBe('Fillet this');
    expect(c1).toMatchObject({ status: 'resolved', awaitingConfirm: true });
    expect(c1?.replies?.map((r) => r.text)).toEqual(['Added a 2 mm fillet']);

    expect(undo()?.kind).toBe('add'); // the user's own comment goes, with the AI's reply on it
    expect(c.get('c2')).toBeUndefined();
    expect(c.get('c1')?.replies).toHaveLength(1);
  });

  it('undoing the user’s resolve leaves a status the AI set since', () => {
    const { c, undo } = setup();
    c.add('Fillet this', []);
    c.setStatus('c1', 'resolved');
    c.setStatus('c1', 'wontfix', 'Too thin for a fillet', 'ai');
    undo();
    expect(c.get('c1')?.status).toBe('wontfix');
    expect(c.get('c1')?.replies).toHaveLength(1);
  });

  it('undo / redo of a user reply keeps a later AI reply, in thread order', () => {
    const { c, stack, undo } = setup();
    c.add('Fillet this', []);
    c.reply('c1', '2 mm please');
    c.reply('c1', 'OK, 2 mm', 'ai');
    const step = undo();
    expect(c.get('c1')?.replies?.map((r) => r.text)).toEqual(['OK, 2 mm']);
    if (step) c.apply(step.before, step.after); // redo
    expect(c.get('c1')?.replies?.map((r) => r.text)).toEqual(['2 mm please', 'OK, 2 mm']);
    expect(stack).toHaveLength(1);
  });

  it('undoing a delete puts the comment back in its place', () => {
    const { c, undo } = setup();
    c.add('a', []);
    c.add('b', []);
    c.add('c', []);
    c.remove('c2');
    c.reply('c3', 'seen', 'ai');
    undo();
    expect(c.list().map((x) => x.text)).toEqual(['a', 'b', 'c']);
    expect(c.get('c3')?.replies).toHaveLength(1);
  });

  it('undoing Confirm brings the confirm question back', () => {
    const { c, undo } = setup();
    c.add('Fillet this', []);
    c.setStatus('c1', 'resolved', 'Done', 'ai');
    c.confirm('c1');
    expect(c.get('c1')?.awaitingConfirm).toBeUndefined();
    undo();
    expect(c.get('c1')).toMatchObject({ status: 'resolved', awaitingConfirm: true });
  });

  it('an undone reply’s id is not reused: undo / redo never touch a later AI reply', () => {
    const { c, undo } = setup();
    c.add('Fillet this', []);
    c.reply('c1', '2 mm please');
    const step = undo();
    const ai = c.reply('c1', 'Which edge?', 'ai');
    expect(ai?.id).toBe('r2');
    if (step) c.apply(step.before, step.after); // redo: the user's reply comes back
    expect(c.get('c1')?.replies?.map((r) => r.text)).toEqual(['2 mm please', 'Which edge?']);
    if (step) c.apply(step.after, step.before); // undo again: the AI's reply stays
    expect(c.get('c1')?.replies?.map((r) => r.text)).toEqual(['Which edge?']);
  });

  it('undoing Add comment removes it with the AI replies on it; redo brings it back without', () => {
    const { c, stack, undo } = setup();
    c.add('Fillet this', []);
    c.reply('c1', 'Which edge?', 'ai');
    const step = undo();
    expect(c.list()).toHaveLength(0);
    if (step) c.apply(step.before, step.after);
    expect(c.get('c1')?.replies).toBeUndefined();
    expect(stack).toHaveLength(0);
  });
});

describe('part results (part requests)', () => {
  const part = (id: string): PartItemData => ({
    id,
    source: { kind: 'library', library: 'bd_warehouse', cls: 'HexNut', params: {} },
    copies: 1,
    scope: 'whole',
  });
  const request = (): Comments => {
    const c = new Comments(clock(), counterIds('c'));
    c.add('Fasten here', [], 'human', [], [part('p1'), part('p2')]);
    return c;
  };

  it('stores the parts on the comment from the start', () => {
    expect(
      request()
        .get('c1')
        ?.parts?.map((p) => p.id),
    ).toEqual(['p1', 'p2']);
    const none = new Comments(clock(), counterIds('c'));
    none.add('No parts', []);
    expect(none.get('c1')).not.toHaveProperty('parts');
  });

  it('writes the AI results onto their parts and reports how many changed', () => {
    const c = request();
    const n = c.setPartResults('c1', [
      { partId: 'p1', status: 'placed', bodies: ['Nut M5 (Hole 1)'], note: ' two nuts ' },
      { partId: 'p2', status: 'needs-info', note: 'Which thread?' },
    ]);
    expect(n).toBe(2);
    const [p1, p2] = c.get('c1')?.parts ?? [];
    expect(p1?.result).toMatchObject({
      status: 'placed',
      bodies: ['Nut M5 (Hole 1)'],
      note: 'two nuts',
    });
    expect(p1?.result?.updatedAt).toMatch(/^2026-/);
    expect(p2?.result).toMatchObject({ status: 'needs-info', note: 'Which thread?' });
    expect(p2?.result).not.toHaveProperty('bodies');
  });

  it('changes nothing when the same results come again', () => {
    const c = request();
    const results = [{ partId: 'p1', status: 'placed' as const }];
    expect(c.setPartResults('c1', results)).toBe(1);
    const stamp = c.get('c1')?.updatedAt;
    expect(c.setPartResults('c1', results)).toBe(0);
    expect(c.get('c1')?.updatedAt).toBe(stamp);
  });

  it('refuses an unknown part id and writes nothing', () => {
    const c = request();
    expect(() =>
      c.setPartResults('c1', [
        { partId: 'p1', status: 'placed' },
        { partId: 'p9', status: 'failed' },
      ]),
    ).toThrow(/no part "p9".*"p1", "p2"/);
    expect(c.get('c1')?.parts?.[0]).not.toHaveProperty('result');
    expect(c.setPartResults('nope', [{ partId: 'p1', status: 'placed' }])).toBe(0);
  });

  it('is an AI edit reported as "parts", and the later result wins', () => {
    const c = request();
    const edits: CommentEdit[] = [];
    c.onEdit = (e) => edits.push(e);
    c.setPartResults('c1', [
      { partId: 'p1', status: 'failed' },
      { partId: 'p1', status: 'placed' },
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: 'parts', by: 'ai' });
    expect(c.get('c1')?.parts?.[0]?.result?.status).toBe('placed');
  });
});
