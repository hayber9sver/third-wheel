/**
 * What the Chat tab shows, worked out from the conversation and the agent's state
 * (states, queued marks, folded progress steps). Pure: `chat-panel.ts` turns it into DOM.
 */
import type { ChatAgentState } from '@third-wheel/core';
import {
  agentLabel,
  type ChatCommentRef,
  type ChatEntry,
  type ChatStatus,
  type ChatTopicRef,
} from '../../shared/chat.js';

/** "Taking a while?" shows after this long working with no new progress line, ms. */
export const PERMISSION_HINT_MS = 30_000;

/**
 * The rail beside what the listening connection received: `start` (its first line), `on`, `top`
 * (first line shown, the rail runs off the top: it got lines before — an earlier topic or
 * project), `before` (lines before it connected, faded).
 */
export type ChatRail = 'start' | 'on' | 'top' | 'before';

export type ChatItem = (
  | {
      readonly kind: 'user';
      readonly seq: number;
      readonly text: string;
      /** The last queued message carries the line under it. */
      readonly queuedNote?: string;
      readonly queued: boolean;
    }
  /**
   * The user's reply under a comment (`thread`) or a sent review (`review`): on the user's side,
   * queued like a message.
   */
  | {
      readonly kind: 'thread' | 'review';
      readonly seq: number;
      readonly text: string;
      readonly ref?: ChatCommentRef;
      readonly queuedNote?: string;
      readonly queued: boolean;
    }
  /** "↳ Replied under #3 …": the agent answered in a comment's thread. */
  | {
      readonly kind: 'replied';
      readonly seq: number;
      readonly text: string;
      readonly ref: ChatCommentRef;
      /** Progress lines that led to this reply ("▸ n steps"). */
      readonly steps: readonly string[];
    }
  | {
      readonly kind: 'agent';
      readonly seq: number;
      readonly text: string;
      /** Progress lines that led to this answer ("▸ n steps"). */
      readonly steps: readonly string[];
      /** "Claude Code" above the first bubble of a run of answers. */
      readonly name?: string;
    }
  /**
   * A small grey line across the chat: a model was shown ("Opened bracket_v2.step"), or an agent
   * connected / stopped listening ("Claude Code connected · 14:02").
   */
  | { readonly kind: 'event'; readonly seq: number; readonly text: string; readonly at: number }
  /** "▸ Caught up · …" / "▸ Saved a summary…": a grey line that unfolds what was passed / stored. */
  | {
      readonly kind: 'folded';
      readonly seq: number;
      readonly text: string;
      readonly detail: string;
      readonly at: number;
    }
  /** Working on a message from another topic: names it (and opens it, with `chatId`). */
  | ({ readonly kind: 'working-in' } & ChatTopicRef)
  /** "Answered in topic “…” →": the agent's answer went to the topic it was asked in. */
  | ({ readonly kind: 'answered-in'; readonly seq: number } & ChatTopicRef)
  /** Progress lines with no answer after them while the agent isn't working (it stopped). */
  | { readonly kind: 'steps'; readonly seq: number; readonly steps: readonly string[] }
  /** The "…" bubble while working: the latest progress line under it, maybe the hint. */
  | {
      readonly kind: 'working';
      readonly latest?: string;
      readonly hint: boolean;
      /** When the hint is due (ms): the panel shows it then without waiting for a change. */
      readonly hintAt: number;
      /** No news for 10 min: the hint says to check its terminal. */
      readonly quiet?: true;
    }
) & { readonly rail?: ChatRail };

export interface ChatDisplayInput {
  readonly entries: readonly ChatEntry[];
  readonly status: ChatStatus;
  readonly now: number;
  /** When the window saw the state turn `working` (ms), for the permission hint. */
  readonly workingSince?: number;
  /** Permission hint delay, ms (default `PERMISSION_HINT_MS`; shorter in e2e). */
  readonly hintMs?: number;
}

/** The line under the last queued message, by state. */
export function queuedNote(state: ChatAgentState): string {
  return state === 'working'
    ? 'Queued · goes to the agent when it’s done'
    : 'Queued · sent when the agent listens';
}

