/**
 * Comments. Pure state — no DOM. A comment points at markers by id only (markers are
 * separate from comments): it may name any markers, none (a general
 * remark), and one marker may serve several comments. A deleted marker's id stays in the comment
 * (undoing the delete brings the link back); `liveMarkerIds` filters it for display.
 *
 * Every change reports `onEdit` with the state before and after (like `Markers`); the user's are
 * undoable, the AI's are not. Undo / redo go through `apply`, which keeps later AI edits.
 *
 * Each comment has a thread of replies, by the user or the AI. A user's reply on a
 * resolved / won't-fix comment reopens it (Google Docs; the AI reads open comments by default).
 */
import {
  MAX_COMMENT_LENGTH,
  MAX_LINKED_MODELS,
  MAX_PART_ITEMS,
  MAX_PART_TEXT,
  MAX_REPLIES,
  newId,
  nextReplyId,
  type CommentAuthor,
  type CommentReplyData,
  type CommentStatus,
  type PartItemData,
  type PartResult,
  type PartResultInput,
} from '@third-wheel/core';

export interface Comment {
  readonly id: string;
  readonly text: string;
  readonly markerIds: readonly string[];
  readonly status: CommentStatus;
  readonly author: CommentAuthor;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The thread, oldest first. Missing = none. */
  readonly replies?: readonly CommentReply[];
  /** Other model files this comment is about, by file name. Missing = none. */
  readonly linkedModels?: readonly string[];
  /** The AI closed it; the user hasn't confirmed yet. Missing = nothing to confirm. */
  readonly awaitingConfirm?: true;
  /** Parts the user asks the AI to add (part requests). Missing = none. */
  readonly parts?: readonly PartItemData[];
}

export type CommentReply = Readonly<CommentReplyData>;

export interface CommentsState {
  readonly items: readonly Comment[];
}

export interface CommentEdit {
  readonly kind:
    | 'add'
    | 'edit'
    | 'status'
    | 'confirm'
    | 'remove'
    | 'reply'
    | 'edit-reply'
    | 'remove-reply'
    | 'parts';
  readonly id: string;
  readonly before: CommentsState;
  readonly after: CommentsState;
  /** Who made it. The AI's edits are not undoable (undo is the user's own steps). */
  readonly by: CommentAuthor;
}

export const STATUS_LABELS: Record<CommentStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  wontfix: 'Won’t fix',
};

/** Undo-history labels per edit kind. */
export const COMMENT_EDIT_LABELS: Record<CommentEdit['kind'], string> = {
  add: 'Add comment',
  edit: 'Edit comment',
  status: 'Comment status',
  confirm: 'Confirm fix',
  remove: 'Delete comment',
  reply: 'Reply',
  'edit-reply': 'Edit reply',
  'remove-reply': 'Delete reply',
  parts: 'Part results',
};

/** Trimmed (ends only; line breaks inside stay), length-capped; empty → undefined. */
export function cleanCommentText(text: string): string | undefined {
  const t = text.trim().slice(0, MAX_COMMENT_LENGTH);
  return t === '' ? undefined : t;
}

/** "Comment N" with N one above the highest "Comment N" name in `names`. */
export function nextCommentMarkerName(names: Iterable<string>): string {
  let max = 0;
  for (const name of names) {
    const n = /^Comment (\d+)$/.exec(name)?.[1];
    if (n) max = Math.max(max, Number(n));
  }
  return `Comment ${String(max + 1)}`;
}

/** The comment's marker ids that still exist, in the comment's order. */
export function liveMarkerIds(comment: Comment, exists: (id: string) => boolean): string[] {
  return comment.markerIds.filter(exists);
}

/** Comments naming any of `markerIds` (list order). */
export function commentsOnMarkers(
  comments: readonly Comment[],
  markerIds: ReadonlySet<string>,
): Comment[] {
  return comments.filter((c) => c.markerIds.some((id) => markerIds.has(id)));
}

