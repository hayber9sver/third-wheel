/**
 * Chat with the user's agent (listen loop): the agent long-polls `chat_wait` for the user's chat
 * messages, answers with `chat_send` and reports short steps with `chat_progress`. The app picks
 * how long a wait lasts; the MCP server only knows the ceiling. Pure — shared by the app and the
 * MCP server. Spec: `docs/mcp-tools.md`.
 */
import { z } from 'zod';

/**
 * Longest wait the app may hold one `chat_wait`, seconds. Claude Code aborts an MCP tool call that
 * sends no response or progress for 30 min, so stay well under that.
 */
export const MAX_CHAT_WAIT_SECONDS = 25 * 60;
/** Default wait the app holds one `chat_wait`, seconds (as long as allowed: idle rounds stay cheap). */
export const DEFAULT_CHAT_WAIT_SECONDS = MAX_CHAT_WAIT_SECONDS;
/** After this long without a message from the user, the next wait answers `stopped`, seconds. */
export const CHAT_IDLE_STOP_SECONDS = 2 * 3600;
export const MAX_CHAT_MESSAGE_LENGTH = 20_000;
export const MAX_CHAT_PROGRESS_LENGTH = 300;
export const MAX_CHAT_AGENT_NAME_LENGTH = 80;
/** Longest summary the agent may store for a topic (`post_chat_summary`), characters. */
export const MAX_CHAT_SUMMARY_LENGTH = 4000;
/** Most lines one `get_chat_history` page returns. */
export const MAX_CHAT_HISTORY_PAGE = 100;
export const DEFAULT_CHAT_HISTORY_PAGE = 30;

/**
 * Id the MCP server makes once per start (random, lower-case letters and digits). The app tells
 * one connection from the next by it: "Claude Code connected" lines, the catch-up, the rail. It
 * can't tell a fresh agent from a resumed one (`--continue`) or see `/clear`.
 */
export const chatConnectionSchema = z
  .string()
  .regex(/^[0-9a-z]{8,64}$/, 'a connection id is 8–64 lower-case letters and digits');

/**
 * `chat_wait`. `ack`: the `delivery` of the last `message` result the MCP server handed to the
 * agent. A wait without the ack of the app's last delivery means the agent never got it: the app
 * hands those messages over again.
 */
export const chatWaitParamsSchema = z
  .object({
    ack: z.number().int().min(1).optional(),
    /** The agent's own name (MCP `clientInfo`), e.g. `claude-code`; the chat shows it. */
    agent: z.string().trim().min(1).max(MAX_CHAT_AGENT_NAME_LENGTH).optional(),
    /** The MCP server's id for this start ({@link chatConnectionSchema}). */
    connection: chatConnectionSchema.optional(),
  })
  .strict();
export type ChatWaitParams = z.infer<typeof chatWaitParamsSchema>;

/**
 * `chat_hello`: the MCP server just started for an agent (sent once, when the agent's MCP client
 * finished its handshake), before the agent listens. The Connect pop-up shows "connected" and the
 * folder the agent started in. Older apps don't know it: the server ignores the error.
 */
export const chatHelloParamsSchema = z
  .object({
    connection: chatConnectionSchema,
    agent: z.string().trim().min(1).max(MAX_CHAT_AGENT_NAME_LENGTH).optional(),
    /** The MCP server's working folder (= where the agent started it). */
    folder: z.string().min(1).max(4096).optional(),
  })
  .strict();

/** Longest `about` the app hands over with one message, JSON characters. */
export const MAX_CHAT_ABOUT_LENGTH = 60_000;

const shortText = z.string().min(1).max(4096);
const commentId = z.string().min(1).max(64);
const cardNumber = z.number().int().min(1);

/**
 * What a message is about, besides its text. `thread`: the user replied under a comment (text =
 * the reply; `payload` = that comment as `get_annotations` shows it, with its markers). `review`:
 * the user clicked Send review (text = a summary line; per model the open comments not sent before).
 */
export const chatAboutSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('thread'),
      modelId: shortText,
      file: shortText,
      commentId,
      n: cardNumber,
      payload: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('review'),
      models: z
        .array(
          z
            .object({
              modelId: shortText,
              file: shortText,
              path: shortText,
              openComments: z.number().int().min(0),
              newComments: z.array(z.object({ id: commentId, n: cardNumber }).strict()).max(500),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
]);
export type ChatAbout = z.infer<typeof chatAboutSchema>;

/**
 * A comment a chat entry points at (window ↔ main); a click highlights it. A link read back from a
 * saved chat (main → window only, never posted back) has no live `modelId` (empty): `partId` names
 * the comment's part and `path` / `file` its newest version (empty `path`: the part is gone).
 */
export const chatCommentRefSchema = z
  .object({
    modelId: shortText,
    /** The comment's part in the project (saved links open the comment on the version shown now). */
    partId: z.string().min(1).max(64).optional(),
    /** File name and full path of its model. */
    file: shortText,
    path: shortText,
    commentId,
    /** Card number when the entry was made ("#3"). */
    n: cardNumber,
    /** First line of the comment. */
    title: z.string().max(4096),
  })
  .strict();
export type ChatCommentRef = z.infer<typeof chatCommentRefSchema>;

const postText = z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH);
/**
 * What the window adds to the chat besides typed messages: `thread` (the user replied under a
 * comment) and `review` (Send review) go to the agent; `replied` (the agent answered under a
 * comment) and `event` (a model was shown) are only shown.
 */
