/**
 * The chat for this app session: the chat the window shows + the message queue the agent listens
 * to. Lines are saved in the shown project through a {@link ChatStore} (`chats/<id>.jsonl`):
 * - a chat is written once it holds a message: model events (and progress lines) alone write
 *   nothing; they wait for the next message and go out with it;
 * - the user types only with a project shown and once an agent has listened this app session (the
 *   window locks its message box until then); lines added while no project is shown (model events,
 *   an agent's join line) are shown only, never saved;
 * - a project that can't be written keeps its chat until the app quits.
 * Agent connections (the MCP server's id per start): a `joined` line when one starts listening, a
 * `left` line when it goes quiet; its first wait gets a catch-up at once (where things stand, never
 * the transcript) and a folded `caught-up` line shows what was passed. Every message names the
 * model on screen.
 * No Electron here (tests); `chat-wiring.ts` connects it to the bridge, the window and the project.
 */
import {
  chatHistoryParamsSchema,
  chatPostSchema,
  chatProgressParamsSchema,
  chatSendParamsSchema,
  chatSummaryParamsSchema,
  chatTitle,
  chatHelloParamsSchema,
  chatWaitParamsSchema,
  DEFAULT_CHAT_HISTORY_PAGE,
  MAX_CHAT_ABOUT_LENGTH,
  MAX_CHAT_MESSAGE_LENGTH,
  parseParams,
  type ChatCatchUp,
  type ChatHistoryResult,
  type ChatShownModel,
  type ChatWaitResult,
} from '@third-wheel/core';
import {
  agentLabel,
  isChatMessage,
  isQuietLine,
  type ChatAppendResult,
  type ChatEntry,
  type ChatEvent,
  type ChatListItem,
  type ChatPage,
  type ChatProjectFacts,
  type ChatStarted,
  type ChatStatus,
  type ChatTopicRef,
  type ChatView,
} from '../shared/chat.js';
import { ChatQueue, type ChatQueueOptions, type ChatQueueSnapshot } from './chat-queue.js';

/** Oldest shown entries are dropped beyond this (they stay in the saved chat: paged back). */
export const MAX_CHAT_ENTRIES = 1000;
/** Lines the window gets when a chat is opened, and per page back. */
export const CHAT_WINDOW = 200;
/** An agent quiet ("not listening") this long gets its "stopped listening" line, seconds. */
export const CHAT_LEAVE_AFTER_SECONDS = 120;
/** Latest messages a catch-up carries, and how long each may be (characters). */
export const CATCH_UP_LINES = 6;
export const CATCH_UP_LINE_CHARS = 300;
/** Longest line text `chat_history` returns, characters. */
const HISTORY_LINE_CHARS = 2000;

