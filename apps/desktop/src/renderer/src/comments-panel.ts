/**
 * Comments section in the right panel, Onshape-style review list. A comment points at
 * markers (chips in their colours); "+ Comment" opens the writing box with the active marker
 * ticked — or, with a selection, a pending new marker "Comment N" holding it (made on Post).
 *
 * Card = [#n] [You / AI] [status] … [⌖] [✓ Resolve] [⋯] / text / marker chips / replies. Clicking a
 * card focuses it (the app highlights its markers, others fade), again = unfocus; ⌖ or ⋯ "Zoom to
 * markers" zooms to them (click alone shouldn't move the camera). Double-click edits and
 * leaves the card highlighted (its second click doesn't toggle the highlight off).
 * Resolved and won't-fix comments are dimmed and hidden unless "Show resolved" is on. Comments on
 * a clicked item in the view are tinted ("here") and scrolled into view, even when closed.
 *
 * The writing box sits above the list for new comments and edits, so redrawing the list (marker
 * or comment changes) never loses what is being typed.
 *
 * Replies (Google Docs-style): the thread sits under the card (collapsed to the latest reply
 * unless the card is highlighted); the highlighted card has a "Reply…" box at its bottom (one
 * element moved between redraws, unposted text kept per comment). Your own replies have ⋯ Edit /
 * Delete; a reply on a closed comment reopens it.
 */
import { MAX_LINKED_MODELS, type CommentStatus } from '@third-wheel/core';
import type { MenuEntry } from './context-menu.js';
import {
  liveMarkerIds,
  needsAttention,
  shownComments,
  STATUS_LABELS,
  type Comment,
  type CommentReply,
  type Comments,
} from './comments.js';
import { itemCount } from './markers-panel.js';
import type { Marker, Markers } from './markers.js';
import { CROSS, icon, TARGET } from './icons.js';
import { humanizeClassName } from './library/catalogue.js';
import { describePart } from './library/request.js';

export interface CommentsPanelHooks {
  /** Opens a dropdown menu under `anchor` (a second press on it closes it). */
  dropdown(anchor: HTMLElement, entries: readonly MenuEntry[]): void;
  /** Comment focused (highlight its markers) or unfocused (undefined). */
  focus(commentId: string | undefined): void;
  /** Zoom the view to the comment's markers (⌖ on the card, ⋯ "Zoom to markers"). */
  zoom(commentId: string): void;
  /** Post of "Comment on selection": make the "Comment N" marker and the comment (one undo step). */
  postOnSelection(
    text: string,
    markerIds: readonly string[],
    linkedModels: readonly string[],
  ): void;
  /**
   * The project's other parts a comment can link to (never the shown model's own part): name and
   * newest file name (the link is by file name and follows the part to new versions).
   */
  linkParts(): Promise<readonly LinkPart[]>;
  /** Opens a linked model if this window opened it before; false = it can't. */
  canOpenModel(name: string): boolean;
  openModel(name: string): void;
  /** "Show resolved" changed (to remember it). */
  showClosedChanged(show: boolean): void;
  /** Platform label of the post shortcut, e.g. "⌘ Enter". */
  readonly postKeyLabel: string;
  /** Platform label of the OS dictation key, e.g. "Win+H" (shown in the placeholder). */
  readonly dictationLabel: string;
}

/** A part a comment can link to. */
export interface LinkPart {
  readonly name: string;
  readonly fileName: string;
}

type Composer = { markerIds: string[]; linkedModels: string[] } & (
  | { mode: 'new' }
  | { mode: 'edit'; commentId: string }
  | { mode: 'selection'; newMarkerName: string; itemCount: number }
);

const AUTHOR_LABEL = { human: 'You', ai: 'AI' } as const;

/** Tag on a reply that changed the comment's status. */
const REPLY_STATUS_LABEL: Record<CommentStatus, string> = {
  open: 'Reopened',
  resolved: '✓ Resolved',
  wontfix: 'Won’t fix',
};

/** Replies shown on a card that isn't highlighted (the latest ones). */
const COLLAPSED_REPLIES = 1;

/** "16:57" today, else "8 Nov 16:57". */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * The AI closed the comment; the user checks the model and answers here. Confirm closes it
 * for good, Reopen sends it back to the AI as open.
 */
function confirmBar(c: Comment): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'comment-confirm-bar';
  const text = document.createElement('span');
  text.className = 'comment-confirm-text';
  text.textContent = c.status === 'wontfix' ? 'AI won’t fix this' : 'AI says it’s fixed';
  text.title = 'Check it in the model: Confirm closes the comment, Reopen sends it back to the AI.';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'marker-row-btn comment-confirm';
  confirm.dataset.action = 'confirm';
  confirm.textContent = '✓ Confirm';
  confirm.title = 'Agree with the AI: close it (hidden unless “Show resolved”)';
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'marker-row-btn comment-reopen';
  reopen.dataset.action = 'resolve';
  reopen.textContent = 'Reopen';
  reopen.title = 'Not done: open it again for the AI';
  bar.append(text, confirm, reopen);
  return bar;
}

