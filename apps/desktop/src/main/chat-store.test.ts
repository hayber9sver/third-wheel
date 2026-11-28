import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatEntry as ChatLine, ChatInfo } from '@third-wheel/core';
import type { ChatEntry } from '../shared/chat.js';
import { ProjectChatStore, toEntry, toLine, type ChatProjectAccess } from './chat-store.js';

const ref = {
  modelId: 'live1',
  file: 'bracket.step',
  path: '/cad/bracket.step',
  commentId: 'c7',
  n: 3,
  title: 'Pin too tight',
};

describe('chat lines ↔ window entries', () => {
  it('a comment link is saved by comment id and part, not by the file the window had', () => {
    const e: ChatEntry = { seq: 4, kind: 'replied', text: 'Loosened', at: 0, ref };
    const saved = toLine(e, { partId: 'p1', versionId: 'v1' });
    expect(saved).toEqual({
      seq: 4,
      kind: 'replied',
      text: 'Loosened',
      at: '1970-01-01T00:00:00.000Z',
      ref: { commentId: 'c7', modelId: 'p1', file: 'bracket.step', n: 3, title: 'Pin too tight' },
    });
    expect(JSON.stringify(saved)).not.toContain('/cad/'); // no absolute paths in the project
    // Read back: opens on the part's newest version.
    expect(toEntry(saved, { path: '/cad/bracket_v3.step', name: 'bracket_v3.step' })).toEqual({
      seq: 4,
      kind: 'replied',
      text: 'Loosened',
      at: 0,
      ref: {
        modelId: '',
        partId: 'p1',
        file: 'bracket_v3.step',
        path: '/cad/bracket_v3.step',
        commentId: 'c7',
        n: 3,
        title: 'Pin too tight',
      },
    });
    // Part gone: the link has no file to open.
    expect(toEntry(saved, undefined)?.ref).toMatchObject({ path: '', file: 'bracket.step' });
  });

  it('"Answered in topic" keeps the topic it names (another project: by name)', () => {
    const at = Date.parse('2026-11-22T09:00:00.000Z');
    const e = {
      seq: 4,
      kind: 'elsewhere' as const,
      text: 'Answered in topic “Hole”',
      at,
      topic: { title: 'Hole', chatId: 'k1' },
    };
    const saved = toLine(e, undefined);
    expect(saved).toMatchObject({ topic: { title: 'Hole', chat: 'k1' } });
    expect(toEntry(saved, undefined)).toEqual(e);
    const other = { ...e, topic: { title: 'Wall', project: 'cad' } };
    expect(toEntry(toLine(other, undefined), undefined)).toEqual(other);
  });

  it('a model event keeps the version shown; unknown kinds from a newer app are skipped', () => {
    const e: ChatEntry = {
      seq: 1,
      kind: 'event',
      text: 'Opened b.step',
      at: 5,
      path: '/cad/b.step',
    };
    expect(toLine(e, { partId: 'p1', versionId: 'v2' })).toMatchObject({ model: 'v2' });
    expect(toLine(e, undefined)).not.toHaveProperty('model');
    expect(
      toEntry({ seq: 2, kind: 'poll', text: '?', at: '2026-01-01T00:00:00Z' }, undefined),
    ).toBe(undefined);
  });
});

