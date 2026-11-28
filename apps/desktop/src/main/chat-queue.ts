/**
 * Chat listen loop, app side: the user's messages wait here until the agent's `chat_wait` takes
 * them (all queued messages together). One wait at a time: a newer wait answers the older one
 * `replaced`. A wait whose connection closes (the MCP tool call was cancelled) is dropped, so no
 * message is handed to a call nobody reads. Handed-over messages stay "in flight" until the next
 * wait acks them; a wait without that ack gets them again (the agent never saw them).
 *
 * Agent state shown in the chat: `listening` while a wait is open
 * (and for a short grace between two waits), `working` after messages were handed over until the
 * next wait (`quiet` after {@link CHAT_WORKING_QUIET_SECONDS} without a sign of the agent), else
 * `not-listening`; `stopped` once a wait
 * answered `stopped` after a long time without a user message.
 */
import {
  CHAT_IDLE_STOP_SECONDS,
  DEFAULT_CHAT_WAIT_SECONDS,
  type ChatAbout,
  type ChatAgentState,
  type ChatMessage,
  type ChatShownModel,
  type ChatWaitParams,
  type ChatWaitResult,
} from '@third-wheel/core';

/** Between two waits the agent counts as listening this long, seconds. */
export const CHAT_GRACE_SECONDS = 30;
/**
 * `working` without any sign of the agent this long (or the wait, if shorter) gets `quiet` ("no
 * news — check its terminal"), seconds: the app can't tell a busy agent (long script, permission
 * question) from a crashed one. Each MCP tool call is a sign.
 */
export const CHAT_WORKING_QUIET_SECONDS = 600;

export interface ChatQueueSnapshot {
  readonly state: ChatAgentState;
  /** How long each wait lasts, seconds. */
  readonly waitSec: number;
  /** Ids of the user's messages not handed to the agent yet (oldest first). */
  readonly queuedIds: readonly number[];
  /** `working`, but no sign of the agent for {@link CHAT_WORKING_QUIET_SECONDS}. */
  readonly quiet?: true;
}