export class CommentsPanel {
  private readonly list = document.createElement('ul');
  private readonly empty: HTMLElement;
  /** "+ Comment" (its tooltip follows the selection). */
  private addBtn: HTMLButtonElement | undefined;
  /** Items selected now: "+ Comment" comments on them when there are any. */
  private selectionSize = 0;
  private readonly footer = document.createElement('label');
  private readonly showClosedBox = document.createElement('input');
  private readonly showClosedText = document.createElement('span');
  private readonly hereBar = document.createElement('div');
  private readonly box = document.createElement('div');
  private readonly boxTitle = document.createElement('div');
  private readonly textarea = document.createElement('textarea');
  private readonly chips = document.createElement('div');
  private readonly markersBtn = document.createElement('button');
  private readonly linkBtn = document.createElement('button');
  private readonly postBtn = document.createElement('button');
  private composer: Composer | undefined;
  /** The parts the open comment box can link to (read when it opens). */
  private linkParts: readonly LinkPart[] = [];
  private readonly replyBox = document.createElement('div');
  private readonly replyInput = document.createElement('textarea');
  private readonly replyPostBtn = document.createElement('button');
  /** Comment whose card the reply box is in, and the reply being edited there (if any). */
  private replyFor: { commentId: string; replyId?: string } | undefined;
  /** Unposted reply text per comment (kept across redraws and focus changes). */
  private readonly replyDrafts = new Map<string, string>();
  private focused: string | undefined;
  /** Comments with an agent reply the user hasn't looked at (blue dot until highlighted). */
  private readonly unread = new Set<string>();
  private here = new Set<string>();

  constructor(
    section: HTMLElement,
    private readonly comments: Comments,
    private readonly markers: Markers,
    private readonly hooks: CommentsPanelHooks,
    private showClosed: boolean,
  ) {
    const heading = section.querySelector('h2');
    const empty = section.querySelector<HTMLElement>('.empty');
    if (!heading || !empty) throw new Error('comments section needs an h2 and .empty');
    this.empty = empty;
    empty.textContent = 'No comments yet. Mark something with Brush or a selection, then comment.';

    const header = document.createElement('div');
    header.className = 'panel-heading';
    heading.replaceWith(header);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'link-btn';
    add.id = 'comment-add';
    add.textContent = '+ Comment';
    // With a selection, "+ Comment" comments on it: a new marker holding the selection is made
    // on Post (Onshape: select, then comment); without one, the active marker.
    add.addEventListener('click', () => {
      if (this.selectionSize > 0 && this.hooksSelection) this.hooksSelection();
      else this.openNew();
    });
    this.addBtn = add;
    header.append(heading, add);
    this.setSelectionSize(0);

    this.buildBox();
    this.buildReplyBox();

    this.hereBar.className = 'comment-here-bar';
    this.hereBar.hidden = true;

    this.list.className = 'comment-list';
    this.list.setAttribute('aria-label', 'Comments');
    this.list.addEventListener('click', (e) => {
      this.onListClick(e);
    });
    this.list.addEventListener('keydown', (e) => {
      const card = (e.target as Element).closest<HTMLElement>('li[data-comment]');
      if (!card || e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleFocus(card.dataset.comment ?? '');
      }
    });

    this.footer.className = 'comment-show-closed';
    this.showClosedBox.type = 'checkbox';
    this.showClosedBox.id = 'comment-show-closed';
    this.showClosedBox.checked = showClosed;
    this.showClosedBox.addEventListener('change', () => {
      this.showClosed = this.showClosedBox.checked;
      this.hooks.showClosedChanged(this.showClosed);
      this.showClosedBox.blur(); // keep tool keys working
      this.render();
    });
    this.footer.append(this.showClosedBox, this.showClosedText);

    section.append(this.box, this.hereBar, this.list, this.footer);
    this.render();
  }

  /** Set by the app: comment on the selection (it calls `openOnSelection`). */
  hooksSelection: (() => void) | undefined;

  /** Current selection size: with a selection, "+ Comment" makes a marker of it on Post. */
  setSelectionSize(n: number): void {
    this.selectionSize = n;
    if (!this.addBtn) return;
    this.addBtn.title =
      n === 0
        ? 'Write a comment about one or more markers'
        : `Comment on the selection: a new marker holding it (${itemCount(n)}) is made when you post`;
  }

  get focusedId(): string | undefined {
    return this.focused;
  }

  /** "Show resolved" is ticked (pins follow it). */
  get showsClosed(): boolean {
    return this.showClosed;
  }