/** Where chats are saved (the shown project); window-shaped entries. */
export interface ChatStore {
  /** The project's current chat: its latest `limit` lines and the highest `seq` in it. */
  current(
    folder: string,
    limit: number,
  ): Promise<{ chatId?: string; entries: ChatEntry[]; hasOlder: boolean; lastSeq: number }>;
  /** Append lines to `chatId` (listed when new, titled `title`). */
  append(
    folder: string,
    chatId: string,
    entries: readonly ChatEntry[],
    title: string,
  ): Promise<ChatAppendResult>;
  /** The project's chats, in index order (the last is the current one). */
  list(folder: string): Promise<Omit<ChatListItem, 'current'>[]>;
  /** Up to `limit` lines before `seq` `before` (latest when undefined). */
  read(
    folder: string,
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<ChatPage>;
  /** A new chat id (file name). */
  newId(): string;
  /**
   * What a new agent connection is told about the project (versions after `since` ms); the model
   * file `shown` counts as a part even when the project doesn't list it yet.
   */
  facts?(
    folder: string,
    since: number | undefined,
    chatId: string | undefined,
    shown?: string,
  ): Promise<ChatProjectFacts | undefined>;
}

export interface ChatSessionOptions extends Omit<ChatQueueOptions, 'onChange'> {
  /** Every change the window should show. */
  readonly emit?: (event: ChatEvent) => void;
  readonly store?: ChatStore;
  /** A save failed (shown once per chat). */
  readonly onError?: (err: unknown) => void;
  /** Quiet this long → "stopped listening" line, seconds ({@link CHAT_LEAVE_AFTER_SECONDS}). */
  readonly leaveAfterSec?: number;
}

/** An agent connection (one MCP server start). */
interface Connection {
  readonly id: string;
  /** It went quiet ("stopped listening" line written); a new wait from it says "listening again". */
  left: boolean;
  /** The topic it joined in and the first line it received there (the rail starts at it). */
  readonly railLog: Log;
  readonly railFrom: number;
}

/** The chat shown: one project's current chat, or the conversation before any project. */
interface Log {
  readonly folder: string | undefined;
  chatId: string | undefined;
  entries: ChatEntry[];
  /** Not written yet: events waiting for a message (while no project is shown: never written). */
  pending: ChatEntry[];
  hasOlder: boolean;
  /** The project couldn't be written: kept until the app quits. */
  unsaved: boolean;
  nextSeq: number;
}

function emptyLog(folder: string | undefined): Log {
  return {
    folder,
    chatId: undefined,
    entries: [],
    pending: [],
    hasOlder: false,
    unsaved: false,
    nextSeq: 1,
  };
}

export class ChatSession {
  private log: Log = emptyLog(undefined);
  /** Chats of read-only projects, kept for this app session (by folder). */
  private readonly kept = new Map<string, Log>();
  /** Queue message id → the entry it shows as (queued marks in the window). */
  private readonly queuedAs = new Map<number, { log: Log; seq: number }>();
  /**
   * The chat whose messages the agent took last: its "…" shows only there, and the agent's answers,
   * progress lines and summary go there (see {@link answerLog}).
   */
  private takenFrom: Log | undefined;
  private readonly queue: ChatQueue;
  private readonly now: () => number;
  /** The listening agent's own name (last wait that named it). */
  private agent: string | undefined;
  /** Project switches, one after the other; adds wait for it (`ready`). */
  private switching: Promise<void> = Promise.resolve();
  /** Writes, one after the other. */
  private writing: Promise<unknown> = Promise.resolve();
  /** The model on screen (from the window's model event lines). */
  private shown: ChatShownModel | undefined;
  /** The shown model's full path (for the catch-up). */
  private shownPath: string | undefined;
  /** The latest agent connection. */
  private conn: Connection | undefined;
  /** The latest MCP server start that said hello (`chat_hello`), listening or not. */
  private started: ChatStarted | undefined;
  /** Its catch-up hasn't reached it yet (sent again until a wait acks the delivery). */
  private catchUpDue = false;
  private catchUpDelivery: number | undefined;
  private catchUpShown = false;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ChatSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.queue = new ChatQueue({
      ...options,
      onChange: (s) => {
        this.watchLeave(s);
        options.emit?.({ kind: 'status', status: this.status(s) });
      },
    });
  }

  get waitSec(): number {
    return this.queue.waitSec;
  }

  set waitSec(sec: number) {
    this.queue.waitSec = sec;
  }

  /** Settles when a project switch in progress is done (adds after it land in the new chat). */
  get ready(): Promise<void> {
    return this.switching;
  }

  /** Settles when every line added so far was handed to the store. */
  get saved(): Promise<unknown> {
    return this.writing;
  }

  view(): ChatView {
    const log = this.log;
    return {
      status: this.status(this.queue.snapshot()),
      entries: [...log.entries],
      hasOlder: log.hasOlder,
      inProject: log.folder !== undefined,
      ...(log.chatId ? { chatId: log.chatId } : {}),
      ...(log.unsaved ? { unsaved: true as const } : {}),
      ...(log.folder === undefined ? {} : { project: log.folder }),
    };
  }

  // --- project and chats ------------------------------------------------------------------------

  /** The shown project changed (undefined: none). Its current chat is shown. */
  projectShown(folder: string | undefined): Promise<void> {
    if (folder === undefined) {
      this.shown = undefined;
      this.shownPath = undefined;
    }
    this.switching = this.switching
      .then(() => this.switchTo(folder))
      .catch((err: unknown) => {
        this.options.onError?.(err);
      });
    return this.switching;
  }