export const chatPostSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('thread'),
      text: postText,
      ref: chatCommentRefSchema,
      about: chatAboutSchema,
    })
    .strict(),
  z.object({ kind: z.literal('review'), text: postText, about: chatAboutSchema }).strict(),
  z.object({ kind: z.literal('replied'), text: postText, ref: chatCommentRefSchema }).strict(),
  /** A model was shown ("Opened bracket_v2.step"): a line in the chat, not sent to the agent. */
  z
    .object({
      kind: z.literal('event'),
      text: z.string().trim().min(1).max(300),
      path: shortText,
      /** The shown model's id (`modelIdOf`): each message names it for the agent. */
      modelId: shortText.optional(),
    })
    .strict(),
]);
export type ChatPost = z.infer<typeof chatPostSchema>;

/** The model on screen when the user wrote a message (against carry-over between parts). */
export interface ChatShownModel {
  readonly modelId: string;
  readonly file: string;
}

export interface ChatMessage {
  readonly id: number;
  readonly text: string;
  /** When the user sent it, ms since epoch. */
  readonly at: number;
  /** A thread reply or a sent review (missing = typed in the chat). */
  readonly about?: ChatAbout;
  /** The model on screen when it was sent (missing: none). */
  readonly shown?: ChatShownModel;
}

/**
 * What a new connection gets once, before (or with) its first messages: where things stand, never
 * the transcript. Counts and the latest few lines; the agent's own summary when it stored one;
 * older lines through `get_chat_history`.
 */
export interface ChatCatchUp {
  /** The project's name (undefined: no project open). */
  readonly project?: string;
  readonly shown?: ChatShownModel;
  /** When an agent was last heard in this topic (ISO): "new" below means since then. */
  readonly since?: string;
  /** Per part: its newest file, versions added since, open comments. */
  readonly parts: readonly {
    readonly file: string;
    readonly newVersions?: readonly string[];
    readonly openComments: number;
  }[];
  /** Models the user showed since (model event lines, latest last). */
  readonly modelSwitches?: readonly string[];
  /** The agent's own summary (`post_chat_summary`), of this topic or an earlier one. */
  readonly summary?: { readonly of: 'this topic' | 'earlier topic'; readonly text: string };
  /** The current topic: title, line count, and the latest messages (each shortened). */
  readonly topic: {
    readonly title?: string;
    readonly lines: number;
    readonly latest: readonly { readonly from: 'user' | 'agent'; readonly text: string }[];
  };
}

/**
 * `message`: the user wrote (all messages queued since the last pick-up, oldest first); pass
 * `delivery` back as `ack` on the next wait. `waiting`: time ran out, call again. `replaced`: a
 * newer wait took over (this call is stale). `closed`: the app is quitting — stop listening.
 * `stopped`: no message for a long time — stop listening (the user restarts it in the agent's
 * terminal).
 */
export type ChatWaitResult =
  | {
      readonly state: 'message';
      readonly delivery: number;
      readonly messages: readonly ChatMessage[];
      /** Only for a new connection (messages may then be empty). */
      readonly catchUp?: ChatCatchUp;
    }
  | { readonly state: 'waiting' | 'replaced' | 'closed'; readonly waitedSec: number }
  | { readonly state: 'stopped'; readonly idleSec: number };

/** `chat_send`: the agent's answer, shown in the chat (Markdown). */
export const chatSendParamsSchema = z
  .object({ text: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH) })
  .strict();

/** `chat_progress`: one short line about what the agent does now. */
export const chatProgressParamsSchema = z
  .object({ text: z.string().trim().min(1).max(MAX_CHAT_PROGRESS_LENGTH) })
  .strict();

/**
 * `chat_history`: lines of a topic, latest first page; `before` = the lowest `seq` already read;
 * `topic` = an id from the first page's `topics` (default: the agent's current topic — the one its
 * latest message came from, else the one shown).
 */
export const chatHistoryParamsSchema = z
  .object({
    before: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_CHAT_HISTORY_PAGE).optional(),
    topic: z
      .string()
      .regex(/^[0-9a-z]{1,64}$/)
      .optional(),
  })
  .strict();

/** One line of `chat_history`, compact. `ref`: the comment's card number ("#3"). */
export interface ChatHistoryLine {
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
  readonly at: string;
  readonly ref?: string;
}

export interface ChatHistoryResult {
  readonly topic: { readonly id?: string; readonly title: string; readonly current: boolean };
  readonly lines: readonly ChatHistoryLine[];
  /** Older lines exist: call again with `before` = the first line's `seq`. */
  readonly hasOlder: boolean;
  /** The project's topics, newest first (first page only). */
  readonly topics?: readonly {
    readonly id: string;
    readonly title: string;
    readonly lines: number;
    readonly last: string;
  }[];
}

/** `chat_summary`: the agent's own summary of the current topic (the next catch-up sends it). */
export const chatSummaryParamsSchema = z
  .object({ text: z.string().trim().min(1).max(MAX_CHAT_SUMMARY_LENGTH) })
  .strict();

/**
 * What the chat shows about the agent. `none`: no agent has listened this session. `listening`: a
 * wait is open. `working`: messages handed over, no new wait yet. `not-listening`: no wait for a
 * while (or it stopped after a long idle time — `stopped`).
 */
export type ChatAgentState = 'none' | 'listening' | 'working' | 'not-listening' | 'stopped';
