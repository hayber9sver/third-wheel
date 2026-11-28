/**
 * Review requests from the AI: `request_review` opens one, the user answers with "Send to
 * AI" (or dismisses it), `wait_for_review` long-polls for that answer. One request is open at a
 * time; a new one replaces the old. Pure (timers only) so it is unit-tested.
 */
import type { ReviewModelCount, ReviewState, WaitReviewResult } from '@third-wheel/core';

/** A model a request covers; `path` lets the banner open it again. */
export interface ReviewModel {
  readonly modelId: string;
  readonly name: string;
  readonly path: string;
}

export interface ReviewRequest {
  readonly id: string;
  /** The model the AI asked about first (shown when it asked). */
  readonly modelId: string;
  /** Every model of the request, `modelId`'s first; more than one = a multi-model review. */
  readonly models: readonly ReviewModel[];
  readonly message: string | undefined;
}

interface Settled {
  readonly state: Exclude<ReviewState, 'waiting'>;
  readonly modelId: string;
  readonly openComments?: number;
  readonly models?: readonly ReviewModelCount[];
  readonly reason?: string;
}

/** Finished requests remembered for a late `wait_for_review`. */
const KEEP_SETTLED = 20;

export class ReviewRequests {
  /** Called when the open request changes (show / hide the review bar). */
  onChange: ((open: ReviewRequest | undefined) => void) | undefined;
  private current: ReviewRequest | undefined;
  private readonly settled = new Map<string, Settled>();
  private readonly waiters = new Set<{ id: string; done: (r: WaitReviewResult) => void }>();
  private counter = 0;
  /** Ids differ across window reloads, so an old id can't match a new request. */
  private readonly session = Date.now().toString(36);

  open(): ReviewRequest | undefined {
    return this.current;
  }

  /** Opens a request for `models` (the first is the shown one), replacing an open one. */
  request(models: readonly [ReviewModel, ...ReviewModel[]], message?: string): ReviewRequest {
    this.cancel('Replaced by a newer review request');
    const text = message?.trim();
    const unique = models.filter((m, i) => models.findIndex((o) => o.modelId === m.modelId) === i);
    this.current = {
      id: `r${this.session}-${String(++this.counter)}`,
      modelId: models[0].modelId,
      models: unique,
      message: text === '' ? undefined : text,
    };
    this.onChange?.(this.current);
    return this.current;
  }

  /** Whether the open request covers `modelId` (opening it keeps the request). */
  covers(modelId: string): boolean {
    return this.current?.models.some((m) => m.modelId === modelId) ?? false;
  }

  /** The user clicked "Send review"; `counts` = open comments per model of the request. */
  send(counts: readonly ReviewModelCount[]): void {
    const openComments = counts.reduce((n, c) => n + c.openComments, 0);
    const several = (this.current?.models.length ?? 0) > 1;
    this.settle({ state: 'sent', openComments, ...(several ? { models: counts } : {}) });
  }

  /** The user dismissed it, or the model it was for went away. */
  cancel(reason: string): void {
    this.settle({ state: 'cancelled', reason });
  }

  /** Resolves when the request is settled, or with `waiting` after `timeoutMs`. */
  wait(reviewId: string, timeoutMs: number): Promise<WaitReviewResult> {
    const done = this.settled.get(reviewId);
    if (done) return Promise.resolve({ reviewId, ...done });
    const current = this.current;
    if (current?.id !== reviewId)
      return Promise.reject(new Error(`Unknown review "${reviewId}" — call request_review first`));
    return new Promise((resolve) => {
      const waiter = {
        id: reviewId,
        done: (r: WaitReviewResult): void => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        waiter.done({ reviewId, state: 'waiting', modelId: current.modelId });
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  private settle(how: Omit<Settled, 'modelId'>): void {
    const current = this.current;
    if (!current) return;
    this.current = undefined;
    const settled: Settled = { ...how, modelId: current.modelId };
    this.settled.set(current.id, settled);
    if (this.settled.size > KEEP_SETTLED) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
    for (const w of [...this.waiters])
      if (w.id === current.id) w.done({ reviewId: current.id, ...settled });
    this.onChange?.(undefined);
  }
}
