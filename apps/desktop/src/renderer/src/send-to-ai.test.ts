import { describe, expect, it } from 'vitest';
import type { Comment } from './comments.js';
import { ReviewedFiles, reviewSentText, SentComments, sendToAiMessage } from './send-to-ai.js';

describe('ReviewedFiles', () => {
  it('lists models with open comments plus the shown one, in first-seen order', () => {
    const r = new ReviewedFiles();
    r.update({ path: '/a/bracket.step', name: 'bracket.step', openComments: 2 });
    r.update({ path: '/a/empty.step', name: 'empty.step', openComments: 0 });
    r.update({ path: '/b/housing.step', name: 'housing.step', openComments: 0 });
    r.update({ path: '/b/housing.step', name: 'housing.step', openComments: 1 });
    r.update({ path: '/a/bracket.step', name: 'bracket.step', openComments: 3 });
    expect(r.forMessage('/b/housing.step').map((f) => [f.name, f.openComments])).toEqual([
      ['bracket.step', 3],
      ['housing.step', 1],
    ]);
    expect(r.forMessage('/a/empty.step').map((f) => f.name)).toEqual([
      'bracket.step',
      'empty.step',
      'housing.step',
    ]);
  });

  it('drops a model whose comments were all resolved (unless shown)', () => {
    const r = new ReviewedFiles();
    r.update({ path: 'C:\\cad\\a.step', name: 'a.step', openComments: 1 });
    r.update({ path: 'C:\\cad\\a.step', name: 'a.step', openComments: 0 });
    expect(r.forMessage(undefined)).toEqual([]);
  });
});

describe('sendToAiMessage', () => {
  it('names one model with its path', () => {
    expect(sendToAiMessage([{ path: '/cad/box.step', name: 'box.step', openComments: 1 }])).toBe(
      'I reviewed box.step in Third Wheel (1 open comment).\n' +
        'Path: /cad/box.step\n' +
        'Please read them with the Third Wheel MCP tools: load_model on that path, then get_annotations.',
    );
  });

  it('lists several models as belonging together', () => {
    const text = sendToAiMessage([
      { path: '/a/bracket.step', name: 'bracket.step', openComments: 3 },
      { path: 'C:\\b\\housing.step', name: 'housing.step', openComments: 1 },
    ]);
    expect(text).toBe(
      'I reviewed 2 models in Third Wheel; they belong together:\n' +
        '- /a/bracket.step (3 open comments)\n' +
        '- C:\\b\\housing.step (1 open comment)\n' +
        'Please read them with the Third Wheel MCP tools: load_model on each path, then get_annotations.',
    );
  });
});

const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  text: `comment ${id}`,
  markerIds: [],
  status: 'open',
  author: 'human',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  ...over,
});

describe('SentComments', () => {
  it('counts open comments the agent has not had; a change makes one count again', () => {
    const sent = new SentComments();
    const a = comment('c1');
    const b = comment('c2', { status: 'resolved' });
    const c = comment('c3');
    expect(sent.unsent([a, b, c]).map((u) => [u.id, u.n])).toEqual([
      ['c1', 1],
      ['c3', 3],
    ]);
    sent.mark(a);
    expect(sent.unsent([a, b, c]).map((u) => u.id)).toEqual(['c3']);
    const replied: Comment = {
      ...a,
      replies: [
        {
          id: 'r1',
          text: 'more',
          author: 'human',
          createdAt: a.createdAt,
          updatedAt: a.createdAt,
        },
      ],
    };
    expect(sent.unsent([replied]).map((u) => u.id)).toEqual(['c1']);
    sent.mark(replied);
    expect(sent.unsent([replied])).toEqual([]);
    sent.forget(replied); // the thread reply didn't reach the agent
    expect(sent.unsent([replied]).map((u) => u.id)).toEqual(['c1']);
  });

  it('skips comments the AI wrote last (its own comment or its reply is the latest)', () => {
    const sent = new SentComments();
    const byAi = comment('c1', { author: 'ai' });
    const answered = comment('c2', {
      replies: [
        {
          id: 'r1',
          text: 'Done',
          author: 'ai',
          createdAt: '2026-11-20T10:01:00.000Z',
          updatedAt: '2026-11-20T10:01:00.000Z',
        },
      ],
    });
    expect(sent.unsent([byAi, answered])).toEqual([]);
  });

  it('a comment carried to a new version keeps its sent mark (same id and creation time)', () => {
    const sent = new SentComments();
    sent.mark(comment('c1'));
    expect(sent.unsent([comment('c1')])).toEqual([]);
    expect(sent.unsent([comment('c1', { createdAt: '2026-11-20T11:00:00.000Z' })])).toHaveLength(1);
  });
});