export function chatItems(input: ChatDisplayInput): ChatItem[] {
  const { entries, status } = input;
  const queued = new Set(status.queued);
  const lastQueued = status.queued.length ? Math.max(...status.queued) : undefined;
  const items: ChatItem[] = [];
  let steps: string[] = [];
  let stepsSeq = 0;
  let lastProgressAt: number | undefined;
  for (const e of entries) {
    if (e.kind === 'progress') {
      if (steps.length === 0) stepsSeq = e.seq;
      steps.push(e.text);
      lastProgressAt = e.at;
    } else if (e.kind === 'agent') {
      const prev = items.at(-1)?.kind;
      const named = prev !== 'agent' && prev !== 'replied' && prev !== 'steps';
      items.push({
        kind: 'agent',
        seq: e.seq,
        text: e.text,
        steps,
        ...(named ? { name: agentLabel(e.agent ?? status.agent) } : {}),
      });
      steps = [];
      lastProgressAt = undefined;
    } else if (e.kind === 'event') {
      items.push({ kind: 'event', seq: e.seq, text: e.text, at: e.at });
    } else if (e.kind === 'joined' || e.kind === 'left') {
      const text = `${e.text} · ${chatWhen(e.at, input.now)}`;
      items.push({ kind: 'event', seq: e.seq, text, at: e.at });
    } else if (e.kind === 'caught-up' || e.kind === 'summary') {
      items.push({ kind: 'folded', seq: e.seq, text: e.text, detail: e.detail ?? '', at: e.at });
    } else if (e.kind === 'elsewhere') {
      items.push({ kind: 'answered-in', seq: e.seq, ...(e.topic ?? { title: 'Topic' }) });
    } else if (e.kind === 'replied') {
      if (!e.ref) continue;
      items.push({ kind: 'replied', seq: e.seq, text: e.text, ref: e.ref, steps });
      steps = [];
      lastProgressAt = undefined;
    } else {
      items.push({
        kind: e.kind,
        seq: e.seq,
        text: e.text,
        queued: queued.has(e.seq),
        ...(e.ref ? { ref: e.ref } : {}),
        ...(e.seq === lastQueued ? { queuedNote: queuedNote(status.state) } : {}),
      });
    }
  }
  if (status.state === 'working' && status.workingIn) {
    // Busy with a message from another topic: say where, before messages queued here.
    const note: ChatItem = { kind: 'working-in', ...status.workingIn };
    const firstQueued = items.findIndex((it) => 'queued' in it && it.queued);
    if (firstQueued < 0) items.push(note);
    else items.splice(firstQueued, 0, note);
  } else if (status.state === 'working') {
    // Progress since the last answer belongs to the work going on: show the latest under "…".
    const since = Math.max(lastProgressAt ?? 0, input.workingSince ?? input.now);
    const latest = steps.at(-1);
    const hintMs = input.hintMs ?? PERMISSION_HINT_MS;
    const working: ChatItem = {
      kind: 'working',
      hint: input.now - since >= hintMs,
      hintAt: since + hintMs,
      ...(latest === undefined ? {} : { latest }),
      ...(status.quiet ? { quiet: true as const } : {}),
    };
    // The "…" goes after the messages it works on, before ones queued meanwhile.
    const firstQueued = items.findIndex((it) => 'queued' in it && it.queued);
    if (firstQueued < 0) items.push(working);
    else items.splice(firstQueued, 0, working);
  } else if (steps.length) {
    // Lines without an answer (the agent stopped): fold them where they were.
    const at = items.findIndex((it) => 'seq' in it && it.seq > stepsSeq);
    const folded: ChatItem = { kind: 'steps', seq: stepsSeq, steps };
    if (at < 0) items.push(folded);
    else items.splice(at, 0, folded);
  }
  // A rail that starts before the lines loaded here runs off the top.
  const first = entries[0]?.seq;
  const from = status.railFrom;
  const offTop = from !== undefined && first !== undefined && from < first;
  return withRail(items, status, offTop);
}

/** Marks the rail while a connection listens (see {@link ChatRail}); nothing otherwise. */
function withRail(items: ChatItem[], status: ChatStatus, offTop: boolean): ChatItem[] {
  // Gone as soon as it stops listening (not only once its "stopped listening" line is written).
  if (
    status.connection === undefined ||
    status.state === 'not-listening' ||
    status.state === 'stopped'
  )
    return items;
  const from = offTop ? undefined : status.railFrom;
  let started = false;
  return items.map((it) => {
    const seq = 'seq' in it ? it.seq : Number.POSITIVE_INFINITY;
    if (from !== undefined && seq < from) return { ...it, rail: 'before' as const };
    const rail: ChatRail = started ? 'on' : from === undefined ? 'top' : 'start';
    started = true;
    return { ...it, rail };
  });
}

