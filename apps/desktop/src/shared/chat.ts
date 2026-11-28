/**
 * The Agent tab's conversation as the window sees it: the current topic (user messages, agent
 * answers, progress lines, model events, the agent's join / leave / catch-up lines) and the
 * agent's state. Main saves it in the shown
 * project (`.thirdwheel/chats/<id>.jsonl`); the window gets the latest lines and pages back.
 */
import type { ChatAgentState, ChatCommentRef } from '@third-wheel/core';

export type { ChatCommentRef, ChatPost } from '@third-wheel/core';

export interface ChatEntry {
  /** Order in its chat, from 1. */
  readonly seq: number;
  /**
   * `user` typed in the chat; `agent` answered (`send_chat_message`, Markdown); `progress` =
   * `post_progress` line; `thread` = the user replied under a comment (text = the reply, goes to
   * the agent); `review` = the user clicked Send review (text = summary line, goes to the agent);
   * `replied` = the agent answered under a comment (text = its reply); `event` = a model was shown
   * ("Opened bracket_v2.step"; not sent to the agent); `joined` / `left` = an agent connection
   * started listening ("Claude Code connected") / went quiet ("… stopped listening"); `caught-up` =
   * what a new connection was passed (`detail`, shown folded); `summary` = the agent stored a
   * summary of the topic (`detail`); `elsewhere` = the agent answered a message from another topic
   * there ("Answered in topic “…”", `topic` names it).
   */
  readonly kind:
    | 'user'
    | 'agent'
    | 'progress'
    | 'thread'
    | 'review'
    | 'replied'
    | 'event'
    | 'joined'
    | 'left'
    | 'caught-up'
    | 'summary'
    | 'elsewhere';
  readonly text: string;
  /** ms since epoch. */
  readonly at: number;
  /** The comment of a `thread` / `replied` entry. */
  readonly ref?: ChatCommentRef;
  /** `event`: the model file shown (main looks its version up when the line is saved). */
  readonly path?: string;
  /** `joined` / `left` / `caught-up`: the MCP server's id for that start. */
  readonly connection?: string;
  /** `agent` / `replied` / `joined` / `left`: the agent's own name (MCP `clientInfo`). */
  readonly agent?: string;
  /** `caught-up` / `summary`: the readable text behind the folded line. */
  readonly detail?: string;
  /** `elsewhere`: the topic the answer went to. */
  readonly topic?: ChatTopicRef;
}

/**
 * A topic named in a note: `chatId` when it is a saved topic of the shown project (the note opens
 * it), `project` (the folder's name) when it belongs to another project.
 */
export interface ChatTopicRef {
  readonly title: string;
  readonly chatId?: string;
  readonly project?: string;
}

/**
 * Saving chat lines in a project: `saved`; `read-only` (it can't be written: kept until the app
 * quits); `not-shown` (not written now — another project is shown and that one is open elsewhere:
 * the lines wait and are tried again with the next line, or when it is shown).
 */
export type ChatAppendResult = 'saved' | 'read-only' | 'not-shown';

/** What the shown project tells a new agent connection (main builds the catch-up from it). */
export interface ChatProjectFacts {
  readonly name: string;
  readonly parts: readonly {
    readonly file: string;
    readonly newVersions?: readonly string[];
    readonly openComments: number;
  }[];
  readonly summary?: { readonly of: 'this topic' | 'earlier topic'; readonly text: string };
}

const NOT_MESSAGES: ReadonlySet<ChatEntry['kind']> = new Set([
  'event',
  'progress',
  'joined',
  'left',
  'caught-up',
  'summary',
  'elsewhere',
] as const);
/** Kinds that make a chat worth keeping (event, progress, join / leave lines alone don't). */
export function isChatMessage(e: Pick<ChatEntry, 'kind'>): boolean {
  return !NOT_MESSAGES.has(e.kind);
}

/** Lines that wait for the next message before they are written (a topic never ends in them). */
export function isQuietLine(e: Pick<ChatEntry, 'kind'>): boolean {
  return e.kind === 'event' || e.kind === 'joined' || e.kind === 'left' || e.kind === 'caught-up';
}