describe('Send review with a chat agent', () => {
  it('sums unsent comments over models, marks all sent, and names them in one line', () => {
    const sent = new SentComments();
    const r = new ReviewedFiles();
    const one = sent.unsent([comment('c1'), comment('c2')]);
    r.update({ path: '/a/bracket.step', name: 'bracket.step', openComments: 2, unsent: one });
    r.update({
      path: '/a/lid.step',
      name: 'lid.step',
      openComments: 1,
      unsent: sent.unsent([comment('c1', { createdAt: '2026-11-20T09:00:00.000Z' })]),
    });
    expect(r.unsentCount()).toBe(3);
    expect(reviewSentText(r.withUnsent())).toBe(
      'Review sent: 2 new comments on bracket.step, 1 on lid.step',
    );
    r.markAllSent(sent);
    expect(r.unsentCount()).toBe(0);
    expect(r.withUnsent()).toEqual([]);
    expect(sent.unsent([comment('c1'), comment('c2')])).toEqual([]);
  });
});

describe('ReviewedFiles per project and part', () => {
  const u = (id: string) => ({ id, n: 1, key: `${id}@t`, state: 's' });
  it('a comment two listed files share (parts just joined) counts once', () => {
    const r = new ReviewedFiles();
    r.update({
      path: '/p/d.step',
      name: 'd.step',
      openComments: 1,
      unsent: [u('c1')],
      project: '/p',
    });
    r.update({
      path: '/p/e.step',
      name: 'e.step',
      openComments: 2,
      unsent: [u('c1'), u('c2')],
      project: '/p',
      partId: 'part1',
    });
    expect(r.unsentCount()).toBe(2);
  });

  it('versions of one part count once (the one shown last); other projects drop out', () => {
    const r = new ReviewedFiles();
    // v1 shown before the project listed it, then listed: one entry.
    r.update({
      path: '/p/a.step',
      name: 'a.step',
      openComments: 1,
      unsent: [u('c1')],
      project: '/p',
    });
    r.update({
      path: '/p/a.step',
      name: 'a.step',
      openComments: 1,
      unsent: [u('c1')],
      project: '/p',
      partId: 'part1',
    });
    expect(r.unsentCount()).toBe(1);
    // v2 of the same part shows the same comment: still 1, named as v2.
    r.update({
      path: '/p/a_v2.step',
      name: 'a_v2.step',
      openComments: 1,
      unsent: [u('c1')],
      project: '/p',
      partId: 'part1',
    });
    expect(r.unsentCount()).toBe(1);
    expect(r.withUnsent().map((f) => f.name)).toEqual(['a_v2.step']);
    // Another part of the project adds its own.
    r.update({
      path: '/p/lid.step',
      name: 'lid.step',
      openComments: 1,
      unsent: [u('c9')],
      project: '/p',
      partId: 'part2',
    });
    expect(r.unsentCount()).toBe(2);
    // A model of another project, without comments: no badge from the first project.
    r.update({ path: '/q/b.step', name: 'b.step', openComments: 0, unsent: [], project: '/q' });
    expect(r.unsentCount()).toBe(0);
    expect(r.forMessage('/q/b.step').map((f) => f.name)).toEqual(['b.step']);
  });
});