/** Open, or closed by the AI and not confirmed yet: always shown. */
export function needsAttention(c: Comment): boolean {
  return c.status === 'open' || c.awaitingConfirm === true;
}

/**
 * Shown in the list: open ones and the AI's unconfirmed closes; resolved / won't-fix only with
 * `showClosed`, or when `keep` names them.
 */
export function shownComments(
  comments: readonly Comment[],
  showClosed: boolean,
  keep: ReadonlySet<string> = new Set(),
): Comment[] {
  return comments.filter((c) => showClosed || needsAttention(c) || keep.has(c.id));
}

/**
 * Resolved markers: named by at least one comment, and every comment naming them is closed
 * (resolved / won't fix, confirmed — the AI's unconfirmed close still counts as open). Worked out
 * from the comments each time, never stored: reopening or undo brings a marker back by itself.
 * A resolved marker is hidden (faded with "Show resolved") and can't be painted or added to.
 */
export function resolvedMarkerIds(comments: readonly Comment[]): Set<string> {
  const closed = new Set<string>();
  const open = new Set<string>();
  for (const c of comments) {
    const into = needsAttention(c) ? open : closed;
    for (const id of c.markerIds) into.add(id);
  }
  for (const id of open) closed.delete(id);
  return closed;
}

/** `c` without the awaiting-confirm flag. */
function withoutConfirm(c: Comment): Comment {
  const next = { ...c };
  delete (next as { awaitingConfirm?: true }).awaitingConfirm;
  return next;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export class Comments {
  private items: Comment[] = [];
  /**
   * Highest reply number handed out per comment this session: an undone reply's id is not
   * reused, so a later AI reply never takes it (undo / redo match replies by id).
   */
  private replyNumbers = new Map<string, number>();
  /** Called after every change. */
  onChange: ((comments: readonly Comment[]) => void) | undefined;
  /** Called for each change (all are undoable), before `onChange`. */
  onEdit: ((edit: CommentEdit) => void) | undefined;

  /** `makeId`: a new comment's id — random, unique in the project (tests pass a counter). */
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = () => newId(),
  ) {}

  /** Empty list (opening a model). Ids are random: never reused. */
  reset(): void {
    this.items = [];
    this.replyNumbers.clear(); // a new model: the undo history is cleared too
    this.emit();
  }

  /** Comments read from a sidecar. Not undoable. */
  load(items: readonly Comment[]): void {
    this.items = [...items];
    this.replyNumbers.clear();
    this.emit();
  }

  state(): CommentsState {
    return { items: this.items };
  }

  /** Puts back a list from `state()` (undo / redo). */
  restore(state: CommentsState): void {
    this.items = [...state.items];
    this.emit();
  }

  list(): readonly Comment[] {
    return this.items;
  }

  get(id: string): Comment | undefined {
    return this.items.find((c) => c.id === id);
  }

  /** 1-based position in the list (what the panel and the 3D pins show). */
  numberOf(id: string): number {
    return this.items.findIndex((c) => c.id === id) + 1;
  }

  /** Adds an open comment; undefined (nothing added) for empty text. */
  add(
    text: string,
    markerIds: readonly string[],
    author: CommentAuthor = 'human',
    linkedModels: readonly string[] = [],
    parts: readonly PartItemData[] = [],
  ): Comment | undefined {
    const clean = cleanCommentText(text);
    if (clean === undefined) return undefined;
    const before = this.state();
    let id = this.makeId();
    while (this.get(id)) id = this.makeId();
    const at = this.now().toISOString();
    const comment: Comment = {
      id,
      text: clean,
      markerIds: uniqueIds(markerIds),
      status: 'open',
      author,
      createdAt: at,
      updatedAt: at,
      ...linkedField(linkedModels),
      ...(parts.length > 0 ? { parts: parts.slice(0, MAX_PART_ITEMS) } : {}),
    };
    this.items = [...this.items, comment];
    this.edited('add', comment.id, before, author);
    this.emit();
    return comment;
  }

  /**
   * Changes text, markers and / or linked models. Empty text is ignored. Returns whether anything
   * changed.
   */
  edit(
    id: string,
    change: { text?: string; markerIds?: readonly string[]; linkedModels?: readonly string[] },
  ): boolean {
    const old = this.get(id);
    if (!old) return false;
    const text = change.text === undefined ? old.text : cleanCommentText(change.text);
    if (text === undefined) return false;
    const markerIds = change.markerIds ? uniqueIds(change.markerIds) : old.markerIds;
    const linked = change.linkedModels
      ? uniqueIds(change.linkedModels).slice(0, MAX_LINKED_MODELS)
      : (old.linkedModels ?? []);
    const same =
      text === old.text &&
      sameList(markerIds, old.markerIds) &&
      sameList(linked, old.linkedModels ?? []);
    if (same) return false;
    const next: Comment = { ...old, text, markerIds, ...linkedField(linked) };
    if (linked.length === 0) delete (next as { linkedModels?: readonly string[] }).linkedModels;
    return this.replace(id, next, 'edit', 'human');
  }

  /**
   * Sets the status. A note (the AI's "added a 2 mm fillet") becomes a reply by `author` that
   * carries the new status, in the same undo step. Returns whether anything changed.
   */
  /**
   * The AI's results for requested parts (part requests): each goes on its part as `result`. All
   * part ids must exist (nothing is written otherwise). Returns how many parts changed.
   */
  setPartResults(id: string, results: readonly PartResultInput[]): number {
    const old = this.get(id);
    if (!old) return 0;
    const parts = old.parts ?? [];
    const unknown = results.filter((r) => !parts.some((p) => p.id === r.partId));
    if (unknown.length > 0) {
      throw new Error(
        `Comment "${id}" has no part ${unknown.map((r) => `"${r.partId}"`).join(', ')}; its parts are ${parts.map((p) => `"${p.id}"`).join(', ') || 'none'}`,
      );
    }
    const at = this.now().toISOString();
    let changed = 0;
    const next = parts.map((p) => {
      const r = results.findLast((x) => x.partId === p.id);
      if (!r) return p;
      const result: PartResult = {
        status: r.status,
        ...(r.bodies?.length ? { bodies: r.bodies } : {}),
        ...(r.note?.trim() ? { note: r.note.trim().slice(0, MAX_PART_TEXT) } : {}),
        updatedAt: at,
      };
      const same =
        p.result?.status === result.status &&
        sameValue(p.result.bodies, result.bodies) &&
        p.result.note === result.note;
      if (same) return p;
      changed += 1;
      return { ...p, result };
    });
    if (changed === 0) return 0;
    const before = this.state();
    this.items = this.items.map((c) => (c.id === id ? { ...c, parts: next, updatedAt: at } : c));
    this.edited('parts', id, before, 'ai');
    this.emit();
    return changed;
  }

  setStatus(
    id: string,
    status: CommentStatus,
    note?: string,
    author: CommentAuthor = 'human',
  ): boolean {
    const old = this.get(id);
    if (!old) return false;
    const clean = note === undefined ? undefined : cleanCommentText(note);
    const last = old.replies?.at(-1);
    // A retry with the same note adds nothing; a full thread still takes the status change.
    const repeat =
      last?.author === author && last.text === clean && (last.status ?? old.status) === status;
    const full = (old.replies?.length ?? 0) >= MAX_REPLIES;
    const text = repeat || full ? undefined : clean;
    // The AI closing a comment waits for the user's Confirm; any user status ends that.
    const awaiting = author === 'ai' ? status !== 'open' : false;
    if (old.status === status && text === undefined && (old.awaitingConfirm === true) === awaiting)
      return false;
    const replies =
      text === undefined
        ? old.replies
        : [...(old.replies ?? []), this.newReply(old, text, author, status)];
    const next: Comment = { ...withoutConfirm(old), status, ...repliesField(replies) };
    return this.replace(id, awaiting ? { ...next, awaitingConfirm: true } : next, 'status', author);
  }

  /**
   * The user agrees with the AI's resolved / won't fix: the comment closes for good (hidden
   * unless "Show resolved"). Returns whether anything changed.
   */
  confirm(id: string): boolean {
    const old = this.get(id);
    if (!old?.awaitingConfirm) return false;
    return this.replace(id, withoutConfirm(old), 'confirm', 'human');
  }

  /**
   * Adds a reply to the comment's thread; undefined (nothing added) for empty text, an unknown
   * comment or a full thread. A user's reply on a closed comment reopens it (same undo step); the
   * AI's reply never changes the status.
   */
  reply(id: string, text: string, author: CommentAuthor = 'human'): CommentReply | undefined {
    const old = this.get(id);
    const clean = cleanCommentText(text);
    if (!old || clean === undefined || (old.replies?.length ?? 0) >= MAX_REPLIES) return undefined;
    const reopen = author === 'human' && old.status !== 'open';
    const reply = this.newReply(old, clean, author, reopen ? 'open' : undefined);
    const next: Comment = {
      ...(reopen ? withoutConfirm(old) : old),
      ...(reopen ? { status: 'open' as const } : {}),
      replies: [...(old.replies ?? []), reply],
    };
    this.replace(id, next, 'reply', author);
    return reply;
  }

  /** Changes a reply's text (empty text is ignored). Returns whether anything changed. */
  editReply(id: string, replyId: string, text: string): boolean {
    const old = this.get(id);
    const reply = old?.replies?.find((r) => r.id === replyId);
    const clean = cleanCommentText(text);
    if (!old || !reply || clean === undefined || clean === reply.text) return false;
    const at = this.now().toISOString();
    const replies = (old.replies ?? []).map((r) =>
      r.id === replyId ? { ...r, text: clean, updatedAt: at } : r,
    );
    return this.replace(id, { ...old, replies }, 'edit-reply', 'human');
  }

  /** Deletes a reply (the status it carried stays). Returns whether anything changed. */
  removeReply(id: string, replyId: string): boolean {
    const old = this.get(id);
    if (!old?.replies?.some((r) => r.id === replyId)) return false;
    const replies = old.replies.filter((r) => r.id !== replyId);
    const next: Comment = { ...old, ...repliesField(replies) };
    if (replies.length === 0) delete (next as { replies?: readonly CommentReply[] }).replies;
    return this.replace(id, next, 'remove-reply', 'human');
  }

  private nextReplyIdFor(c: Comment): string {
    const fromThread = Number(nextReplyId(c.replies ?? []).slice(1));
    const n = Math.max(fromThread, (this.replyNumbers.get(c.id) ?? 0) + 1);
    this.replyNumbers.set(c.id, n);
    return `r${String(n)}`;
  }

  private newReply(
    c: Comment,
    text: string,
    author: CommentAuthor,
    status: CommentStatus | undefined,
  ): CommentReply {
    const at = this.now().toISOString();
    return {
      id: this.nextReplyIdFor(c),
      text,
      author,
      createdAt: at,
      updatedAt: at,
      ...(status === undefined ? {} : { status }),
    };
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    const before = this.state();
    this.items = this.items.filter((c) => c.id !== id);
    this.edited('remove', id, before, 'human');
    this.emit();
    return true;
  }

  private replace(
    id: string,
    next: Comment,
    kind: Exclude<CommentEdit['kind'], 'add' | 'remove'>,
    by: CommentAuthor,
  ): boolean {
    const before = this.state();
    const stamped = { ...next, updatedAt: this.now().toISOString() };
    this.items = this.items.map((c) => (c.id === id ? stamped : c));
    this.edited(kind, id, before, by);
    this.emit();
    return true;
  }

  private edited(
    kind: CommentEdit['kind'],
    id: string,
    before: CommentsState,
    by: CommentAuthor,
  ): void {
    this.onEdit?.({ kind, id, before, after: this.state(), by });
  }

  /**
   * Takes back what one edit changed (`from` → `to` = its after → before for undo, before → after
   * for redo) without touching what happened since — the AI's replies and status changes are not
   * on the undo history, so a plain `restore` would wipe them.
   */
  apply(from: CommentsState, to: CommentsState): void {
    this.items = [...rebaseComments(this.items, from.items, to.items)];
    this.emit();
  }

  private emit(): void {
    this.onChange?.(this.items);
  }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `linkedModels` only when there are any (the sidecar leaves an empty list out), at most
 * `MAX_LINKED_MODELS` (more would make the sidecar unreadable).
 */
function linkedField(names: readonly string[]): { linkedModels?: readonly string[] } {
  const unique = uniqueIds(names).slice(0, MAX_LINKED_MODELS);
  return unique.length > 0 ? { linkedModels: unique } : {};
}

/** `replies` only when there are any. */
function repliesField(replies: readonly CommentReply[] | undefined): {
  replies?: readonly CommentReply[];
} {
  return replies && replies.length > 0 ? { replies } : {};
}

/** Comment fields a step may change (besides replies); compared by value. */
const MERGED_FIELDS = [
  'text',
  'markerIds',
  'status',
  'linkedModels',
  'awaitingConfirm',
  'parts',
  'updatedAt',
] as const;

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies the change `from` → `to` onto `current`: each field the change touched goes to
 * its `to` value unless something else changed it since (then that later value stays); replies
 * merge by id, so replies added after the step stay. Comments the step added are removed (with
 * any later replies), comments it removed come back at their old place. Pure.
 */
export function rebaseComments(
  current: readonly Comment[],
  from: readonly Comment[],
  to: readonly Comment[],
): Comment[] {
  const fromById = new Map(from.map((c) => [c.id, c]));
  const toById = new Map(to.map((c) => [c.id, c]));
  const out: Comment[] = [];
  for (const c of current) {
    const f = fromById.get(c.id);
    const t = toById.get(c.id);
    if (f && !t) continue; // the step added it
    out.push(f && t ? mergeComment(c, f, t) : c);
  }
  // Comments the step removed: back after the comment that preceded them in `to`.
  to.forEach((t, i) => {
    if (fromById.has(t.id) || out.some((c) => c.id === t.id)) return;
    const prev = to[i - 1]?.id;
    const prevAt = prev === undefined ? -1 : out.findIndex((c) => c.id === prev);
    out.splice(prev !== undefined && prevAt < 0 ? out.length : prevAt + 1, 0, t);
  });
  return out;
}

function mergeComment(current: Comment, from: Comment, to: Comment): Comment {
  const next: Record<string, unknown> = { ...current };
  for (const key of MERGED_FIELDS) {
    if (sameValue(from[key], to[key]) || !sameValue(current[key], from[key])) continue;
    next[key] = to[key];
  }
  const replies = mergeReplies(current.replies ?? [], from.replies ?? [], to.replies ?? []);
  next.replies = replies.length > 0 ? replies : undefined;
  // Optional fields are left out, not undefined (the sidecar and tests compare shapes).
  return Object.fromEntries(
    Object.entries(next).filter(([, v]) => v !== undefined),
  ) as unknown as Comment;
}

function mergeReplies(
  current: readonly CommentReply[],
  from: readonly CommentReply[],
  to: readonly CommentReply[],
): CommentReply[] {
  const fromById = new Map(from.map((r) => [r.id, r]));
  const toById = new Map(to.map((r) => [r.id, r]));
  const out: CommentReply[] = [];
  for (const r of current) {
    const f = fromById.get(r.id);
    const t = toById.get(r.id);
    if (f && !t) continue; // the step added it
    out.push(f && t && sameValue(r, f) ? t : r);
  }
  for (const t of to) {
    if (!fromById.has(t.id) && !out.some((r) => r.id === t.id)) out.push(t);
  }
  // Oldest first, as the thread shows them (ids count up, times can tie).
  return out.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || replyNumber(a) - replyNumber(b),
  );
}

const replyNumber = (r: CommentReply): number => Number(/\d+/.exec(r.id)?.[0] ?? 0);
