/**
 * Chats saved in the shown project: window-shaped chat entries ↔ the lines of
 * `.thirdwheel/chats/<id>.jsonl` (ISO times; comment links by comment id + part, not the file the
 * window had; model events with the version shown). The project files are reached through
 * {@link ChatProjectAccess} (`ProjectSession`); no Electron here (tests).
 */
import { basename } from 'node:path';
import { newId, type ChatInfo, type ChatEntry as ChatLine } from '@third-wheel/core';
import type { ChatAppendResult, ChatEntry, ChatPage, ChatProjectFacts } from '../shared/chat.js';
import type { ChatStore } from './chat-session.js';

/** What the store needs from the project (`ProjectSession`). */
export interface ChatProjectAccess {
  /** The project's chats index; empty when it has none (or isn't the shown one). */
  chatIndex(folder: string): Promise<readonly ChatInfo[]>;
  /** Every line of a chat, oldest first (broken lines skipped). */
  chatLines(folder: string, chatId: string): Promise<readonly ChatLine[]>;
  /** Append lines and keep the index in step (see {@link ChatAppendResult}). */
  appendChatLines(
    folder: string,
    chatId: string,
    lines: readonly ChatLine[],
    title: string,
    summary?: string,
  ): Promise<ChatAppendResult>;
  /** What a new agent connection is told about the project (see `ProjectSession.chatFacts`). */
  chatFacts(
    folder: string,
    since: number | undefined,
    chatId: string | undefined,
  ): Promise<ChatProjectFacts | undefined>;
  /** The version a model file stands for in the project (and its part). */
  versionPlace(
    folder: string,
    file: string,
  ): Promise<{ partId: string; versionId: string } | undefined>;
  /** A part's newest version file (a saved comment link opens it). */
  partLink(folder: string, partId: string): Promise<{ path: string; name: string } | undefined>;
}

const KINDS: ReadonlySet<string> = new Set<ChatEntry['kind']>([
  'user',
  'agent',
  'progress',
  'thread',
  'review',
  'replied',
  'event',
  'joined',
  'left',
  'caught-up',
  'summary',
  'elsewhere',
]);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A window entry as a saved line (`place` = its comment's / event model's place, when known). */
export function toLine(
  e: ChatEntry,
  place: { readonly partId: string; readonly versionId: string } | undefined,
): ChatLine {
  const partId = e.ref?.partId ?? place?.partId;
  return {
    seq: e.seq,
    kind: e.kind,
    text: e.text,
    at: new Date(e.at).toISOString(),
    ...(e.ref && partId
      ? {
          ref: {
            commentId: e.ref.commentId,
            modelId: partId,
            file: e.ref.file,
            n: e.ref.n,
            title: e.ref.title,
          },
        }
      : {}),
    ...(e.kind === 'event' && place ? { model: place.versionId } : {}),
    ...(e.connection ? { connection: e.connection } : {}),
    ...(e.agent ? { agent: e.agent } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.topic
      ? {
          topic: {
            title: e.topic.title,
            ...(e.topic.chatId ? { chat: e.topic.chatId } : {}),
            ...(e.topic.project ? { project: e.topic.project } : {}),
          },
        }
      : {}),
  };
}

/** A saved line as a window entry (undefined: a kind this app doesn't know, from a newer one). */
export function toEntry(
  line: ChatLine,
  link: { readonly path: string; readonly name: string } | undefined,
): ChatEntry | undefined {
  if (!KINDS.has(line.kind)) return undefined;
  const at = Date.parse(line.at);
  const ref = line.ref;
  const n = typeof ref?.['n'] === 'number' && ref['n'] >= 1 ? ref['n'] : 1;
  const connection = str(line.connection);
  const agent = str(line.agent);
  const detail = str(line.detail);
  const topic = line.topic;
  const chat = str(topic?.chat);
  const project = str(topic?.project);
  return {
    seq: line.seq,
    kind: line.kind as ChatEntry['kind'],
    text: line.text,
    at: Number.isFinite(at) ? at : 0,
    ...(ref
      ? {
          ref: {
            modelId: '',
            partId: ref.modelId,
            file: link?.name ?? str(ref['file']) ?? 'model',
            path: link?.path ?? '',
            commentId: ref.commentId,
            n,
            title: str(ref['title']) ?? '',
          },
        }
      : {}),
    ...(connection ? { connection } : {}),
    ...(agent ? { agent } : {}),
    ...(detail ? { detail } : {}),
    ...(topic
      ? {
          topic: {
            title: topic.title,
            ...(chat ? { chatId: chat } : {}),
            ...(project ? { project } : {}),
          },
        }
      : {}),
  };
}