/** The agent's own MCP client name → a name people know; unknown names shown as they are. */
export function agentLabel(name: string | undefined): string {
  if (!name) return 'Agent';
  const known: readonly [RegExp, string][] = [
    [/claude/i, 'Claude Code'],
    [/codex/i, 'Codex'],
    [/gemini/i, 'Gemini CLI'],
    [/copilot/i, 'Copilot'],
    [/cursor/i, 'Cursor'],
    [/visual studio code|vscode/i, 'VS Code'],
  ];
  return known.find(([re]) => re.test(name))?.[1] ?? name;
}

/** An agent started the MCP server (`chat_hello`); it may not listen yet. */
export interface ChatStarted {
  /** The MCP server's id for this start. */
  readonly connection: string;
  /** ms since epoch. */
  readonly at: number;
  /** The agent's own name (MCP `clientInfo`). */
  readonly agent?: string;
  /** The folder the agent started the server in. */
  readonly folder?: string;
  /** This start has listened (`wait_for_message`) this app session. */
  readonly listened?: boolean;
}

export interface ChatStatus {
  readonly state: ChatAgentState;
  /** How long each agent wait lasts, seconds. */
  readonly waitSec: number;
  /** `seq` of user messages (in the shown chat) the agent has not taken yet. */
  readonly queued: readonly number[];
  /** The agent's own name as it reported it (MCP `clientInfo`, e.g. `claude-code`), once it listened. */
  readonly agent?: string;
  /**
   * The connection listening now (the MCP server's id for its start), while it hasn't gone quiet:
   * the rail marks what it received from its `joined` line on.
   */
  readonly connection?: string;
  /** `seq` in the shown topic where the rail starts (missing: it runs off the top — the agent
   * remembers lines before, from an earlier topic or project). */
  readonly railFrom?: number;
  /** `working`, but no sign of the agent for 10 min (busy in its terminal, or stopped). */
  readonly quiet?: true;
  /**
   * `working` on messages from another topic or project: no "…" in this one, a note naming that
   * topic instead (`chatId` when it is a saved topic of the shown project: the note opens it).
   */
  readonly workingIn?: ChatTopicRef;
  /** The latest MCP server start that said hello this app session (the Connect pop-up's status). */
  readonly started?: ChatStarted;
}

export interface ChatView {
  readonly status: ChatStatus;
  /** The latest lines of the current chat. */
  readonly entries: readonly ChatEntry[];
  /** The current topic has older lines than `entries` (`chatRead` pages back). */
  readonly hasOlder: boolean;
  /** The current chat's id once saved (undefined: nothing saved yet). */
  readonly chatId?: string;
  /** A project is shown: chats are saved and listed (New chat needs one). */
  readonly inProject: boolean;
  /** The project can't be written: the chat is kept until the app quits. */
  readonly unsaved?: true;
  /** The shown project's folder (a past chat of another project closes when it changes). */
  readonly project?: string;
}

/** One chat of the shown project in the 🕘 list. */
export interface ChatListItem {
  readonly id: string;
  readonly title: string;
  /** ms since epoch. */
  readonly created: number;
  readonly last: number;
  readonly entries: number;
  /** The chat new messages go to. */
  readonly current: boolean;
}

/** Lines of a saved chat, oldest first, and whether there are older ones. */
export interface ChatPage {
  readonly entries: readonly ChatEntry[];
  readonly hasOlder: boolean;
}

/**
 * main → window. `reset`: another chat is current (project switch, New chat): show it instead.
 * `entry` with `chatId`: a line of an earlier topic of the shown project (the agent answered a
 * message asked there) — shown live when that topic is open, else counted on Earlier topics.
 */
export type ChatEvent =
  | { readonly kind: 'entry'; readonly entry: ChatEntry; readonly chatId?: string }
  | { readonly kind: 'status'; readonly status: ChatStatus }
  | { readonly kind: 'reset'; readonly view: ChatView };