describe('ProjectChatStore', () => {
  function access(lines: ChatLine[], chats: ChatInfo[]) {
    const appended: { lines: readonly ChatLine[]; title: string; summary?: string }[] = [];
    const a: ChatProjectAccess = {
      chatIndex: () => Promise.resolve(chats),
      chatLines: () => Promise.resolve(lines),
      appendChatLines: (_f, _id, l, title, summary) => {
        appended.push({ lines: l, title, ...(summary === undefined ? {} : { summary }) });
        return Promise.resolve('saved' as const);
      },
      chatFacts: () => Promise.resolve(undefined),
      versionPlace: (_f, file) =>
        Promise.resolve(
          file === '/cad/bracket.step' ? { partId: 'p1', versionId: 'v1' } : undefined,
        ),
      partLink: () => Promise.resolve({ path: '/cad/bracket_v2.step', name: 'bracket_v2.step' }),
    };
    return { a, appended };
  }
  const info = (id: string): ChatInfo => ({
    id,
    title: id,
    created: '2026-11-20T10:00:00.000Z',
    last: '2026-11-21T10:00:00.000Z',
    entries: 3,
  });
  const lines: ChatLine[] = Array.from({ length: 5 }, (_, i) => ({
    seq: i + 1,
    kind: i === 2 ? 'future-kind' : 'user',
    text: `m${String(i + 1)}`,
    at: '2026-11-21T10:00:00.000Z',
  }));

  it('the current chat = the last in the index: latest lines, highest seq, older ones paged', async () => {
    const store = new ProjectChatStore(access(lines, [info('old'), info('cur')]).a);
    const c = await store.current('/cad', 2);
    expect(c).toMatchObject({ chatId: 'cur', hasOlder: true, lastSeq: 5 });
    expect(c.entries.map((e) => e.seq)).toEqual([4, 5]);
    const page = await store.read('/cad', 'cur', 4, 2);
    expect(page.entries.map((e) => e.seq)).toEqual([1, 2]); // seq 3 is a kind this app skips
    expect(page.hasOlder).toBe(false);
    expect(await store.read('/cad', 'unknown', undefined, 2)).toEqual({
      entries: [],
      hasOlder: false,
    });
  });

  it('the catch-up counts a shown model the project does not list yet as a part', async () => {
    const { a } = access(lines, []);
    a.chatFacts = () =>
      Promise.resolve({ name: 'cad', parts: [{ file: 'bracket.step', openComments: 2 }] });
    const store = new ProjectChatStore(a);
    const shown = join('/cad', 'loose.step');
    expect((await store.facts('/cad', undefined, undefined, shown))?.parts).toEqual([
      { file: 'bracket.step', openComments: 2 },
      { file: 'loose.step', openComments: 0 },
    ]);
    // A listed version (also an older one) is not added again; no shown model: as the project says.
    expect(
      (await store.facts('/cad', undefined, undefined, '/cad/bracket.step'))?.parts,
    ).toHaveLength(1);
    expect((await store.facts('/cad', undefined, undefined))?.parts).toHaveLength(1);
  });

  it('no chat yet: empty; a list in index order with times in ms', async () => {
    expect(await new ProjectChatStore(access([], []).a).current('/cad', 10)).toEqual({
      entries: [],
      hasOlder: false,
      lastSeq: 0,
    });
    const list = await new ProjectChatStore(access([], [info('a')]).a).list('/cad');
    expect(list).toEqual([
      {
        id: 'a',
        title: 'a',
        created: Date.parse(info('a').created),
        last: Date.parse(info('a').last),
        entries: 3,
      },
    ]);
  });

  it('join / catch-up / summary lines keep connection, agent and detail; the summary reaches the index', async () => {
    const { a, appended } = access([], []);
    const store = new ProjectChatStore(a);
    const joined = {
      seq: 1,
      kind: 'joined' as const,
      text: 'Claude Code connected',
      at: 0,
      connection: 'conn00001',
      agent: 'claude-code',
    };
    const summary = {
      seq: 2,
      kind: 'summary' as const,
      text: 'Saved a summary',
      at: 0,
      detail: 'Pin Ø4.8',
    };
    await store.append('/cad', 'k1', [joined, summary], 'x');
    expect(appended[0]?.summary).toBe('Pin Ø4.8');
    expect(appended[0]?.lines[0]).toMatchObject({ connection: 'conn00001', agent: 'claude-code' });
    const saved = appended[0]?.lines[1];
    if (!saved) throw new Error('not appended');
    const back = toEntry(saved, undefined);
    expect(back).toMatchObject({ kind: 'summary', detail: 'Pin Ø4.8' });
    await store.append('/cad', 'k1', [{ seq: 3, kind: 'user', text: 'hi', at: 0 }], 'x');
    expect(appended[1]).not.toHaveProperty('summary');
  });

  it('append looks up the part of a live comment link and the version of an event', async () => {
    const { a, appended } = access([], []);
    const store = new ProjectChatStore(a);
    await store.append(
      '/cad',
      'k1',
      [
        { seq: 1, kind: 'event', text: 'Opened', at: 0, path: '/cad/bracket.step' },
        { seq: 2, kind: 'thread', text: 'looser', at: 0, ref },
      ],
      'looser',
    );
    expect(appended[0]?.title).toBe('looser');
    expect(appended[0]?.lines[0]).toMatchObject({ model: 'v1' });
    expect(appended[0]?.lines[1]?.ref).toMatchObject({ modelId: 'p1', commentId: 'c7' });
    expect(store.newId()).toMatch(/^[a-z0-9]+$/);
  });
});
