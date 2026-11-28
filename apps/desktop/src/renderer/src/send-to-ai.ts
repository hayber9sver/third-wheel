/**
 * The Send review button's bookkeeping. With a chat agent it sends the open comments the agent
 * hasn't had yet; without one it copies a ready-to-paste message naming every model the user
 * has open comments on in this session (two related parts reviewed one after the other, sent
 * together). Pure.
 */
import type { Comment } from './comments.js';

/** An open comment the agent hasn't had in its current state. */
export interface UnsentComment {
  readonly id: string;
  /** Card number. */
  readonly n: number;
  readonly key: string;
  readonly state: string;
}

export interface ReviewedFile {
  readonly path: string;
  readonly name: string;
  readonly openComments: number;
  readonly modelId?: string;
  /** Open comments not sent yet, as of when the model was last shown. */
  readonly unsent?: readonly UnsentComment[];
  /** Its project folder: models of another project drop out of the list. */
  readonly project?: string;
  /**
   * Its part, once the project lists it: versions of one part share their comments, so only the
   * version shown last counts.
   */
  readonly partId?: string;
}

/** A comment across versions: ids repeat between models, the creation time doesn't. */
export function commentKey(c: Comment): string {
  return `${c.id}@${c.createdAt}`;
}

/** Changes when the text, the status or the thread changes. */
export function commentState(c: Comment): string {
  return `${c.updatedAt}|${c.status}|${String(c.replies?.length ?? 0)}`;
}

/**
 * Comments the agent already has this app session: sent with Send review, named in a copied
 * message, or a thread reply that went to the chat. A comment counts again once it changes.
 */
export class SentComments {
  private readonly sent = new Map<string, string>();

  mark(c: Comment): void {
    this.sent.set(commentKey(c), commentState(c));
  }

  /** It didn't reach the agent after all: count it again. */
  forget(c: Comment): void {
    this.sent.delete(commentKey(c));
  }

  markUnsent(u: UnsentComment): void {
    this.sent.set(u.key, u.state);
  }

  /**
   * Open comments the agent doesn't have yet, in card order. One the AI wrote last (its own
   * comment, or its reply is the latest) is the agent's own news, not the user's.
   */
  unsent(comments: readonly Comment[]): UnsentComment[] {
    const out: UnsentComment[] = [];
    comments.forEach((c, i) => {
      if (c.status !== 'open') return;
      const lastBy = c.replies?.at(-1)?.author ?? c.author;
      if (lastBy === 'ai') return;
      const key = commentKey(c);
      const state = commentState(c);
      if (this.sent.get(key) !== state) out.push({ id: c.id, n: i + 1, key, state });
    });
    return out;
  }
}

/**
 * Models of the shown project seen this session and their open-comment counts, one per part (the
 * version shown last), in first-seen order.
 */
export class ReviewedFiles {
  private readonly files = new Map<string, ReviewedFile>();

  /**
   * Records the shown model's current count (an update keeps its place in the order). Another
   * version of the same part takes its place; a model of another project clears the others.
   */
  update(file: ReviewedFile): void {
    const { project, partId } = file;
    const key = project && partId ? `${project}\n${partId}` : file.path;
    for (const [k, f] of this.files) {
      if (k === key) continue;
      // Another project's models, and this file under another key (by path before the project
      // listed it; another part before Remove from versions / linking again).
      if ((project && f.project !== project) || f.path === file.path) this.files.delete(k);
    }
    this.files.set(key, file);
  }

  /**
   * Open comments not sent yet, on every model of this session. Each comment once: versions of one
   * part share its comments, and two of them can be listed here (e.g. right after a link joined
   * their parts, before the shown one's part is looked up again).
   */
  unsentCount(): number {
    const seen = new Set<string>();
    for (const f of this.files.values())
      for (const u of f.unsent ?? []) seen.add(`${f.project ?? ''}\n${u.key}`);
    return seen.size;
  }

  /** Models with something to send, with what (shown model first if it has any). */
  withUnsent(): ReviewedFile[] {
    return [...this.files.values()].filter((f) => (f.unsent?.length ?? 0) > 0);
  }

  /** Everything went to the agent: mark it sent. */
  markAllSent(sent: SentComments): void {
    for (const [key, f] of this.files) {
      for (const u of f.unsent ?? []) sent.markUnsent(u);
      this.files.set(key, { ...f, unsent: [] });
    }
  }

  /** Models with open comments, plus the shown one (always, even without comments). */
  forMessage(shownPath: string | undefined): ReviewedFile[] {
    return [...this.files.values()].filter((f) => f.openComments > 0 || f.path === shownPath);
  }
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** The message the user pastes into their AI chat. */
export function sendToAiMessage(files: readonly ReviewedFile[]): string {
  const how = (which: string): string =>
    `Please read them with the Third Wheel MCP tools: load_model on ${which}, then get_annotations.`;
  const [only] = files;
  if (files.length === 1 && only)
    return [
      `I reviewed ${only.name} in Third Wheel (${plural(only.openComments, 'open comment')}).`,
      `Path: ${only.path}`,
      how('that path'),
    ].join('\n');
  return [
    `I reviewed ${String(files.length)} models in Third Wheel; they belong together:`,
    ...files.map((f) => `- ${f.path} (${plural(f.openComments, 'open comment')})`),
    how('each path'),
  ].join('\n');
}

/** The chat line for Send review: "Review sent: 3 new comments on bracket.step, 1 on lid.step". */
export function reviewSentText(files: readonly ReviewedFile[]): string {
  const parts = files.map((f, i) => {
    const n = f.unsent?.length ?? 0;
    return i === 0 ? `${plural(n, 'new comment')} on ${f.name}` : `${String(n)} on ${f.name}`;
  });
  return `Review sent: ${parts.join(', ')}`;
}