  private async switchTo(folder: string | undefined): Promise<void> {
    const before = this.log;
    if (before.folder === folder) return;
    await this.writing.catch(() => undefined);
    // Kept for this app session: a read-only project's chat, and lines a write couldn't place
    // (the project was switched while they were on their way) — written when it is shown again.
    if (
      before.folder !== undefined &&
      ((before.unsaved && before.entries.some(isChatMessage)) || before.pending.some(isChatMessage))
    )
      this.kept.set(before.folder, before);
    let next: Log;
    const store = this.options.store;
    if (folder === undefined) next = emptyLog(undefined);
    else if (this.kept.has(folder)) {
      next = this.kept.get(folder) as Log;
      // Not read-only: shown again from the files next time (written below by `flush`).
      if (!next.unsaved) {
        this.kept.delete(folder);
        if (store) await this.renumberAfter(next, store);
      }
    } else if (!store) next = emptyLog(folder);
    else {
      const c = await store.current(folder, CHAT_WINDOW);
      next = {
        ...emptyLog(folder),
        entries: c.entries,
        hasOlder: c.hasOlder,
        nextSeq: c.lastSeq + 1,
        ...(c.chatId ? { chatId: c.chatId } : {}),
      };
    }
    this.log = next;
    this.takeOver(next);
    this.trim(next);
    this.flush(next);
    this.options.emit?.({ kind: 'reset', view: this.view() });
  }

  /**
   * `next` is shown now. The topic the agent answers in may be held as an older copy (its project
   * was shown before): lines that couldn't be written yet move into `next` when it is the same chat,
   * or are written now that their project is shown.
   */
  private takeOver(next: Log): void {
    const t = this.takenFrom;
    if (!t || t === next || t.folder === undefined || t.folder !== next.folder) return;
    if (!this.sameChat(t, next)) {
      this.flush(t);
      return;
    }
    for (const e of t.pending.filter((x) => !isQuietLine(x))) {
      const moved = { ...e, seq: next.nextSeq++ };
      next.entries.push(moved);
      next.pending.push(moved);
    }
    t.pending = [];
    this.takenFrom = next;
  }

  /**
   * Lines kept for a project while another was shown: if another app copy wrote to the same chat
   * meanwhile, they move after its last line (no two lines with one `seq`).
   */
  private async renumberAfter(log: Log, store: ChatStore): Promise<void> {
    const first = log.pending[0]?.seq;
    if (log.folder === undefined || log.chatId === undefined || first === undefined) return;
    const c = await store.current(log.folder, 1);
    if (c.chatId !== log.chatId || c.lastSeq < first) return;
    const shift = c.lastSeq + 1 - first;
    const moved = new Map<number, ChatEntry>();
    for (const e of log.pending) moved.set(e.seq, { ...e, seq: e.seq + shift });
    log.pending = log.pending.map((e) => moved.get(e.seq) ?? e);
    log.entries = log.entries.map((e) => moved.get(e.seq) ?? e);
    for (const q of this.queuedAs.values()) if (q.log === log && moved.has(q.seq)) q.seq += shift;
    log.nextSeq += shift;
  }

  /**
   * "+ New chat": the next messages go to a new chat (saved with its first message). Model events
   * since the last message move along. False when the shown chat has no message yet or no project
   * is shown.
   */
  async newChat(): Promise<boolean> {
    await this.switching;
    const log = this.log;
    // A read-only project keeps its one chat in memory: a new one would drop it.
    if (log.folder === undefined || log.unsaved || !log.entries.some(isChatMessage)) return false;
    const next = emptyLog(log.folder);
    for (const e of log.pending.filter((x) => x.kind === 'event')) {
      const moved = { ...e, seq: next.nextSeq++ };
      next.entries.push(moved);
      next.pending.push(moved);
    }
    log.pending = [];
    this.log = next;
    this.options.emit?.({ kind: 'reset', view: this.view() });
    return true;
  }

  /** The window reloaded or closed: no model is on screen until its next model event. */
  modelHidden(): void {
    this.shown = undefined;
    this.shownPath = undefined;
  }

  /** 🕘: the shown project's chats, newest first. */
  async list(): Promise<ChatListItem[]> {
    await this.switching;
    const { folder, chatId } = this.log;
    const store = this.options.store;
    if (folder === undefined || !store) return [];
    await this.writing.catch(() => undefined);
    const chats = await store.list(folder);
    return chats.map((c) => ({ ...c, current: c.id === chatId })).reverse();
  }

