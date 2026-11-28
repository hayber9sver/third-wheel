/**
 * Comment threads. Earlier the AI's answer was a single `note` on the comment; it is
 * now the thread's first reply. Pure, shared by the app (sidecar load) and the review payload.
 */
import type { CommentReplyData, CommentStatus } from './schema.js';

/** The fields of a comment a thread is built from (sidecar or app form). */
export interface ThreadSource {
  readonly status: CommentStatus;
  readonly updatedAt: string;
  readonly note?: string | undefined;
  readonly replies?: readonly CommentReplyData[] | undefined;
}

/** "r<n>" one above the highest "r<n>" id in `replies` ("r1" for none). */
export function nextReplyId(replies: readonly { readonly id: string }[]): string {
  let max = 0;
  for (const r of replies) {
    const n = /^r(\d+)$/.exec(r.id)?.[1];
    if (n) max = Math.max(max, Number(n));
  }
  return `r${String(max + 1)}`;
}

/**
 * The comment's replies, oldest first, with an old single `note` as an AI reply in front (it was set
 * by `set_comment_status`, so it carries the status unless that is "open").
 */
export function commentThread(c: ThreadSource): CommentReplyData[] {
  const replies = [...(c.replies ?? [])];
  if (c.note === undefined || c.note.trim() === '') return replies;
  const note: CommentReplyData = {
    id: nextReplyId(replies),
    text: c.note,
    author: 'ai',
    createdAt: c.updatedAt,
    updatedAt: c.updatedAt,
    ...(c.status === 'open' ? {} : { status: c.status }),
  };
  return [note, ...replies];
}