export interface ChatLogEntry {
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface ChatQueueOptions {
  readonly now?: () => number;
  readonly waitSec?: number;
  readonly idleStopSec?: number;
  readonly graceSec?: number;
  /** Called when the state, the wait or the queued messages change. */
  readonly onChange?: (snapshot: ChatQueueSnapshot) => void;
  /** Each step, for a debug log (`THIRD_WHEEL_CHAT_LOG`). */
  readonly log?: (entry: ChatLogEntry & { readonly t: number }) => void;
}

interface Waiter {
  readonly id: number;
  readonly startedAt: number;
  readonly resolve: (r: ChatWaitResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

export class ChatQueue {
  private queued: ChatMessage[] = [];
  private inFlight: { readonly delivery: number; readonly messages: ChatMessage[] } | undefined;
  private waiter: Waiter | undefined;
  private nextMessageId = 1;
  private nextWaitId = 1;
  private nextDelivery = 1;
  private everListened = false;
  private stopped = false;
  /** The agent answered in the chat since the last hand-over: no longer `working`. */
  private answered = false;
  /** Last sign of the agent (wait start / end, answer, progress), ms. */
  private lastAgentAt = 0;
  /** Since when no user message came (reset by a message or a restarted loop), ms. */
  private idleSince: number;
  private waitSecValue: number;
  private lastSnapshot: ChatQueueSnapshot | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly idleStopMs: number;
  private readonly graceMs: number;

  constructor(private readonly options: ChatQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.waitSecValue = options.waitSec ?? DEFAULT_CHAT_WAIT_SECONDS;
    this.idleStopMs = (options.idleStopSec ?? CHAT_IDLE_STOP_SECONDS) * 1000;
    this.graceMs = (options.graceSec ?? CHAT_GRACE_SECONDS) * 1000;
    this.idleSince = this.now();
  }

  get waitSec(): number {
    return this.waitSecValue;
  }

  set waitSec(sec: number) {
    this.waitSecValue = sec;
    this.log({ event: 'set_wait', waitSec: sec });
    this.changed();
  }

  get state(): ChatAgentState {
    if (!this.everListened) return 'none';
    if (this.stopped) return 'stopped';
    if (this.waiter) return 'listening';
    const quiet = this.now() - this.lastAgentAt;
    // Working on the user's messages until it answers (a catch-up alone is not a request).
    if (this.inFlight?.messages.length && !this.answered) return 'working';
    return quiet <= this.graceMs ? 'listening' : 'not-listening';
  }

  snapshot(): ChatQueueSnapshot {
    const state = this.state;
    const quiet = state === 'working' && this.now() - this.lastAgentAt > this.workingMs();
    return {
      state,
      waitSec: this.waitSecValue,
      queuedIds: this.queued.map((m) => m.id),
      ...(quiet ? { quiet: true as const } : {}),
    };
  }

  /**
   * The user sent a message: hand it to an open wait, else queue it. `id`: the caller's own number;
   * `about`: a thread reply or a sent review; `shown`: the model on screen.
   */
  send(text: string, id?: number, about?: ChatAbout, shown?: ChatShownModel): ChatMessage {
    const message: ChatMessage = {
      id: id ?? this.nextMessageId++,
      text,
      at: this.now(),
      ...(about ? { about } : {}),
      ...(shown ? { shown } : {}),
    };
    this.queued.push(message);
    this.idleSince = message.at;
    this.log({ event: 'user_send', id: message.id, chars: text.length, waiting: !!this.waiter });
    if (this.waiter) this.deliver();
    else this.changed();
    return message;
  }

  /** The agent answered or reported progress: it is alive (keeps `working`). */
  agentActivity(): void {
    this.lastAgentAt = this.now();
    this.changed();
  }

  /** The agent answered in the chat: done with the messages (it should wait again now). */
  agentAnswered(): void {
    this.answered = true;
    this.agentActivity();
  }

  /**
   * Another MCP tool call (load_model, reply_to_comment…): keeps `working` while it works on a
   * message; ignored otherwise (a review-only agent must not look like it listens to the chat).
   */
  agentToolCall(): void {
    if (this.state === 'working') this.agentActivity();
  }

  /**
   * The agent waits up to `waitSec` for messages. `signal` aborts when its connection closes: the
   * wait is dropped and nothing is handed to it. `immediate`: answer `message` at once, with the
   * queued messages (maybe none) — a new connection's catch-up goes with it.
   */
  wait(
    params: ChatWaitParams = {},
    signal?: AbortSignal,
    immediate = false,
  ): Promise<ChatWaitResult> {
    const t = this.now();
    // The first wait, a new connection (`immediate`) or a restarted loop: the user just started
    // listening, so the idle time counts from now (not from when the app opened).
    if (!this.everListened || this.stopped || immediate) this.idleSince = t;
    this.everListened = true;
    this.lastAgentAt = t;
    this.stopped = false;
    this.settleInFlight(params.ack);
    const old = this.waiter;
    if (old) this.finish(old, { state: 'replaced', waitedSec: this.waitedSec(old) });
    if (signal?.aborted) {
      this.changed();
      return Promise.resolve({ state: 'replaced', waitedSec: 0 });
    }
    if (this.queued.length === 0 && t - this.idleSince >= this.idleStopMs)
      return Promise.resolve(this.stop());

    const id = this.nextWaitId++;
    this.log({
      event: 'wait_start',
      wait: id,
      waitSec: this.waitSecValue,
      queued: this.queued.length,
    });
    return new Promise<ChatWaitResult>((resolve) => {
      const timer = setTimeout(() => {
        const w = this.waiter;
        if (w?.id !== id) return;
        if (this.now() - this.idleSince >= this.idleStopMs) {
          this.finish(w, undefined);
          w.resolve(this.stop());
        } else this.finish(w, { state: 'waiting', waitedSec: this.waitedSec(w) });
      }, this.waitSecValue * 1000);
      const onAbort = (): void => {
        const w = this.waiter;
        if (w?.id !== id) return;
        this.log({ event: 'wait_cancelled', wait: id });
        this.finish(w, { state: 'replaced', waitedSec: this.waitedSec(w) });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiter = { id, startedAt: this.now(), resolve, timer, signal, onAbort };
      if (this.queued.length > 0 || immediate) this.deliver();
      else this.changed();
    });
  }

  /** Stop timers and answer an open wait `closed` (app quits). */
  dispose(): void {
    const w = this.waiter;
    if (w) this.finish(w, { state: 'closed', waitedSec: this.waitedSec(w) });
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = undefined;
  }

  /** A new wait: the last delivery reached the agent if it acks it; else hand it over again. */
  private settleInFlight(ack: number | undefined): void {
    const f = this.inFlight;
    if (!f) return;
    this.inFlight = undefined;
    if (ack === f.delivery) return;
    this.log({ event: 'resend', delivery: f.delivery, ids: f.messages.map((m) => m.id), ack });
    this.queued = [...f.messages, ...this.queued];
  }

  private stop(): ChatWaitResult {
    this.stopped = true;
    const idleSec = Math.round((this.now() - this.idleSince) / 1000);
    this.log({ event: 'stopped', idleSec });
    this.changed();
    return { state: 'stopped', idleSec };
  }

  /** How long `working` goes without a sign of the agent before it is `quiet`, ms. */
  private workingMs(): number {
    return Math.min(this.waitSecValue, CHAT_WORKING_QUIET_SECONDS) * 1000;
  }

  private waitedSec(w: Waiter): number {
    return Math.round((this.now() - w.startedAt) / 1000);
  }

  private deliver(): void {
    const w = this.waiter;
    if (!w || w.signal?.aborted) return;
    const messages = this.queued.splice(0);
    const delivery = this.nextDelivery++;
    this.inFlight = { delivery, messages };
    this.answered = false;
    const t = this.now();
    this.log({
      event: 'delivered',
      wait: w.id,
      delivery,
      ids: messages.map((m) => m.id),
      latencyMs: messages.map((m) => t - m.at),
    });
    this.finish(w, { state: 'message', delivery, messages });
  }

  /** End a wait; `result` undefined = the caller resolves it itself. */
  private finish(w: Waiter, result: ChatWaitResult | undefined): void {
    clearTimeout(w.timer);
    w.signal?.removeEventListener('abort', w.onAbort);
    if (this.waiter === w) this.waiter = undefined;
    this.lastAgentAt = this.now();
    if (result) {
      if (result.state !== 'message') this.log({ event: 'wait_end', wait: w.id, ...result });
      w.resolve(result);
    }
    this.changed();
  }

  private log(entry: ChatLogEntry): void {
    this.options.log?.({ t: this.now(), ...entry });
  }

  /** Tell the listener when anything it shows changed; re-check when the state would change by time. */
  private changed(): void {
    const next = this.snapshot();
    const last = this.lastSnapshot;
    if (
      !last ||
      last.state !== next.state ||
      last.quiet !== next.quiet ||
      last.waitSec !== next.waitSec ||
      last.queuedIds.join() !== next.queuedIds.join()
    ) {
      this.lastSnapshot = next;
      this.options.onChange?.(next);
    }
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = undefined;
    const dueMs = this.stateChangeDueMs(next);
    if (dueMs !== undefined)
      this.stateTimer = setTimeout(() => {
        this.stateTimer = undefined;
        this.changed();
      }, dueMs + 1);
  }

  /** When `listening` (between waits) runs out or `working` turns `quiet` without news, ms from now. */
  private stateChangeDueMs(s: ChatQueueSnapshot): number | undefined {
    if (this.waiter) return undefined;
    const { state } = s;
    const quiet = this.now() - this.lastAgentAt;
    if (state === 'working') return s.quiet ? undefined : Math.max(0, this.workingMs() - quiet);
    if (state === 'listening') return Math.max(0, this.graceMs - quiet);
    return undefined;
  }
}