  /**
   * A 3D pin was clicked: same as clicking its card — highlight (again = off), the second
   * click of a double click edits and stays highlighted; the card scrolls into view.
   */
  pinClicked(id: string, detail: number): void {
    if (!this.comments.get(id)) return;
    if (detail >= 2) {
      if (this.focused !== id) this.setFocus(id);
      this.openEdit(id);
    } else this.toggleFocus(id);
    this.list
      .querySelector<HTMLElement>(`li[data-comment="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  /** Writing box for a new comment, active marker ticked. */
  openNew(): void {
    const active = this.markers.active();
    this.openComposer({ mode: 'new', markerIds: active ? [active.id] : [], linkedModels: [] }, '');
  }

  /** Writing box for a comment on the selection; the marker is made on Post. */
  openOnSelection(newMarkerName: string, count: number): void {
    if (count === 0) return;
    this.openComposer(
      { mode: 'selection', markerIds: [], linkedModels: [], newMarkerName, itemCount: count },
      '',
    );
  }

  openEdit(id: string): void {
    const c = this.comments.get(id);
    if (!c) return;
    const exists = (m: string): boolean => this.markers.get(m) !== undefined;
    this.openComposer(
      {
        mode: 'edit',
        commentId: id,
        markerIds: liveMarkerIds(c, exists),
        linkedModels: [...(c.linkedModels ?? [])],
      },
      c.text,
    );
  }

  /**
   * "Send review": text typed in the box but not posted goes out too — a new comment is
   * posted, an edit saved (like GitHub's "Submit review"). Returns what happened, if anything.
   */
  postDraft(): 'posted' | 'saved' | undefined {
    const replied = this.postReplyDrafts();
    const c = this.composer;
    if (!c || this.textarea.value.trim() === '') return replied;
    this.post();
    return c.mode === 'edit' && replied === undefined ? 'saved' : 'posted';
  }

  /** Unposted replies (and a reply being edited) go out with "Send review" too. */
  private postReplyDrafts(): 'posted' | 'saved' | undefined {
    let result: 'posted' | 'saved' | undefined;
    const f = this.replyFor;
    if (f?.replyId !== undefined && this.replyInput.value.trim() !== '') {
      if (this.comments.editReply(f.commentId, f.replyId, this.replyInput.value)) result = 'saved';
    }
    const drafts = [...this.replyDrafts];
    this.replyDrafts.clear();
    this.replyFor = undefined; // the box reloads (empty) on the next redraw
    this.replyInput.value = '';
    for (const [id, text] of drafts)
      if (text.trim() !== '' && this.comments.reply(id, text)) result = 'posted';
    return result;
  }

  /** Model opened: close the box, forget focus and "here". */
  reset(): void {
    this.closeComposer();
    this.replyDrafts.clear();
    this.replyFor = undefined;
    this.replyInput.value = '';
    this.focused = undefined;
    this.here = new Set();
    this.unread.clear();
    this.render();
  }

  /** The agent replied under this comment: a blue dot until the card is highlighted. */
  markUnread(id: string): void {
    if (id === this.focused || !this.comments.get(id)) return;
    this.unread.add(id);
    this.render();
  }

  /** Highlight a comment (never toggles it off) and scroll its card into view; false = no such comment. */
  reveal(id: string): boolean {
    if (!this.comments.get(id)) return false;
    if (this.focused !== id) this.setFocus(id);
    this.list
      .querySelector<HTMLElement>(`li[data-comment="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    return true;
  }

  /** Comments on the item clicked in the view (empty set = none / clear). Unfocuses. */
  setHere(ids: ReadonlySet<string>): void {
    this.here = new Set(ids);
    if (this.focused !== undefined) {
      this.focused = undefined;
      this.hooks.focus(undefined);
    }
    this.render();
    const first = this.list.querySelector<HTMLElement>('li.here');
    first?.scrollIntoView({ block: 'nearest' });
  }

  /** Redraws from the comments' and markers' current state. */
  render(): void {
    const all = this.comments.list();
    if (this.focused !== undefined && !this.comments.get(this.focused)) {
      this.focused = undefined;
      this.hooks.focus(undefined);
    }
    if (this.composer?.mode === 'edit' && !this.comments.get(this.composer.commentId)) {
      this.closeComposer();
    }
    for (const id of this.here) if (!this.comments.get(id)) this.here.delete(id);
    const keep = new Set(this.here);
    if (this.focused !== undefined) keep.add(this.focused);
    const shown = shownComments(all, this.showClosed, keep);
    // The AI's unconfirmed closes aren't closed yet (they stay listed, "Waiting for you").
    const closed = all.filter((c) => !needsAttention(c)).length;

    this.empty.hidden = all.length > 0;
    this.list.hidden = shown.length === 0;
    this.footer.hidden = closed === 0;
    this.showClosedText.textContent = `Show resolved (${String(closed)})`;
    const focusedEl = document.activeElement as HTMLElement | null;
    const typing = focusedEl === this.replyInput;
    const caret = [this.replyInput.selectionStart, this.replyInput.selectionEnd] as const;
    const focusedCard = focusedEl?.closest<HTMLElement>('li[data-comment]')?.dataset.comment;
    this.list.replaceChildren(...shown.map((c) => this.card(c)));
    if (!this.replyBox.isConnected) this.replyFor = undefined;
    if (typing && this.replyBox.isConnected) {
      this.replyInput.focus();
      this.replyInput.setSelectionRange(caret[0], caret[1]);
    } else if (focusedCard && !typing)
      this.list.querySelector<HTMLElement>(`li[data-comment="${focusedCard}"]`)?.focus();

    const hereCount = this.here.size;
    this.hereBar.hidden = hereCount === 0;
    if (hereCount > 0) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'link-btn';
      clear.textContent = 'Clear';
      clear.addEventListener('click', () => {
        this.setHere(new Set());
      });
      const text = document.createElement('span');
      text.textContent = `${String(hereCount)} ${hereCount === 1 ? 'comment' : 'comments'} on the clicked item`;
      this.hereBar.replaceChildren(text, clear);
    }
    if (this.composer) this.renderChips();
  }

  private card(c: Comment): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'comment-card';
    li.dataset.comment = c.id;
    li.dataset.status = c.status;
    li.tabIndex = 0;
    li.classList.toggle('focused', c.id === this.focused);
    li.classList.toggle('here', this.here.has(c.id));
    li.classList.toggle('closed', !needsAttention(c));
    li.classList.toggle('awaiting', c.awaitingConfirm === true);
    li.classList.toggle(
      'editing',
      this.composer?.mode === 'edit' && this.composer.commentId === c.id,
    );
    li.title =
      c.id === this.focused
        ? 'Click to stop highlighting · double-click to edit'
        : 'Click to highlight its markers and reply · double-click to edit';

    const head = document.createElement('div');
    head.className = 'comment-head';
    const num = document.createElement('span');
    num.className = 'comment-num';
    num.textContent = `#${String(this.comments.numberOf(c.id))}`;
    const author = document.createElement('span');
    author.className = `comment-author ${c.author}`;
    author.textContent = AUTHOR_LABEL[c.author];
    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = shortTime(c.createdAt);
    time.title = new Date(c.createdAt).toLocaleString();
    head.append(num);
    if (this.unread.has(c.id)) {
      const dot = document.createElement('span');
      dot.className = 'comment-unread';
      dot.title = 'New reply from the agent';
      dot.setAttribute('aria-label', 'New reply from the agent');
      head.append(dot);
    }
    head.append(author, time);
    if (c.awaitingConfirm) {
      // Not "Resolved" until the user confirms; the amber bar below says what the AI did.
      const status = document.createElement('span');
      status.className = 'comment-status awaiting';
      status.textContent = 'Waiting for you';
      status.title = `The AI set it to “${STATUS_LABELS[c.status]}” — Confirm or Reopen below`;
      head.append(status);
    } else if (c.status !== 'open') {
      const status = document.createElement('span');
      status.className = `comment-status ${c.status}`;
      status.textContent = STATUS_LABELS[c.status];
      head.append(status);
    }
    const spacer = document.createElement('span');
    spacer.className = 'comment-spacer';
    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'marker-icon-btn comment-zoom';
    zoom.dataset.action = 'zoom';
    zoom.title = 'Zoom to its markers';
    zoom.setAttribute('aria-label', `Zoom to the markers of comment ${num.textContent}`);
    zoom.append(icon(TARGET));
    zoom.hidden = !this.hasMarkers(c);
    const resolve = document.createElement('button');
    resolve.type = 'button';
    resolve.className = 'marker-row-btn comment-resolve';
    resolve.dataset.action = 'resolve';
    resolve.textContent = c.status === 'open' ? '✓ Resolve' : 'Reopen';
    resolve.title =
      c.status === 'open' ? 'Mark as resolved (hidden unless “Show resolved”)' : 'Open again';
    resolve.hidden = c.awaitingConfirm === true; // the confirm bar below asks instead
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'marker-row-btn comment-more';
    more.dataset.action = 'more';
    more.textContent = '⋯';
    more.title = 'More: edit, won’t fix, delete';
    more.setAttribute('aria-label', `More for comment ${num.textContent}`);
    more.setAttribute('aria-haspopup', 'menu');
    head.append(spacer, zoom, resolve, more);

    const text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = c.text;
    li.append(head, text);
    if (c.parts?.length) {
      const ul = document.createElement('ul');
      ul.className = 'comment-parts';
      for (const p of c.parts) {
        const item = document.createElement('li');
        item.textContent = describePart(p, humanizeClassName, (id) => this.markers.get(id)?.name);
        if (p.result) {
          const bodies = p.result.bodies?.length ? ` (${p.result.bodies.join(', ')})` : '';
          item.append(` — ${p.result.status}${bodies}`);
          if (p.result.note) {
            const note = document.createElement('div');
            note.className = 'comment-part-note';
            note.textContent = p.result.note;
            item.append(note);
          }
          item.dataset['result'] = p.result.status;
        }
        if (p.note) item.title = p.note;
        ul.append(item);
      }
      li.append(ul);
    }
    if (c.awaitingConfirm) li.append(confirmBar(c));

    const markers = liveMarkerIds(c, (id) => this.markers.get(id) !== undefined)
      .map((id) => this.markers.get(id))
      .filter((m): m is Marker => m !== undefined);
    const linked = c.linkedModels ?? [];
    if (markers.length > 0 || linked.length > 0) {
      const row = document.createElement('div');
      row.className = 'comment-chips';
      for (const m of markers) row.append(chip(m));
      for (const name of linked) row.append(this.linkedChip(name, true));
      li.append(row);
    }
    const thread = this.thread(c);
    if (thread) li.append(thread);
    if (c.id === this.focused) li.append(this.replyBoxFor(c));
    return li;
  }