export class ProjectChatStore implements ChatStore {
  constructor(private readonly project: ChatProjectAccess) {}

  newId(): string {
    return newId();
  }

  async current(
    folder: string,
    limit: number,
  ): Promise<{ chatId?: string; entries: ChatEntry[]; hasOlder: boolean; lastSeq: number }> {
    const chat = (await this.project.chatIndex(folder)).at(-1);
    if (!chat) return { entries: [], hasOlder: false, lastSeq: 0 };
    const lines = await this.project.chatLines(folder, chat.id);
    const lastSeq = lines.reduce((m, l) => Math.max(m, l.seq), 0);
    const page = await this.page(folder, lines, undefined, limit);
    return { chatId: chat.id, ...page, lastSeq };
  }

  async append(
    folder: string,
    chatId: string,
    entries: readonly ChatEntry[],
    title: string,
  ): Promise<ChatAppendResult> {
    const lines: ChatLine[] = [];
    for (const e of entries) {
      const file = e.kind === 'event' ? e.path : e.ref?.partId ? undefined : e.ref?.path;
      const place = file ? await this.project.versionPlace(folder, file) : undefined;
      lines.push(toLine(e, place));
    }
    // The agent's latest summary goes into the index too (the next catch-up sends it).
    const summary = entries.filter((e) => e.kind === 'summary').at(-1)?.detail;
    return this.project.appendChatLines(folder, chatId, lines, title, summary);
  }

  async facts(
    folder: string,
    since: number | undefined,
    chatId: string | undefined,
    shown?: string,
  ): Promise<ChatProjectFacts | undefined> {
    const facts = await this.project.chatFacts(folder, since, chatId);
    if (!facts || shown === undefined) return facts;
    // A model opened without notes isn't a part yet: it still counts (no open comments).
    if (await this.project.versionPlace(folder, shown)) return facts;
    return { ...facts, parts: [...facts.parts, { file: basename(shown), openComments: 0 }] };
  }

  async list(
    folder: string,
  ): Promise<{ id: string; title: string; created: number; last: number; entries: number }[]> {
    const ms = (iso: string): number => Date.parse(iso) || 0;
    return (await this.project.chatIndex(folder)).map((c) => ({
      id: c.id,
      title: c.title,
      created: ms(c.created),
      last: ms(c.last),
      entries: c.entries,
    }));
  }

  async read(
    folder: string,
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<ChatPage> {
    if (!(await this.project.chatIndex(folder)).some((c) => c.id === chatId))
      return { entries: [], hasOlder: false };
    const lines = await this.project.chatLines(folder, chatId);
    return this.page(folder, lines, before, limit);
  }

  private async page(
    folder: string,
    lines: readonly ChatLine[],
    before: number | undefined,
    limit: number,
  ): Promise<{ entries: ChatEntry[]; hasOlder: boolean }> {
    const known = lines
      .filter((l) => KINDS.has(l.kind) && (before === undefined || l.seq < before))
      .sort((a, b) => a.seq - b.seq);
    const shown = known.slice(-limit);
    const links = new Map<string, { path: string; name: string } | undefined>();
    for (const l of shown) {
      const part = l.ref?.modelId;
      if (part && !links.has(part)) links.set(part, await this.project.partLink(folder, part));
    }
    const entries = shown
      .map((l) => toEntry(l, l.ref ? links.get(l.ref.modelId) : undefined))
      .filter((e): e is ChatEntry => e !== undefined);
    return { entries, hasOlder: known.length > shown.length };
  }
}