/** "▸ 3 steps". */
export function stepsLabel(n: number): string {
  return `${String(n)} step${n === 1 ? '' : 's'}`;
}

/**
 * An agent answer in the chat or under a comment, or the note that it answered in another topic
 * (progress lines aren't).
 */
export function isAnswer(e: ChatEntry): boolean {
  return e.kind === 'agent' || e.kind === 'replied' || e.kind === 'elsewhere';
}

/** "Answered in topic “…”" / "Working on your message in topic “…”" with where it is. */
export function topicNote(what: string, t: ChatTopicRef): string {
  const text = `${what} in topic “${t.title}”`;
  if (t.chatId !== undefined) return `${text} →`;
  return t.project === undefined ? `${text} (another project)` : `${text} (project ${t.project})`;
}

/** Answers that came after `seenSeq` (progress lines don't count). */
export function unreadCount(entries: readonly ChatEntry[], seenSeq: number): number {
  return entries.filter((e) => isAnswer(e) && e.seq > seenSeq).length;
}

/** "#3 Pin too tight" (the comment's card number and first line, cut). */
export function refLabel(ref: ChatCommentRef, max = 48): string {
  const title = ref.title.length > max ? `${ref.title.slice(0, max - 1)}…` : ref.title;
  return `#${String(ref.n)} ${title}`.trim();
}

export { agentLabel };

export type ChatHelp = 'listening-empty' | 'restart' | undefined;

/**
 * What replaces the message box (undefined: the box shows): `project` = no project open (chats are
 * saved in its folder); `agent` = no agent has listened this app session (connect steps).
 */
export type ChatLock = 'project' | 'agent' | undefined;

export function chatLock(inProject: boolean, status: ChatStatus): ChatLock {
  if (!inProject) return 'project';
  if (status.state === 'none') return 'agent';
  return undefined;
}

/**
 * What the user pastes in the agent's terminal to (re)start the loop. Safe for an agent without
 * the Third Wheel tools: it says so instead of searching the computer for "Third Wheel".
 */
export const LISTEN_COMMAND =
  "Listen to Third Wheel: call the third-wheel MCP tool wait_for_message in a loop. If you don't have that tool, say so and stop.";

/** The state line at the top of the tab. */
export function stateLine(status: ChatStatus): {
  readonly dot: 'grey' | 'green' | 'blue' | 'amber';
  readonly text: string;
} {
  const name = agentLabel(status.agent);
  switch (status.state) {
    case 'none':
      return { dot: 'grey', text: 'No agent connected' };
    case 'listening':
      return { dot: 'green', text: `${name} · listening` };
    case 'working':
      return { dot: 'blue', text: `${name} · working…` };
    default:
      return { dot: 'amber', text: `${name} · not listening` };
  }
}

/**
 * Which help box shows above the conversation (`hasMessages`: more than model events). No agent
 * yet: none — the card in place of the message box has the connect steps ({@link chatLock}).
 */
export function chatHelp(status: ChatStatus, hasMessages: boolean): ChatHelp {
  if (status.state === 'not-listening' || status.state === 'stopped') return 'restart';
  if (status.state === 'listening' && !hasMessages) return 'listening-empty';
  return undefined;
}

/** "14:02" today, else "20 Nov" (this year) or "20 Nov 2025" — for the 🕘 list and event lines. */
export function chatWhen(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * The model event line the window adds when it shows a model. `how`: `opened` (the user),
 * `agent` (load_model), `reloaded` (the same file with new contents); `versionOf` = the file it
 * is a new version of.
 */
export function modelEventText(
  name: string,
  how: 'opened' | 'agent' | 'reloaded',
  versionOf?: string,
): string {
  const verb = how === 'agent' ? 'Agent loaded' : how === 'reloaded' ? 'Reloaded' : 'Opened';
  const tail =
    how === 'reloaded' ? ' (changed on disk)' : versionOf ? ` — new version of ${versionOf}` : '';
  return `${verb} ${name}${tail}`;
}

/** Placeholder of the chat box (the send key is named next to Send). */
export function inputPlaceholder(status: ChatStatus): string {
  switch (status.state) {
    case 'none': // the box is locked until an agent listened (chatLock)
    case 'not-listening':
    case 'stopped':
      return `Message ${agentLabel(status.agent)}… (queued)`;
    default:
      return `Message ${agentLabel(status.agent)}…`;
  }
}
