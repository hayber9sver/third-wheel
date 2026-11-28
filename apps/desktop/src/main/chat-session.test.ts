import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../shared/chat.js';
import type { ChatEntry } from '../shared/chat.js';
import { ChatSession, type ChatStore } from './chat-session.js';

/** Chats per folder in memory; `readOnly` folders refuse writes. */
function memoryStore(readOnly: ReadonlySet<string> = new Set()) {
  /** Answers `not-shown` this many times (a project switch while lines were on their way). */
  const elsewhere = { times: 0 };
  const chats = new Map<string, { id: string; title: string; lines: ChatEntry[] }[]>();
  let ids = 0;
  const appends: { folder: string; chatId: string; kinds: string[] }[] = [];
  const store: ChatStore = {
    newId: () => `chat${String(++ids)}`,
    current: (folder, limit) => {
      const c = chats.get(folder)?.at(-1);
      if (!c) return Promise.resolve({ entries: [], hasOlder: false, lastSeq: 0 });
      return Promise.resolve({
        chatId: c.id,
        entries: c.lines.slice(-limit),
        hasOlder: c.lines.length > limit,
        lastSeq: c.lines.at(-1)?.seq ?? 0,
      });
    },
    append: (folder, chatId, entries, title) => {
      if (elsewhere.times > 0) {
        elsewhere.times--;
        return Promise.resolve('not-shown' as const);
      }
      if (readOnly.has(folder)) return Promise.resolve('read-only' as const);
      const list = chats.get(folder) ?? [];
      let c = list.find((x) => x.id === chatId);
      if (!c) {
        c = { id: chatId, title, lines: [] };
        list.push(c);
      }
      c.lines.push(...entries);
      chats.set(folder, list);
      appends.push({ folder, chatId, kinds: entries.map((e) => e.kind) });
      return Promise.resolve('saved' as const);
    },
    list: (folder) =>
      Promise.resolve(
        (chats.get(folder) ?? []).map((c) => ({
          id: c.id,
          title: c.title,
          created: 1,
          last: 2,
          entries: c.lines.length,
        })),
      ),
    read: (folder, chatId, before, limit) => {
      const lines = (chats.get(folder) ?? [])
        .find((c) => c.id === chatId)
        ?.lines.filter((l) => before === undefined || l.seq < before);
      return Promise.resolve({
        entries: (lines ?? []).slice(-limit),
        hasOlder: (lines?.length ?? 0) > limit,
      });
    },
  };
  return { store, chats, appends, elsewhere };
}

/** An agent listened once this app session (the message box unlocks); its wait is dropped at once, so messages queue. */
function listened(chat: ChatSession): void {
  void chat.wait({}, AbortSignal.abort());
}