  /** Lines of a chat of the shown project (a past one, or older lines of the current one). */
  async read(chatId: unknown, before: unknown): Promise<ChatPage> {
    const store = this.options.store;
    const folder = this.log.folder;
    if (typeof chatId !== 'string' || folder === undefined || !store)
      return { entries: [], hasOlder: false };
    const b =
      typeof before === 'number' && Number.isInteger(before) && before > 0 ? before : undefined;
    await this.writing.catch(() => undefined);
    return store.read(folder, chatId, b, CHAT_WINDOW);
  }

  // --- adding -----------------------------------------------------------------------------------

  /**
   * The user's message from the chat box; undefined when empty or too long, with no project shown
   * or before any agent listened this app session (the window's box is locked then).
   */
  userSend(text: unknown): ChatEntry | undefined {
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_CHAT_MESSAGE_LENGTH)
      return undefined;
    if (this.log.folder === undefined || this.queue.state === 'none') return undefined;
    const entry = this.add('user', text);
    const message = this.queue.send(text, undefined, undefined, this.shown);
    this.queuedAs.set(message.id, { log: this.log, seq: entry.seq });
    this.statusChanged();
    return entry;
  }

  /**
   * The window adds a thread reply / sent review (both go to the agent), the agent's reply under a
   * comment or a model event (shown only). Thread replies and reviews need a chat agent (one
   * listened this app session): undefined otherwise, or when the post is malformed or too big.
   */
  post(input: unknown): ChatEntry | undefined {
    const parsed = chatPostSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const p = parsed.data;
    if (p.kind === 'replied')
      return this.answer('replied', p.text, { ref: p.ref, ...this.named() });
    if (p.kind === 'event') {
      if (p.modelId) {
        this.shown = { modelId: p.modelId, file: baseName(p.path) };
        this.shownPath = p.path;
      }
      return this.add('event', p.text, { path: p.path });
    }
    if (this.queue.state === 'none') return undefined;
    if (JSON.stringify(p.about).length > MAX_CHAT_ABOUT_LENGTH) return undefined;
    const entry = this.add(p.kind, p.text, p.kind === 'thread' ? { ref: p.ref } : {});
    const message = this.queue.send(p.text, undefined, p.about, this.shown);
    this.queuedAs.set(message.id, { log: this.log, seq: entry.seq });
    this.statusChanged();
    return entry;
  }

  /**
   * Bridge `chat_hello`: an agent just started the MCP server (the Connect pop-up shows
   * "connected" and its folder). No chat line: "connected" lines come with the first wait.
   */
  hello(params: unknown): { ok: true } {
    const parsed = parseParams(chatHelloParamsSchema, params, 'chat_hello');
    this.started = {
      connection: parsed.connection,
      at: this.now(),
      ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
      ...(parsed.folder === undefined ? {} : { folder: parsed.folder }),
    };
    this.statusChanged();
    return { ok: true };
  }

  /**
   * Bridge `chat_wait`. A new connection (or one whose catch-up never arrived) is answered at once
   * with its catch-up and whatever is queued.
   */
  async wait(params: unknown, signal?: AbortSignal): Promise<ChatWaitResult> {
    const parsed = parseParams(chatWaitParamsSchema, params, 'chat_wait');
    const changed = parsed.agent !== undefined && parsed.agent !== this.agent;
    if (parsed.agent !== undefined) this.agent = parsed.agent;
    const id = parsed.connection;
    if (id !== undefined) this.connect(id);
    // The queue reports its own changes; a new name alone must reach the window too.
    if (changed) this.statusChanged();
    const c = this.conn;
    const mine = c !== undefined && c.id === id;
    if (mine && this.catchUpDue && parsed.ack !== undefined && parsed.ack === this.catchUpDelivery)
      this.catchUpDue = false;
    if (!mine || !this.catchUpDue) return this.queue.wait(parsed, signal);
    await this.switching;
    const catchUp = await this.catchUp(c);
    if (signal?.aborted || this.conn !== c) return { state: 'replaced', waitedSec: 0 };
    const result = await this.queue.wait(parsed, signal, true);
    if (result.state !== 'message') return result;
    this.catchUpDelivery = result.delivery;
    if (!this.catchUpShown) {
      this.catchUpShown = true;
      this.add('caught-up', catchUp.line, { connection: c.id, detail: catchUp.detail });
    }
    return { ...result, catchUp: catchUp.data };
  }

  /**
   * Bridge `chat_history`: lines of a topic for the agent, compact, latest page first. Its current
   * topic is the one it answers in (where its latest message came from), not always the shown one.
   */
  async history(params: unknown): Promise<ChatHistoryResult> {
    const parsed = parseParams(chatHistoryParamsSchema, params, 'chat_history');
    await this.switching;
    const log = this.answerLog();
    const store = this.options.store;
    const folder = log.folder;
    const limit = parsed.limit ?? DEFAULT_CHAT_HISTORY_PAGE;
    const before = parsed.before;
    const current = parsed.topic === undefined || parsed.topic === log.chatId;
    await this.writing.catch(() => undefined);
    const saved = folder !== undefined && store ? await store.list(folder) : [];
    let entries: ChatEntry[] = [];
    let hasOlder = false;
    if (current) {
      const held = log.entries.filter((e) => before === undefined || e.seq < before);
      entries = held.slice(-limit);
      hasOlder = held.length > limit || log.hasOlder;
      if (entries.length < limit && log.hasOlder && log.chatId && store && folder !== undefined) {
        const from = entries[0]?.seq ?? before;
        const page = await store.read(folder, log.chatId, from, limit - entries.length);
        entries = [...page.entries, ...entries];
        hasOlder = page.hasOlder;
      }
    } else if (store && folder !== undefined && saved.some((c) => c.id === parsed.topic)) {
      const page = await store.read(folder, parsed.topic as string, before, limit);
      entries = [...page.entries];
      hasOlder = page.hasOlder;
    }
    const info = saved.find((c) => c.id === (current ? log.chatId : parsed.topic));
    const title = current
      ? (info?.title ?? chatTitle(log.entries.find(isChatMessage)?.text ?? ''))
      : (info?.title ?? '');
    const topicId = current ? log.chatId : parsed.topic;
    return {
      topic: { ...(topicId ? { id: topicId } : {}), title: title || 'Topic', current },
      lines: entries
        .filter((e) => e.kind !== 'progress' && e.kind !== 'caught-up')
        .map((e) => ({
          seq: e.seq,
          kind: e.kind,
          text: cut(e.kind === 'summary' ? (e.detail ?? e.text) : e.text, HISTORY_LINE_CHARS),
          at: new Date(e.at).toISOString(),
          ...(e.ref ? { ref: `#${String(e.ref.n)}` } : {}),
        })),
      hasOlder,
      ...(before === undefined
        ? {
            topics: [...saved].reverse().map((c) => ({
              id: c.id,
              title: c.title,
              lines: c.entries,
              last: new Date(c.last).toISOString(),
            })),
          }
        : {}),
    };
  }

  /** Bridge `chat_summary`: the agent's own summary of the current topic (shown folded). */
  agentSummary(params: unknown): { ok: true } {
    const { text } = parseParams(chatSummaryParamsSchema, params, 'chat_summary');
    this.add(
      'summary',
      'Saved a summary of this topic',
      { detail: text, ...this.named() },
      this.answerLog(),
    );
    this.queue.agentActivity();
    return { ok: true };
  }

  /** Bridge `chat_send`: the agent's answer. */
  agentSend(params: unknown): { ok: true } {
    const { text } = parseParams(chatSendParamsSchema, params, 'chat_send');
    this.answer('agent', text, this.named());
    this.queue.agentAnswered();
    return { ok: true };
  }

  /** Bridge `chat_progress`: one short line about what the agent does now. */
  agentProgress(params: unknown): { ok: true } {
    const { text } = parseParams(chatProgressParamsSchema, params, 'chat_progress');
    // No note in the shown topic: its "Working on your message in topic …" says where already.
    this.add('progress', text, {}, this.answerLog());
    this.queue.agentActivity();
    return { ok: true };
  }

  /** Any other MCP tool call: the agent is alive (keeps "working"). */
  agentToolCall(): void {
    this.queue.agentToolCall();
  }

  dispose(): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = undefined;
    this.queue.dispose();
  }

  // --- inside -----------------------------------------------------------------------------------

  /** A topic named in a note ("Working on your message in topic …", "Answered in topic …"). */
  private topicRef(l: Log): ChatTopicRef {
    const title = chatTitle(l.entries.find(isChatMessage)?.text ?? '') || 'Topic';
    if (l.folder !== this.log.folder)
      return l.folder === undefined ? { title } : { title, project: baseName(l.folder) };
    return l.chatId === undefined ? { title } : { title, chatId: l.chatId };
  }

  /**
   * The topic the agent answers in: the one its latest message came from (asked before New topic
   * or in another project), else the shown one. A copy read back since stands for it.
   */
  private answerLog(): Log {
    const t = this.takenFrom;
    if (!t || t === this.log) return this.log;
    if (this.sameChat(t, this.log)) return (this.takenFrom = this.log);
    const kept = t.folder === undefined ? undefined : this.kept.get(t.folder);
    if (kept && kept !== t && this.sameChat(t, kept)) return (this.takenFrom = kept);
    return t;
  }

  /**
   * The agent's answer (`agent` / `replied`) goes to the topic it answers in; when that isn't the
   * shown one, the shown topic gets a note "Answered in topic “…”" (once per run of answers).
   */
  private answer(
    kind: 'agent' | 'replied',
    text: string,
    extra: Pick<ChatEntry, 'ref' | 'agent'>,
  ): ChatEntry {
    const target = this.answerLog();
    const entry = this.add(kind, text, extra, target);
    if (target === this.log) return entry;
    const topic = this.topicRef(target);
    const last = this.log.entries.at(-1);
    const same =
      last?.kind === 'elsewhere' &&
      last.topic?.chatId === topic.chatId &&
      last.topic?.project === topic.project &&
      last.topic?.title === topic.title;
    if (!same) this.add('elsewhere', `Answered in topic “${topic.title}”`, { topic });
    return entry;
  }

  /** The same chat, also when it was read back (another project shown and back) as a new `Log`. */
  private sameChat(a: Log, b: Log): boolean {
    return a === b || (a.chatId !== undefined && a.chatId === b.chatId && a.folder === b.folder);
  }

  /** The agent's name for an entry it made. */
  private named(): { agent?: string } {
    return this.agent === undefined ? {} : { agent: this.agent };
  }

  /**
   * A wait came from connection `id`: a new one gets its `joined` line (the one before, if still
   * there, its `left` line) and is due a catch-up; a known one that had gone quiet "listens again".
   */
  private connect(id: string): void {
    const c = this.conn;
    const name = agentLabel(this.agent);
    if (c?.id === id) {
      if (c.left) {
        c.left = false;
        this.add('joined', `${name} is listening again`, { connection: id, ...this.named() });
      }
      return;
    }
    if (c && !c.left) this.leave(c);
    const log = this.log;
    const joined = this.add('joined', `${name} connected`, { connection: id, ...this.named() });
    // Messages queued before it came are handed to it too: the rail starts at the first of them.
    let railFrom = joined.seq;
    for (const q of this.queuedAs.values()) if (q.log === log && q.seq < railFrom) railFrom = q.seq;
    this.conn = { id, left: false, railLog: log, railFrom };
    this.catchUpDue = true;
    this.catchUpDelivery = undefined;
    this.catchUpShown = false;
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = undefined;
  }

  /** The connection went quiet (or another took over): its "stopped listening" line. */
  private leave(c: Connection): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = undefined;
    if (c.left) return;
    c.left = true;
    this.add('left', `${agentLabel(this.agent)} stopped listening`, {
      connection: c.id,
      ...this.named(),
    });
    this.statusChanged();
  }

  /** Stopped → leave at once; not listening for a while → leave; listening again → keep. */
  private watchLeave(s: ChatQueueSnapshot): void {
    const c = this.conn;
    if (!c || c.left) return;
    if (s.state === 'stopped') {
      // After the queue's own change is out (this runs inside it).
      queueMicrotask(() => {
        this.leave(c);
      });
      return;
    }
    if (s.state !== 'not-listening') {
      if (this.leaveTimer) clearTimeout(this.leaveTimer);
      this.leaveTimer = undefined;
      return;
    }
    this.leaveTimer ??= setTimeout(
      () => {
        this.leaveTimer = undefined;
        const state = this.queue.state;
        if (this.conn === c && (state === 'not-listening' || state === 'stopped')) this.leave(c);
      },
      (this.options.leaveAfterSec ?? CHAT_LEAVE_AFTER_SECONDS) * 1000,
    );
  }

  /**
   * When an agent other than `c` was last heard in the shown topic (ms), if ever. `left` lines don't
   * count: they are written later (after a quiet time, or when `c` takes over).
   */
  private lastHeard(c: Connection): number | undefined {
    let at: number | undefined;
    for (const e of this.log.entries) {
      const agentLine =
        e.kind === 'agent' ||
        e.kind === 'replied' ||
        e.kind === 'progress' ||
        e.kind === 'summary' ||
        ((e.kind === 'joined' || e.kind === 'caught-up') && e.connection !== c.id);
      if (agentLine && (at === undefined || e.at > at)) at = e.at;
    }
    return at;
  }

  /** What connection `c` is told on its first wait, and the folded line that shows it. */
  private async catchUp(
    c: Connection,
  ): Promise<{ data: ChatCatchUp; line: string; detail: string }> {
    const log = this.log;
    const since = this.lastHeard(c);
    const store = this.options.store;
    const facts =
      log.folder !== undefined && store?.facts
        ? await store.facts(log.folder, since, log.chatId, this.shownPath).catch(() => undefined)
        : undefined;
    const queued = new Set<number>();
    for (const q of this.queuedAs.values()) if (q.log === log) queued.add(q.seq);
    const switches = log.entries
      .filter((e) => e.kind === 'event' && (since === undefined || e.at > since))
      .map((e) => e.text)
      .slice(-10);
    const latest = log.entries
      .filter((e) => isChatMessage(e) && e.kind !== 'summary' && !queued.has(e.seq))
      .slice(-CATCH_UP_LINES)
      .map((e) => ({
        from: e.kind === 'agent' || e.kind === 'replied' ? ('agent' as const) : ('user' as const),
        text: cut(
          e.kind === 'replied' && e.ref ? `(under #${String(e.ref.n)}) ${e.text}` : e.text,
          CATCH_UP_LINE_CHARS,
        ),
      }));
    const title = chatTitle(log.entries.find(isChatMessage)?.text ?? '');
    const data: ChatCatchUp = {
      ...(facts ? { project: facts.name } : {}),
      ...(this.shown ? { shown: this.shown } : {}),
      ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
      parts: facts?.parts ?? [],
      ...(switches.length ? { modelSwitches: switches } : {}),
      ...(facts?.summary ? { summary: facts.summary } : {}),
      topic: { ...(title ? { title } : {}), lines: log.nextSeq - 1, latest },
    };
    return { data, ...catchUpText(data) };
  }

  private statusChanged(): void {
    this.options.emit?.({ kind: 'status', status: this.status(this.queue.snapshot()) });
  }

  private status(s: ChatQueueSnapshot): ChatStatus {
    const queued: number[] = [];
    for (const id of s.queuedIds) {
      const q = this.queuedAs.get(id);
      if (q?.log === this.log) queued.push(q.seq);
    }
    // Taken by the agent: forget them.
    for (const [id, q] of [...this.queuedAs])
      if (!s.queuedIds.includes(id)) {
        this.takenFrom = q.log;
        this.queuedAs.delete(id);
      }
    const c = this.conn;
    const live = c && !c.left ? c : undefined;
    return {
      state: s.state,
      waitSec: s.waitSec,
      queued,
      ...(this.agent === undefined ? {} : { agent: this.agent }),
      ...(live ? { connection: live.id } : {}),
      ...(live?.railLog === this.log ? { railFrom: live.railFrom } : {}),
      ...(s.quiet ? { quiet: true as const } : {}),
      ...(s.state === 'working' && this.takenFrom && !this.sameChat(this.takenFrom, this.log)
        ? { workingIn: this.topicRef(this.takenFrom) }
        : {}),
      ...(this.started
        ? {
            started: {
              ...this.started,
              ...(this.conn?.id === this.started.connection ? { listened: true } : {}),
            },
          }
        : {}),
    };
  }

  /** A line in `log` (default: the shown topic). */
  private add(
    kind: ChatEntry['kind'],
    text: string,
    extra: Pick<ChatEntry, 'ref' | 'path' | 'connection' | 'agent' | 'detail' | 'topic'> = {},
    log: Log = this.log,
  ): ChatEntry {
    const entry: ChatEntry = {
      seq: log.nextSeq++,
      kind,
      text,
      at: this.now(),
      ...(extra.ref ? { ref: extra.ref } : {}),
      ...(extra.path ? { path: extra.path } : {}),
      ...(extra.connection ? { connection: extra.connection } : {}),
      ...(extra.agent ? { agent: extra.agent } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.topic ? { topic: extra.topic } : {}),
    };
    log.entries.push(entry);
    log.pending.push(entry);
    this.trim(log);
    this.flush(log);
    if (log === this.log) this.options.emit?.({ kind: 'entry', entry });
    // An earlier topic of the shown project: the window shows it if open, else counts it.
    else if (log.folder === this.log.folder && log.chatId !== undefined)
      this.options.emit?.({ kind: 'entry', entry, chatId: log.chatId });
    return entry;
  }

  /** Oldest shown lines go once there are too many (a saved chat pages them back). */
  private trim(log: Log): void {
    if (log.entries.length <= MAX_CHAT_ENTRIES) return;
    log.entries.splice(0, log.entries.length - MAX_CHAT_ENTRIES);
    log.hasOlder = log.chatId !== undefined;
  }

  /** Hand what waits to the store, once the chat holds a message and a project is shown. */
  private flush(log: Log): void {
    const store = this.options.store;
    if (log.unsaved) {
      log.pending = []; // never written: they stay in `entries` until the app quits
      return;
    }
    if (!store || log.folder === undefined) return;
    if (log.chatId === undefined && !log.pending.some(isChatMessage)) return;
    // Events wait for the next message: a chat never ends in a trail of "Opened …" lines.
    if (!log.pending.some(isChatMessage) && log.pending.every(isQuietLine)) return;
    const lines = log.pending.splice(0);
    if (lines.length === 0) return;
    const first = lines.find(isChatMessage);
    const chatId = (log.chatId ??= store.newId());
    const folder = log.folder;
    const title = chatTitle(first?.text ?? '');
    this.writing = this.writing
      .catch(() => undefined)
      .then(() => store.append(folder, chatId, lines, title))
      .then(
        (result) => {
          if (result === 'not-shown') {
            // Back in line, in order, ahead of anything added since.
            log.pending.unshift(...lines);
            // Several writes may come back this way: keep the chat's order.
            log.pending.sort((a, b) => a.seq - b.seq);
          } else if (result === 'read-only' && !log.unsaved) {
            log.unsaved = true;
            if (this.log === log) this.options.emit?.({ kind: 'reset', view: this.view() });
          }
        },
        (err: unknown) => {
          // Not written: back in line, tried again with the next line added.
          log.pending.unshift(...lines);
          log.pending.sort((a, b) => a.seq - b.seq);
          this.options.onError?.(err);
        },
      );
  }
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The folded "Caught up" line: a short label and, behind it, what was passed in words. */
export function catchUpText(c: ChatCatchUp): { line: string; detail: string } {
  const open = c.parts.reduce((n, p) => n + p.openComments, 0);
  const label = [
    'Caught up',
    ...(c.shown ? [c.shown.file] : []),
    `${String(open)} open comment${open === 1 ? '' : 's'}`,
    ...(c.topic.latest.length === 1
      ? ['last message']
      : c.topic.latest.length
        ? [`last ${String(c.topic.latest.length)} messages`]
        : []),
    ...(c.summary ? ['summary'] : []),
  ].join(' · ');
  const out: string[] = [];
  if (c.project) out.push(`Project: ${c.project}`);
  out.push(`On screen: ${c.shown ? c.shown.file : 'no model'}`);
  for (const p of c.parts) {
    const news = p.newVersions?.length ? ` · new since: ${p.newVersions.join(', ')}` : '';
    out.push(
      `${p.file}: ${String(p.openComments)} open comment${p.openComments === 1 ? '' : 's'}${news}`,
    );
  }
  if (c.modelSwitches?.length) out.push(`Models shown since: ${c.modelSwitches.join('; ')}`);
  if (c.summary) out.push(`Summary (${c.summary.of}): ${c.summary.text}`);
  out.push(
    `This topic: ${String(c.topic.lines)} lines${c.topic.title ? ` · "${c.topic.title}"` : ''}`,
  );
  for (const l of c.topic.latest) out.push(`${l.from === 'agent' ? 'Agent' : 'You'}: ${l.text}`);
  return { line: label, detail: out.join('\n') };
}