  /** The replies under a card; only the latest unless the card is highlighted. */
  private thread(c: Comment): HTMLElement | undefined {
    const replies = c.replies ?? [];
    if (replies.length === 0) return undefined;
    const ol = document.createElement('ol');
    ol.className = 'comment-replies';
    const hidden = c.id === this.focused ? 0 : Math.max(0, replies.length - COLLAPSED_REPLIES);
    if (hidden > 0) {
      const more = document.createElement('li');
      more.className = 'comment-replies-more';
      more.textContent = `${String(hidden)} earlier ${hidden === 1 ? 'reply' : 'replies'} — click to show`;
      ol.append(more);
    }
    for (const r of replies.slice(hidden)) ol.append(this.replyItem(c, r));
    return ol;
  }

  private replyItem(c: Comment, r: CommentReply): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'comment-reply';
    li.dataset.reply = r.id;
    li.classList.toggle(
      'editing',
      this.replyFor?.commentId === c.id && this.replyFor.replyId === r.id,
    );
    const head = document.createElement('div');
    head.className = 'comment-head';
    const author = document.createElement('span');
    author.className = `comment-author ${r.author}`;
    author.textContent = AUTHOR_LABEL[r.author];
    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = shortTime(r.createdAt) + (r.updatedAt === r.createdAt ? '' : ' · edited');
    time.title = new Date(r.createdAt).toLocaleString();
    head.append(author, time);
    if (r.status) {
      const status = document.createElement('span');
      status.className = `comment-status ${r.status}`;
      status.textContent = REPLY_STATUS_LABEL[r.status];
      head.append(status);
    }
    if (r.author === 'human') {
      const spacer = document.createElement('span');
      spacer.className = 'comment-spacer';
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'marker-row-btn comment-more';
      more.dataset.action = 'reply-more';
      more.textContent = '⋯';
      more.title = 'More: edit, delete';
      more.setAttribute('aria-label', 'More for this reply');
      more.setAttribute('aria-haspopup', 'menu');
      head.append(spacer, more);
    }
    const text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = r.text;
    li.append(head, text);
    return li;
  }

  private onListClick(e: MouseEvent): void {
    const target = e.target as Element;
    const card = target.closest<HTMLElement>('li[data-comment]');
    const id = card?.dataset.comment;
    const c = id ? this.comments.get(id) : undefined;
    if (!card || !c) return;
    if (target.closest('.reply-box')) return; // typing a reply
    const action = target.closest<HTMLElement>('button[data-action]');
    const replyId = target.closest<HTMLElement>('li[data-reply]')?.dataset.reply;
    if (action?.dataset.action === 'reply-more' && replyId !== undefined) {
      this.hooks.dropdown(action, this.replyEntries(c, replyId));
    } else if (action?.dataset.action === 'zoom') {
      this.zoomTo(c.id);
    } else if (action?.dataset.action === 'confirm') {
      this.comments.confirm(c.id);
    } else if (action?.dataset.action === 'resolve') {
      this.comments.setStatus(c.id, c.status === 'open' ? 'resolved' : 'open');
    } else if (action?.dataset.action === 'more') {
      this.hooks.dropdown(action, this.moreEntries(c));
    } else if (!action) {
      // Second click of a double-click (the OS click count — the first click redrew the list, so
      // no dblclick event comes): edit, and stay highlighted instead of toggling off.
      if (e.detail >= 2) {
        if (this.focused !== c.id) this.setFocus(c.id);
        this.openEdit(c.id);
      } else this.toggleFocus(c.id);
    }
  }

  private moreEntries(c: Comment): MenuEntry[] {
    const status = (s: CommentStatus, label: string): MenuEntry => ({
      label,
      action: `status:${s}`,
      onSelect: () => {
        this.comments.setStatus(c.id, s);
      },
    });
    return [
      {
        label: 'Zoom to markers',
        action: 'zoom',
        disabled: !this.hasMarkers(c),
        onSelect: () => {
          this.zoomTo(c.id);
        },
      },
      {
        label: 'Edit',
        action: 'edit',
        onSelect: () => {
          this.openEdit(c.id);
        },
      },
      ...(c.awaitingConfirm
        ? [
            {
              label: 'Confirm',
              action: 'confirm',
              onSelect: () => {
                this.comments.confirm(c.id);
              },
            },
          ]
        : []),
      c.status === 'open' ? status('resolved', 'Resolve') : status('open', 'Reopen'),
      ...(c.status === 'wontfix' ? [] : [status('wontfix', 'Won’t fix')]),
      'separator',
      {
        label: 'Delete',
        action: 'delete',
        onSelect: () => {
          this.comments.remove(c.id);
        },
      },
    ];
  }

  private replyEntries(c: Comment, replyId: string): MenuEntry[] {
    return [
      {
        label: 'Edit',
        action: 'edit-reply',
        onSelect: () => {
          this.openReplyEdit(c.id, replyId);
        },
      },
      {
        label: 'Delete',
        action: 'delete-reply',
        onSelect: () => {
          this.comments.removeReply(c.id, replyId);
        },
      },
    ];
  }

  private toggleFocus(id: string): void {
    this.setFocus(this.focused === id ? undefined : id);
  }

  private setFocus(id: string | undefined): void {
    this.focused = id;
    if (id !== undefined) this.unread.delete(id);
    this.here = new Set();
    this.hooks.focus(id);
    this.render();
  }

  /** Highlight (if not yet) and zoom to the comment's markers. */
  private zoomTo(id: string): void {
    if (this.focused !== id) this.setFocus(id);
    this.hooks.zoom(id);
  }

  private hasMarkers(c: Comment): boolean {
    return liveMarkerIds(c, (id) => this.markers.get(id) !== undefined).length > 0;
  }

  // --- Reply box --------------------------------------------------------------

  private buildReplyBox(): void {
    this.replyBox.className = 'reply-box';
    this.replyInput.className = 'comment-input reply-input';
    this.replyInput.rows = 1;
    this.replyInput.setAttribute('aria-label', 'Reply');
    this.replyInput.addEventListener('input', () => {
      const f = this.replyFor;
      if (f && f.replyId === undefined) this.replyDrafts.set(f.commentId, this.replyInput.value);
      this.updateReplyPost();
    });
    this.replyBox.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // don't also clear the selection
        e.preventDefault();
        this.cancelReply();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.postReply();
      }
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.title = 'Cancel (Esc)';
    cancel.addEventListener('click', () => {
      this.cancelReply();
    });
    this.replyPostBtn.type = 'button';
    this.replyPostBtn.className = 'btn primary';
    this.replyPostBtn.id = 'reply-post';
    this.replyPostBtn.addEventListener('click', () => {
      this.postReply();
    });
    const buttons = document.createElement('div');
    buttons.className = 'comment-box-post reply-buttons';
    buttons.append(cancel, this.replyPostBtn);
    this.replyBox.append(this.replyInput, buttons);
  }

  /** The reply box, set up for `c` (its text is kept when it is already there). */
  private replyBoxFor(c: Comment): HTMLElement {
    const editing = this.replyFor?.commentId === c.id ? this.replyFor.replyId : undefined;
    if (editing !== undefined && !c.replies?.some((r) => r.id === editing)) {
      this.replyFor = undefined; // the reply was deleted (or undone) meanwhile
    }
    if (this.replyFor?.commentId !== c.id) {
      this.replyFor = { commentId: c.id };
      this.replyInput.value = this.replyDrafts.get(c.id) ?? '';
    }
    const isEdit = this.replyFor.replyId !== undefined;
    this.replyBox.classList.toggle('editing', isEdit);
    this.replyInput.placeholder = c.status === 'open' ? 'Reply…' : 'Reply… (reopens the comment)';
    this.replyPostBtn.textContent = isEdit ? 'Save' : 'Reply';
    this.replyPostBtn.title = `${this.replyPostBtn.textContent} (${this.hooks.postKeyLabel})`;
    this.updateReplyPost();
    return this.replyBox;
  }

  private openReplyEdit(commentId: string, replyId: string): void {
    const r = this.comments.get(commentId)?.replies?.find((x) => x.id === replyId);
    if (!r) return;
    this.replyFor = { commentId, replyId };
    this.replyInput.value = r.text;
    if (this.focused === commentId) this.render();
    else this.setFocus(commentId);
    this.replyInput.focus();
    this.replyInput.setSelectionRange(r.text.length, r.text.length);
  }

  /** Esc / Cancel: stop editing a reply, or drop the unposted reply. */
  private cancelReply(): void {
    const f = this.replyFor;
    if (!f) return;
    if (f.replyId === undefined) this.replyDrafts.delete(f.commentId);
    this.replyFor = { commentId: f.commentId };
    this.replyInput.value = this.replyDrafts.get(f.commentId) ?? '';
    this.replyInput.blur();
    this.render();
  }

  private postReply(): void {
    const f = this.replyFor;
    const text = this.replyInput.value;
    if (!f || text.trim() === '') return;
    if (f.replyId !== undefined) this.comments.editReply(f.commentId, f.replyId, text);
    else {
      this.replyDrafts.delete(f.commentId);
      this.comments.reply(f.commentId, text);
    }
    this.replyFor = { commentId: f.commentId };
    this.replyInput.value = '';
    this.replyInput.blur();
    this.render();
  }

  private updateReplyPost(): void {
    const empty = this.replyInput.value.trim() === '';
    this.replyPostBtn.disabled = empty;
    this.replyBox.classList.toggle('has-text', !empty);
  }

  // --- Writing box ------------------------------------------------------------

  private buildBox(): void {
    this.box.className = 'comment-box';
    this.box.hidden = true;
    this.boxTitle.className = 'comment-box-title';
    this.textarea.className = 'comment-input';
    this.textarea.rows = 3;
    this.textarea.placeholder = `What should change here? (or dictate: ${this.hooks.dictationLabel})`;
    this.textarea.setAttribute('aria-label', 'Comment text');
    this.textarea.addEventListener('input', () => {
      this.updatePost();
    });
    this.box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // don't also clear the selection
        e.preventDefault();
        this.closeComposer();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.post();
      }
    });

    this.chips.className = 'comment-chips';
    this.markersBtn.type = 'button';
    this.markersBtn.className = 'marker-row-btn comment-markers-btn';
    this.markersBtn.textContent = 'Markers ▾';
    this.markersBtn.title = 'Choose which markers this comment is about';
    this.markersBtn.addEventListener('click', () => {
      this.hooks.dropdown(this.markersBtn, this.markerChoices());
    });

    this.linkBtn.type = 'button';
    this.linkBtn.className = 'marker-row-btn comment-link-btn';
    this.linkBtn.textContent = '↔ Part ▾';
    this.linkBtn.title =
      'Link this comment to another part of this project, e.g. the part it must fit (the AI gets its newest file name)';
    this.linkBtn.addEventListener('click', () => {
      this.hooks.dropdown(this.linkBtn, this.linkChoices());
    });

    const buttons = document.createElement('div');
    buttons.className = 'comment-box-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.title = 'Cancel (Esc)';
    cancel.addEventListener('click', () => {
      this.closeComposer();
    });
    this.postBtn.type = 'button';
    this.postBtn.className = 'btn primary';
    this.postBtn.id = 'comment-post';
    this.postBtn.addEventListener('click', () => {
      this.post();
    });
    const post = document.createElement('div');
    post.className = 'comment-box-post';
    post.append(cancel, this.postBtn);
    buttons.append(this.markersBtn, this.linkBtn, post);
    this.box.append(this.boxTitle, this.textarea, this.chips, buttons);
  }

  private openComposer(composer: Composer, text: string): void {
    this.composer = composer;
    this.box.hidden = false;
    this.boxTitle.textContent =
      composer.mode === 'edit'
        ? `Edit comment #${String(this.comments.numberOf(composer.commentId))}`
        : composer.mode === 'selection'
          ? 'Comment on selection'
          : 'New comment';
    this.postBtn.textContent = composer.mode === 'edit' ? 'Save' : 'Comment';
    this.postBtn.title = `${this.postBtn.textContent} (${this.hooks.postKeyLabel})`;
    this.linkParts = [];
    this.linkBtn.hidden = composer.linkedModels.length === 0;
    void this.hooks.linkParts().then(
      (parts) => {
        if (this.composer !== composer) return; // closed or another box since
        this.linkParts = parts;
        this.linkBtn.hidden = this.linkChoices().length === 0;
      },
      (err: unknown) => {
        console.warn('Could not read the parts to link to', err);
      },
    );
    this.textarea.value = text;
    this.updatePost();
    this.render();
    this.box.scrollIntoView({ block: 'nearest' });
    this.textarea.focus();
    this.textarea.setSelectionRange(text.length, text.length);
  }

  private closeComposer(): void {
    if (!this.composer) return;
    const wasEdit = this.composer.mode === 'edit';
    this.composer = undefined;
    this.box.hidden = true;
    this.textarea.value = '';
    if (this.box.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    if (wasEdit) this.render();
  }

  private post(): void {
    const c = this.composer;
    const text = this.textarea.value;
    if (!c || text.trim() === '') return;
    const { markerIds, linkedModels } = c;
    if (c.mode === 'edit') this.comments.edit(c.commentId, { text, markerIds, linkedModels });
    else if (c.mode === 'selection') this.hooks.postOnSelection(text, markerIds, linkedModels);
    else this.comments.add(text, markerIds, 'human', linkedModels);
    this.closeComposer();
    this.render();
  }

  private updatePost(): void {
    this.postBtn.disabled = this.textarea.value.trim() === '';
  }

  private markerChoices(): MenuEntry[] {
    const c = this.composer;
    if (!c) return [];
    const list = this.markers.list();
    if (list.length === 0) return [{ label: 'No markers yet', disabled: true }];
    return list.map((m) => ({
      label: m.name,
      swatch: m.color,
      checked: c.markerIds.includes(m.id),
      action: `attach:${m.id}`,
      onSelect: () => {
        this.toggleMarker(m.id);
      },
    }));
  }

  /**
   * The project's other parts (by newest file), then names already linked that are none of them
   * (so they can be unticked).
   */
  private linkChoices(): MenuEntry[] {
    const c = this.composer;
    if (!c) return [];
    const full = c.linkedModels.length >= MAX_LINKED_MODELS;
    const linked = (name: string): boolean =>
      c.linkedModels.some((n) => n.toLowerCase() === name.toLowerCase());
    const entry = (fileName: string, label: string, detail?: string): MenuEntry => ({
      label,
      ...(detail !== undefined ? { detail } : {}),
      title: `Link to ${fileName}`,
      checked: linked(fileName),
      disabled: full && !linked(fileName),
      action: `link:${fileName}`,
      onSelect: () => {
        this.toggleLinked(fileName);
      },
    });
    const parts = this.linkParts.map((p) => entry(p.fileName, p.name, p.fileName));
    const known = new Set(this.linkParts.map((p) => p.fileName.toLowerCase()));
    const others = c.linkedModels
      .filter((n) => !known.has(n.toLowerCase()))
      .map((n) => entry(n, n));
    return [...parts, ...others];
  }

  private toggleLinked(name: string): void {
    const c = this.composer;
    if (!c) return;
    const lower = name.toLowerCase();
    c.linkedModels = c.linkedModels.some((n) => n.toLowerCase() === lower)
      ? c.linkedModels.filter((n) => n.toLowerCase() !== lower)
      : [...c.linkedModels, name];
    this.renderChips();
  }

  /** "↔ name" chip of a linked model: on a card it opens the model when it can. */
  private linkedChip(name: string, onCard: boolean): HTMLElement {
    const canOpen = onCard && this.hooks.canOpenModel(name);
    const el = document.createElement(canOpen ? 'button' : 'span');
    el.className = 'comment-chip linked';
    el.dataset.linkedModel = name;
    const label = document.createElement('span');
    label.className = 'comment-chip-name';
    label.textContent = `↔ ${name}`;
    el.append(label);
    el.title = canOpen ? `Linked model: ${name} — click to open it` : `Linked model: ${name}`;
    if (el instanceof HTMLButtonElement) {
      el.type = 'button';
      el.addEventListener('click', (e) => {
        e.stopPropagation(); // not a card click
        this.hooks.openModel(name);
      });
    }
    return el;
  }

  private toggleMarker(id: string): void {
    const c = this.composer;
    if (!c) return;
    c.markerIds = c.markerIds.includes(id)
      ? c.markerIds.filter((m) => m !== id)
      : [...c.markerIds, id];
    this.renderChips();
  }

  private renderChips(): void {
    const c = this.composer;
    if (!c) return;
    c.markerIds = c.markerIds.filter((id) => this.markers.get(id) !== undefined);
    const parts: HTMLElement[] = [];
    if (c.mode === 'selection') {
      const pending = document.createElement('span');
      pending.className = 'comment-chip pending';
      pending.textContent = `New marker “${c.newMarkerName}” (${itemCount(c.itemCount)})`;
      pending.title = 'Made from the selection when you post the comment';
      parts.push(pending);
    }
    for (const id of c.markerIds) {
      const m = this.markers.get(id);
      if (!m) continue;
      const el = chip(m);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comment-chip-remove';
      remove.title = `Remove ${m.name} from this comment`;
      remove.setAttribute('aria-label', remove.title);
      remove.append(icon(CROSS));
      remove.addEventListener('click', () => {
        this.toggleMarker(id);
      });
      el.append(remove);
      parts.push(el);
    }
    for (const name of c.linkedModels) {
      const el = this.linkedChip(name, false);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comment-chip-remove';
      remove.title = `Unlink ${name} from this comment`;
      remove.setAttribute('aria-label', remove.title);
      remove.append(icon(CROSS));
      remove.addEventListener('click', () => {
        this.toggleLinked(name);
      });
      el.append(remove);
      parts.push(el);
    }
    if (parts.length === 0) {
      const none = document.createElement('span');
      none.className = 'comment-chips-none';
      none.textContent = 'No marker — a general remark';
      parts.push(none);
    }
    this.chips.replaceChildren(...parts);
  }
}

function chip(m: Marker): HTMLElement {
  const el = document.createElement('span');
  el.className = 'comment-chip';
  el.dataset.marker = m.id;
  el.style.setProperty('--swatch', m.color);
  const name = document.createElement('span');
  name.className = 'comment-chip-name';
  name.textContent = m.name;
  el.title = m.name;
  el.append(name);
  return el;
}