describe('ChatSession', () => {
  it('keeps the conversation in order; queued marks use the chat line number', async () => {
    const events: ChatEvent[] = [];
    const chat = new ChatSession({ waitSec: 60, emit: (e) => events.push(e), now: () => 5 });
    await chat.projectShown('/cad');
    listened(chat);
    chat.agentProgress({ text: 'Reading the model' });
    const mine = chat.userSend('Make the hole 6 mm');
    expect(mine).toMatchObject({ seq: 2, kind: 'user' });
    expect(chat.view().status.queued).toEqual([2]);
    const r = await chat.wait({});
    expect(r).toMatchObject({
      state: 'message',
      messages: [{ id: 1, text: 'Make the hole 6 mm' }],
    });
    chat.agentSend({ text: 'Done: **Ø6**' });
    expect(chat.view().entries.map((e) => [e.seq, e.kind])).toEqual([
      [1, 'progress'],
      [2, 'user'],
      [3, 'agent'],
    ]);
    expect(events.filter((e) => e.kind === 'entry')).toHaveLength(3);
    // It answered: done with the message (listening for the grace, until its next wait).
    expect(chat.view().status).toMatchObject({ state: 'listening', queued: [] });
    chat.dispose();
  });

  it('refuses empty user messages and bad agent params', async () => {
    const chat = new ChatSession();
    expect(chat.userSend('   ')).toBeUndefined();
    expect(chat.userSend(42)).toBeUndefined();
    expect(() => chat.agentSend({ text: '' })).toThrow();
    expect(() => chat.agentProgress({ text: 'x'.repeat(301) })).toThrow();
    await expect(chat.wait({ timeoutSec: 5 })).rejects.toThrow();
    await expect(chat.wait({ connection: 'Not An Id' })).rejects.toThrow();
    expect(chat.view().entries).toEqual([]);
    chat.dispose();
  });

  it('refuses user messages before a project is shown and before any agent listened', async () => {
    const chat = new ChatSession({ waitSec: 60 });
    listened(chat);
    expect(chat.userSend('no project yet')).toBeUndefined();
    const fresh = new ChatSession({ waitSec: 60 });
    await fresh.projectShown('/cad');
    expect(fresh.userSend('no agent yet')).toBeUndefined();
    listened(fresh);
    expect(fresh.userSend('now')).toMatchObject({ kind: 'user', text: 'now' });
    expect(chat.view().entries).toEqual([]);
    chat.dispose();
    fresh.dispose();
  });

  it("shows the agent's own name once it listened; a new name reaches the window", () => {
    const events: ChatEvent[] = [];
    const chat = new ChatSession({ waitSec: 60, emit: (e) => events.push(e) });
    expect(chat.view().status.agent).toBeUndefined();
    void chat.wait({ agent: 'claude-code' });
    expect(chat.view().status).toMatchObject({ state: 'listening', agent: 'claude-code' });
    void chat.wait({ agent: 'other-agent' });
    const last = events.filter((e) => e.kind === 'status').at(-1);
    expect(last).toMatchObject({ status: { agent: 'other-agent' } });
    chat.dispose();
  });

  const ref = {
    modelId: 'abc123',
    file: 'bracket.step',
    path: '/cad/bracket.step',
    commentId: 'c5',
    n: 3,
    title: 'Pin too tight',
  };
  const thread = {
    kind: 'thread',
    text: 'Make it 0.1 mm looser',
    ref,
    about: {
      kind: 'thread',
      modelId: 'abc123',
      file: 'bracket.step',
      commentId: 'c5',
      n: 3,
      payload: { comments: [{ id: 'c5', n: 3 }] },
    },
  } as const;

  it('a thread reply goes to the agent with what it is about, once an agent listened', async () => {
    const chat = new ChatSession({ waitSec: 60 });
    expect(chat.post(thread)).toBeUndefined(); // no chat agent yet: nothing queued
    void chat.wait({}).catch(() => undefined);
    const wait = chat.wait({});
    const entry = chat.post(thread);
    expect(entry).toMatchObject({ kind: 'thread', text: 'Make it 0.1 mm looser', ref });
    expect(await wait).toMatchObject({
      state: 'message',
      messages: [{ id: entry?.seq, text: 'Make it 0.1 mm looser', about: thread.about }],
    });
    chat.dispose();
  });

  it("the agent's reply under a comment is shown, not queued; bad posts are refused", () => {
    const chat = new ChatSession({ waitSec: 60 });
    expect(chat.post({ kind: 'replied', text: 'Loosened to 5.05', ref })).toMatchObject({
      kind: 'replied',
      ref,
    });
    expect(chat.view().status.queued).toEqual([]);
    expect(chat.post({ kind: 'replied', text: 'x' })).toBeUndefined();
    expect(chat.post({ ...thread, extra: 1 })).toBeUndefined();
    void chat.wait({});
    const huge = { ...thread, about: { ...thread.about, payload: 'x'.repeat(70_000) } };
    expect(chat.post(huge)).toBeUndefined();
    chat.dispose();
  });

  describe('saved in the project', () => {
    it('a chat is written with its first message; model events alone write nothing', async () => {
      const { store, chats, appends } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/cad');
      listened(chat);
      chat.post({ kind: 'event', text: 'Opened bracket.step', path: '/cad/bracket.step' });
      await chat.saved;
      expect(appends).toEqual([]); // just looking writes nothing
      chat.userSend('Make the hole 6 mm');
      await chat.saved;
      expect(appends).toEqual([{ folder: '/cad', chatId: 'chat1', kinds: ['event', 'user'] }]);
      expect(chats.get('/cad')?.[0]?.title).toBe('Make the hole 6 mm');
      chat.agentProgress({ text: 'Editing' });
      chat.agentSend({ text: 'Done' });
      chat.post({ kind: 'event', text: 'Agent loaded bracket_v2.step', path: '/cad/b2.step' });
      await chat.saved;
      // The trailing event waits for the next message.
      expect(chats.get('/cad')?.[0]?.lines.map((l) => l.kind)).toEqual([
        'event',
        'user',
        'progress',
        'agent',
      ]);
      expect(chat.view()).toMatchObject({ chatId: 'chat1', inProject: true });
      chat.dispose();
    });

    it("opening the project again shows its current chat, numbered on from the file's last line", async () => {
      const { store } = memoryStore();
      const first = new ChatSession({ waitSec: 60, store });
      await first.projectShown('/cad');
      listened(first);
      first.userSend('one');
      first.agentSend({ text: 'two' });
      await first.saved;
      first.dispose();
      const events: ChatEvent[] = [];
      const again = new ChatSession({ waitSec: 60, store, emit: (e) => events.push(e) });
      await again.projectShown('/cad');
      expect(events.at(-1)).toMatchObject({ kind: 'reset', view: { chatId: 'chat1' } });
      expect(again.view().entries.map((e) => e.text)).toEqual(['one', 'two']);
      listened(again);
      expect(again.userSend('three')?.seq).toBe(3);
      again.dispose();
    });

    it('lines before any project are shown only, never saved; the user types once one is open', async () => {
      const { store, chats } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      listened(chat);
      expect(chat.userSend('Build me a bracket')).toBeUndefined(); // the box is locked
      chat.agentSend({ text: 'Building…' });
      expect(chat.view()).toMatchObject({ inProject: false, entries: [{ text: 'Building…' }] });
      await chat.projectShown('/cad');
      expect(chat.view().entries).toEqual([]);
      chat.userSend('hello');
      await chat.saved;
      expect(chats.get('/cad')?.[0]?.lines.map((l) => [l.seq, l.text])).toEqual([[1, 'hello']]);
      chat.dispose();
    });

    it('New topic while the agent works on the old one: no "…" in the new topic', async () => {
      const { store } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/cad');
      listened(chat);
      chat.userSend('make the hole 8 mm');
      await chat.wait({});
      expect(chat.view().status.state).toBe('working');
      expect(chat.view().status.workingIn).toBeUndefined();
      expect(await chat.newChat()).toBe(true);
      expect(chat.view().status).toMatchObject({
        state: 'working',
        workingIn: { title: 'make the hole 8 mm', chatId: expect.any(String) as unknown },
      });
      // The next request comes from the new topic: its "…" shows there.
      chat.userSend('and round the corners');
      await chat.wait({ ack: 1 });
      expect(chat.view().status.workingIn).toBeUndefined();
      chat.dispose();
    });

    it('New topic while the agent works: its answers go to the topic asked in, a note in the new one', async () => {
      const { store, chats } = memoryStore();
      const events: ChatEvent[] = [];
      const chat = new ChatSession({ waitSec: 60, store, emit: (e) => events.push(e) });
      await chat.projectShown('/cad');
      listened(chat);
      chat.userSend('make the hole 8 mm');
      await chat.wait({});
      expect(await chat.newChat()).toBe(true);
      events.length = 0;
      chat.agentProgress({ text: 'Editing' });
      chat.agentSend({ text: 'Done: 8 mm' });
      chat.agentSend({ text: 'Also exported v2' });
      const ref = {
        modelId: 'm1',
        file: 'bracket.step',
        path: '/cad/bracket.step',
        commentId: 'c1',
        n: 1,
        title: 'Hole',
      };
      chat.post({ kind: 'replied', text: 'Widened', ref });
      chat.agentSummary({ text: 'Hole 8 mm' });
      await chat.saved;
      const old = chats.get('/cad')?.[0];
      expect(old?.lines.map((l) => l.kind)).toEqual([
        'user',
        'progress',
        'agent',
        'agent',
        'replied',
        'summary',
      ]);
      // One note in the shown (new) topic for the run of answers, opening the old one.
      expect(chat.view().entries.map((e) => [e.kind, e.text, e.topic])).toEqual([
        [
          'elsewhere',
          'Answered in topic “make the hole 8 mm”',
          { title: 'make the hole 8 mm', chatId: 'chat1' },
        ],
      ]);
      // The window gets the old topic's lines tagged with it (live when open, else counted).
      const tagged = events.filter((e) => e.kind === 'entry' && e.chatId === 'chat1');
      expect(tagged).toHaveLength(5);
      // For the agent, "current" is the topic it answers in.
      const h = await chat.history({});
      expect(h.topic).toMatchObject({ id: 'chat1', current: true });
      expect(h.lines.map((l) => l.text)).toContain('Done: 8 mm');
      // The user asks in the new topic: answers go there, no note.
      chat.userSend('round the corners');
      await chat.wait({ ack: 1 });
      chat.agentSend({ text: 'Rounded' });
      expect(chat.view().entries.map((e) => e.kind)).toEqual(['elsewhere', 'user', 'agent']);
      chat.dispose();
    });

    it('another project shown meanwhile: the answer is saved in the project asked in; the note names it', async () => {
      const { store, chats, elsewhere } = memoryStore();
      const events: ChatEvent[] = [];
      const chat = new ChatSession({ waitSec: 60, store, emit: (e) => events.push(e) });
      await chat.projectShown('/home/cad');
      listened(chat);
      chat.userSend('thicker wall');
      await chat.wait({});
      await chat.projectShown('/home/other');
      events.length = 0;
      chat.agentSend({ text: 'Wall is 3 mm' });
      await chat.saved;
      expect(chats.get('/home/cad')?.[0]?.lines.map((l) => l.text)).toEqual([
        'thicker wall',
        'Wall is 3 mm',
      ]);
      expect(chat.view().entries.map((e) => e.topic)).toEqual([
        { title: 'thicker wall', project: 'cad' },
      ]);
      // Another project's lines never reach the window as lines of an earlier topic.
      expect(events.some((e) => e.kind === 'entry' && e.chatId !== undefined)).toBe(false);
      // It is open in another app: the line waits, and is written once that project is shown.
      elsewhere.times = 1;
      chat.agentSend({ text: 'And the fillet' });
      await chat.saved;
      expect(chats.get('/home/cad')?.[0]?.lines).toHaveLength(2);
      await chat.projectShown('/home/cad');
      await chat.saved;
      expect(chats.get('/home/cad')?.[0]?.lines.map((l) => [l.seq, l.text])).toEqual([
        [1, 'thicker wall'],
        [2, 'Wall is 3 mm'],
        [3, 'And the fillet'],
      ]);
      expect(chat.view().entries.map((e) => e.text)).toEqual([
        'thicker wall',
        'Wall is 3 mm',
        'And the fillet',
      ]);
      chat.userSend('thanks');
      expect(chat.view().entries.at(-1)?.seq).toBe(4);
      chat.dispose();
    });

    it('New chat: a new file from the next message; the old one is listed, read back', async () => {
      const { store, chats } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/cad');
      listened(chat);
      expect(await chat.newChat()).toBe(false); // nothing in it yet
      chat.userSend('first chat');
      chat.post({ kind: 'event', text: 'Opened b.step', path: '/cad/b.step' });
      expect(await chat.newChat()).toBe(true);
      // The event since the last message moves along to the new chat.
      expect(chat.view().entries.map((e) => [e.seq, e.kind])).toEqual([[1, 'event']]);
      expect(chat.view().chatId).toBeUndefined();
      chat.userSend('second chat');
      await chat.saved;
      expect(chats.get('/cad')?.map((c) => c.lines.map((l) => l.text))).toEqual([
        ['first chat'],
        ['Opened b.step', 'second chat'],
      ]);
      const list = await chat.list();
      expect(list.map((c) => [c.title, c.current])).toEqual([
        ['second chat', true],
        ['first chat', false],
      ]);
      expect((await chat.read('chat1', undefined)).entries.map((e) => e.text)).toEqual([
        'first chat',
      ]);
      chat.dispose();
    });

    it('New chat needs a project; the list is empty without one', async () => {
      const { store } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      listened(chat);
      chat.post({ kind: 'event', text: 'Opened b.step', path: '/cad/b.step' });
      expect(await chat.newChat()).toBe(false);
      expect(await chat.list()).toEqual([]);
      chat.dispose();
    });

    it("a read-only project's chat is kept for the app session, not saved", async () => {
      const { store, chats } = memoryStore(new Set(['/ro']));
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/ro');
      listened(chat);
      chat.userSend('kept in memory');
      await chat.saved;
      expect(chat.view().unsaved).toBe(true);
      expect(chats.get('/ro')).toBeUndefined();
      await chat.projectShown('/cad');
      expect(chat.view().entries).toEqual([]);
      await chat.projectShown('/ro');
      expect(chat.view().entries.map((e) => e.text)).toEqual(['kept in memory']);
      chat.dispose();
    });

    it('adds wait for a project switch in progress', async () => {
      const { store, chats } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      listened(chat);
      void chat.projectShown('/a');
      void chat.projectShown('/b');
      await chat.ready;
      chat.userSend('lands in b');
      await chat.saved;
      expect(chats.get('/a')).toBeUndefined();
      expect(chats.get('/b')?.[0]?.lines.map((l) => l.text)).toEqual(['lands in b']);
      chat.dispose();
    });

    it('lines that reached the store after a project switch are written when it is shown again', async () => {
      const { store, chats, elsewhere } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/a');
      listened(chat);
      elsewhere.times = 1; // project B became current just before the write
      chat.userSend('for a');
      await chat.projectShown('/b');
      expect(chats.get('/a')).toBeUndefined();
      chat.userSend('for b');
      await chat.projectShown('/a');
      await chat.saved;
      expect(chats.get('/a')?.[0]?.lines.map((l) => l.text)).toEqual(['for a']);
      expect(chat.view().unsaved).toBeUndefined(); // still saving
      chat.userSend('more for a');
      await chat.saved;
      expect(chats.get('/a')?.[0]?.lines.map((l) => [l.seq, l.text])).toEqual([
        [1, 'for a'],
        [2, 'more for a'],
      ]);
      expect(chats.get('/b')?.[0]?.lines.map((l) => l.text)).toEqual(['for b']);
      chat.dispose();
    });

    it('kept lines move after lines another app copy wrote to the same chat meanwhile', async () => {
      const { store, chats, elsewhere } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/a');
      listened(chat);
      chat.userSend('first');
      await chat.saved;
      elsewhere.times = 1;
      chat.userSend('kept');
      await chat.projectShown('/b');
      // Another copy appends seq 2 and 3 to chat1 of /a.
      const other = { kind: 'user' as const, at: 0 };
      chats
        .get('/a')?.[0]
        ?.lines.push({ ...other, seq: 2, text: 'x' }, { ...other, seq: 3, text: 'y' });
      await chat.projectShown('/a');
      await chat.saved;
      expect(chats.get('/a')?.[0]?.lines.map((l) => [l.seq, l.text])).toEqual([
        [1, 'first'],
        [2, 'x'],
        [3, 'y'],
        [4, 'kept'],
      ]);
      chat.dispose();
    });

    it('a read-only project has one chat: New chat is refused', async () => {
      const { store } = memoryStore(new Set(['/ro']));
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/ro');
      listened(chat);
      chat.userSend('kept');
      await chat.saved;
      expect(await chat.newChat()).toBe(false);
      expect(chat.view().entries.map((e) => e.text)).toEqual(['kept']);
      chat.dispose();
    });
  });

  describe('agent connections', () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const event = {
      kind: 'event',
      text: 'Opened bracket.step',
      path: '/cad/bracket.step',
      modelId: 'abc123',
    };

    it('hello: the status names the start (agent, folder) without a chat line; bad params refused', async () => {
      const events: ChatEvent[] = [];
      const chat = new ChatSession({ waitSec: 60, emit: (e) => events.push(e), now: () => 9 });
      await chat.projectShown('/cad');
      expect(chat.hello({ connection: 'conn00001', agent: 'claude-code', folder: '/cad' })).toEqual(
        {
          ok: true,
        },
      );
      expect(chat.view().status).toMatchObject({
        state: 'none',
        started: { connection: 'conn00001', agent: 'claude-code', folder: '/cad', at: 9 },
      });
      expect(events.at(-1)).toMatchObject({ kind: 'status', status: { started: { at: 9 } } });
      expect(chat.view().entries).toEqual([]);
      expect(() => chat.hello({ connection: 'BAD' })).toThrow();
      void chat.wait({ connection: 'conn00001' }, AbortSignal.abort());
      expect(chat.view().status.started).toMatchObject({ listened: true });
      chat.dispose();
    });

    it('a new connection: joined line, catch-up at once, folded line; acked → normal waits', async () => {
      const { store } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/cad');
      chat.post(event);
      const r = await chat.wait({ agent: 'claude-code', connection: 'conn00001' });
      expect(r).toMatchObject({ state: 'message', messages: [] });
      if (r.state !== 'message') throw new Error('no message');
      expect(r.catchUp).toMatchObject({
        shown: { modelId: 'abc123', file: 'bracket.step' },
        modelSwitches: ['Opened bracket.step'],
        topic: { lines: 2, latest: [] },
      });
      expect(chat.view().entries.map((e) => e.kind)).toEqual(['event', 'joined', 'caught-up']);
      const joined = chat.view().entries[1];
      expect(joined).toMatchObject({ text: 'Claude Code connected', connection: 'conn00001' });
      expect(chat.view().entries[2]?.detail).toMatch(/On screen: bracket\.step/);
      expect(chat.view().status).toMatchObject({ connection: 'conn00001', railFrom: 2 });
      // Acked: the next wait waits; a message comes without a catch-up.
      const next = chat.wait({ connection: 'conn00001', ack: r.delivery });
      chat.userSend('Make it 6 mm');
      const m = await next;
      expect(m).toMatchObject({
        state: 'message',
        messages: [{ text: 'Make it 6 mm', shown: { modelId: 'abc123', file: 'bracket.step' } }],
      });
      expect(m).not.toHaveProperty('catchUp');
      chat.dispose();
    });

    it('a catch-up never acked comes again (one folded line); queued messages go with it', async () => {
      const chat = new ChatSession({ waitSec: 60 });
      await chat.projectShown('/cad');
      listened(chat); // an earlier agent: the message waits for the next one
      chat.userSend('waiting for you');
      const first = await chat.wait({ connection: 'conn00001' });
      expect(first).toMatchObject({ state: 'message', messages: [{ text: 'waiting for you' }] });
      expect(first.state === 'message' && first.catchUp?.topic.latest).toEqual([]);
      // The rail starts at the message it was handed, before its joined line.
      expect(chat.view().status.railFrom).toBe(1);
      const again = await chat.wait({ connection: 'conn00001' }); // no ack
      expect(again.state === 'message' && again.catchUp).toBeTruthy();
      expect(again).toMatchObject({ messages: [{ text: 'waiting for you' }] });
      expect(chat.view().entries.filter((e) => e.kind === 'caught-up')).toHaveLength(1);
      chat.dispose();
    });

    it('another connection takes over: the old one stopped listening, the new one connected', async () => {
      const chat = new ChatSession({ waitSec: 60 });
      const a = await chat.wait({ agent: 'claude-code', connection: 'conn0000a' });
      void chat.wait({ connection: 'conn0000a', ack: a.state === 'message' ? a.delivery : 0 });
      await chat.wait({ connection: 'conn0000b' });
      expect(chat.view().entries.map((e) => [e.kind, e.connection])).toEqual([
        ['joined', 'conn0000a'],
        ['caught-up', 'conn0000a'],
        ['left', 'conn0000a'],
        ['joined', 'conn0000b'],
        ['caught-up', 'conn0000b'],
      ]);
      expect(chat.view().status.connection).toBe('conn0000b');
      chat.dispose();
    });

    it("a take-over catch-up counts from the old agent's last activity, not its leave line", async () => {
      let t = 1000;
      const chat = new ChatSession({ waitSec: 60, now: () => t });
      await chat.wait({ connection: 'conn0000a' });
      chat.agentSend({ text: 'Done' }); // at 1000
      t = 2000;
      chat.post({ kind: 'event', text: 'Opened b.step', path: '/cad/b.step', modelId: 'b1' });
      t = 3000;
      const b = await chat.wait({ connection: 'conn0000b' });
      expect(b.state === 'message' && b.catchUp).toMatchObject({
        since: new Date(1000).toISOString(),
        modelSwitches: ['Opened b.step'],
      });
      chat.dispose();
    });

    it('quiet for a while → "stopped listening"; the same connection back → "listening again"', async () => {
      vi.useFakeTimers();
      const chat = new ChatSession({ waitSec: 60, graceSec: 1, leaveAfterSec: 5 });
      const r = await chat.wait({ agent: 'claude-code', connection: 'conn00001' });
      const ack = r.state === 'message' ? r.delivery : 0;
      const w = chat.wait({ connection: 'conn00001', ack });
      await vi.advanceTimersByTimeAsync(60_000); // the wait ends: "waiting"
      expect(await w).toMatchObject({ state: 'waiting' });
      await vi.advanceTimersByTimeAsync(2_000); // grace over: not listening
      expect(chat.view().entries.at(-1)?.kind).toBe('caught-up');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(chat.view().entries.at(-1)).toMatchObject({
        kind: 'left',
        text: 'Claude Code stopped listening',
      });
      expect(chat.view().status.connection).toBeUndefined();
      void chat.wait({ connection: 'conn00001', ack });
      expect(chat.view().entries.at(-1)).toMatchObject({
        kind: 'joined',
        text: 'Claude Code is listening again',
      });
      expect(chat.view().status.connection).toBe('conn00001');
      chat.dispose();
    });

    it('a catch-up tells what changed since an agent was last heard, with its summary', async () => {
      let t = 1000;
      const { store } = memoryStore();
      const asked: unknown[] = [];
      store.facts = (folder, since, chatId) => {
        asked.push([folder, since, chatId]);
        return Promise.resolve({
          name: 'cad',
          parts: [{ file: 'bracket_v2.step', newVersions: ['bracket_v2.step'], openComments: 2 }],
          summary: { of: 'this topic' as const, text: 'Pin made Ø4.8' },
        });
      };
      const chat = new ChatSession({ waitSec: 60, store, now: () => t });
      await chat.projectShown('/cad');
      listened(chat);
      chat.userSend('Make the pin Ø4.8');
      chat.agentSend({ text: 'Done' }); // at 1000
      await chat.saved;
      t = 2000;
      chat.post({ ...event, text: 'Opened bracket_v2.step', path: '/cad/bracket_v2.step' });
      const r = await chat.wait({ connection: 'conn00002' });
      expect(asked).toEqual([['/cad', 1000, 'chat1']]);
      expect(r.state === 'message' && r.catchUp).toMatchObject({
        project: 'cad',
        since: new Date(1000).toISOString(),
        parts: [{ file: 'bracket_v2.step', newVersions: ['bracket_v2.step'], openComments: 2 }],
        modelSwitches: ['Opened bracket_v2.step'],
        summary: { of: 'this topic', text: 'Pin made Ø4.8' },
        // The queued message comes in messages[], not again here.
        topic: { title: 'Make the pin Ø4.8', latest: [{ from: 'agent', text: 'Done' }] },
      });
      expect(r).toMatchObject({ messages: [{ text: 'Make the pin Ø4.8' }] });
      const line = chat.view().entries.at(-1);
      expect(line?.text).toBe(
        'Caught up · bracket_v2.step · 2 open comments · last message · summary',
      );
      chat.dispose();
    });

    it('join and catch-up lines alone are not written (they wait for a message)', async () => {
      const { store, chats } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/cad');
      await chat.wait({ connection: 'conn00001' });
      await chat.saved;
      expect(chats.get('/cad')).toBeUndefined();
      chat.userSend('hello');
      await chat.saved;
      expect(chats.get('/cad')?.[0]?.lines.map((l) => l.kind)).toEqual([
        'joined',
        'caught-up',
        'user',
      ]);
      chat.dispose();
    });

    it('get_chat_history pages the current topic (held lines, then saved ones) and lists topics', async () => {
      const { store } = memoryStore();
      const chat = new ChatSession({ waitSec: 60, store });
      await chat.projectShown('/cad');
      listened(chat);
      for (let i = 1; i <= 5; i++) chat.userSend(`m${String(i)}`);
      chat.agentProgress({ text: 'step' });
      await chat.saved;
      const first = await chat.history({ limit: 2 });
      expect(first.lines.map((l) => l.text)).toEqual(['m5']); // progress lines left out
      expect(first).toMatchObject({
        topic: { id: 'chat1', title: 'm1', current: true },
        hasOlder: true,
      });
      expect(first.topics).toEqual([
        { id: 'chat1', title: 'm1', lines: 6, last: new Date(2).toISOString() },
      ]);
      const older = await chat.history({ before: 4, limit: 10 });
      expect(older.lines.map((l) => l.text)).toEqual(['m1', 'm2', 'm3']);
      expect(older.topics).toBeUndefined();
      await chat.newChat();
      chat.userSend('new topic');
      await chat.saved;
      const earlier = await chat.history({ topic: 'chat1', limit: 1 });
      expect(earlier).toMatchObject({ topic: { id: 'chat1', current: false }, hasOlder: true });
      await expect(chat.history({ limit: 0 })).rejects.toThrow();
      chat.dispose();
    });

    it("the agent's summary is a folded line saved with the topic", () => {
      const chat = new ChatSession({ waitSec: 60 });
      void chat.wait({ agent: 'claude-code' });
      chat.agentSummary({ text: 'Pin Ø4.8 done; lid open' });
      expect(chat.view().entries.at(-1)).toMatchObject({
        kind: 'summary',
        detail: 'Pin Ø4.8 done; lid open',
        agent: 'claude-code',
      });
      expect(() => chat.agentSummary({ text: 'x'.repeat(4001) })).toThrow();
      chat.dispose();
    });

    it('no model on screen after the window reloads', async () => {
      const chat = new ChatSession({ waitSec: 60 });
      await chat.projectShown('/cad');
      chat.post(event);
      chat.modelHidden();
      void chat.wait({});
      const m = chat.wait({});
      chat.userSend('hi');
      expect(await m).toMatchObject({ messages: [{ text: 'hi' }] });
      expect(await m).not.toHaveProperty('messages.0.shown');
      chat.dispose();
    });
  });
});
