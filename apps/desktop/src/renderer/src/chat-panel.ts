/**
 * The Agent tab of the left panel: state line with "+ New topic" and 🕘 Earlier topics (the
 * project's topics; an earlier one shows read-only under a "Back to current topic" strip), help
 * boxes, conversation (user / agent bubbles with the agent's name, folded progress steps, model
 * event and join / leave lines, folded "Caught up" lines, the rail beside what the listening
 * connection received, "…" while working, permission hint, queued marks, "Show earlier
 * messages") and the message box (Enter = new line, Cmd/Ctrl+Enter or Send = send). Until a
 * project is open and an agent has listened this app session, a card replaces the message box
 * (Open folder… / connect steps with the start phrase). Talks to main through
 * `window.thirdWheel.chat*`.
 */
import { DEFAULT_CHAT_WAIT_SECONDS, MAX_CHAT_MESSAGE_LENGTH } from '@third-wheel/core';
import type { ChatAgentState } from '@third-wheel/core';
import {
  isChatMessage,
  type ChatCommentRef,
  type ChatEntry,
  type ChatEvent,
  type ChatListItem,
  type ChatStatus,
  type ChatView,
} from '../../shared/chat.js';
import type { MenuEntry } from './context-menu.js';
import {
  agentLabel,
  chatHelp,
  chatItems,
  chatLock,
  chatWhen,
  inputPlaceholder,
  isAnswer,
  LISTEN_COMMAND,
  PERMISSION_HINT_MS,
  refLabel,
  stateLine,
  stepsLabel,
  topicNote,
  unreadCount,
  type ChatItem,
  type ChatLock,
} from './chat-display.js';
import { renderChatMarkdown } from './chat-markdown.js';
import { isPrimaryShortcut } from '../../shared/shortcuts.js';

export interface ChatPanelOptions {
  readonly root: HTMLElement;
  /** "⌘↵" / "Ctrl+↵". */
  readonly sendKey: string;
  readonly isMac: boolean;
  /** Is the Chat tab visible right now (unread bookkeeping)? */
  readonly isShowing: () => boolean;
  /** The agent connected for the first time this session. */
  readonly onFirstConnect: () => void;
  /** Unread answers or the state dot changed (tab button). */
  readonly onBadge: (unread: number, dot: string) => void;
  /** "How to set it up…": the setup pop-up. */
  readonly openConnect: () => void;
  /** "Open folder…" on the card shown while no project is open. */
  readonly openFolder: () => void;
  readonly notice: (text: string) => void;
  /** "Replied under #3" / "Under #3" clicked: highlight that comment (open its model if needed). */
  readonly openComment: (ref: ChatCommentRef) => void;
  /** The agent's state changed (Send review button). */
  readonly onState: (state: ChatAgentState) => void;
  /** Every status from main (the Connect pop-up's live chat status). */
  readonly onStatus?: (status: ChatStatus) => void;
  /** Drop a menu down from a button (🕘 list). */
  readonly openMenu: (button: HTMLElement, entries: readonly MenuEntry[]) => void;
}

/** A saved chat shown read-only (🕘). */
interface PastChat {
  readonly id: string;
  readonly title: string;
  readonly when: string;
  entries: ChatEntry[];
  hasOlder: boolean;
}

export class ChatPanel {
  private entries: ChatEntry[] = [];
  /** The current chat has older lines than `entries`. */
  private hasOlder = false;
  private chatId: string | undefined;
  private inProject = false;
  /** The shown project's folder. */
  private project: string | undefined;
  /** A past chat being read (read-only), else the current chat shows. */
  private past: PastChat | undefined;
  /** Earlier topics of the shown project with agent answers not seen yet (by chat id). */
  private readonly topicUnread = new Map<string, number>();
  private loadingOlder = false;
  /** The project can't be written: one chat, kept until the app quits. */
  private unsaved = false;
  private status: ChatStatus = { state: 'none', waitSec: DEFAULT_CHAT_WAIT_SECONDS, queued: [] };
  private workingSince: number | undefined;
  private seenSeq = 0;
  private connected = false;
  /** Folded step lists the user opened (by the answer's seq), kept across re-renders. */
  private readonly openSteps = new Set<number>();
  /** Shows the permission hint when it is due. */
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  /** Permission hint delay, ms; the e2e test hook shortens it. */
  hintMs = PERMISSION_HINT_MS;
  private readonly stateEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly newBtn: HTMLButtonElement;
  private readonly historyBtn: HTMLButtonElement;
  private readonly pastEl: HTMLElement;
  private readonly composeEl: HTMLElement;
  private readonly lockEl: HTMLElement;
  /** The card built in `lockEl` (rebuilt only when it changes: keeps focus and selection). */
  private lockShown: ChatLock;

  constructor(private readonly o: ChatPanelOptions) {
    const q = (sel: string): HTMLElement => {
      const found = o.root.querySelector<HTMLElement>(sel);
      if (!found) throw new Error(`${sel} missing from the chat panel`);
      return found;
    };
    this.stateEl = q('#chat-state');
    this.logEl = q('#chat-log');
    this.input = q('#chat-input') as HTMLTextAreaElement;
    this.sendBtn = q('#chat-send') as HTMLButtonElement;
    this.newBtn = q('#chat-new') as HTMLButtonElement;
    this.historyBtn = q('#chat-history') as HTMLButtonElement;
    this.pastEl = q('#chat-past');
    this.composeEl = q('#chat-compose');
    this.lockEl = q('#chat-locked');
    this.newBtn.addEventListener('click', () => {
      void this.startNew();
    });
    this.historyBtn.addEventListener('click', () => {
      void this.openHistory();
    });
    q('#chat-back').addEventListener('click', () => {
      this.backToCurrent();
    });
    q('#chat-send-key').textContent = `${o.sendKey} to send`;
    this.sendBtn.addEventListener('click', () => {
      void this.send();
    });
    this.input.addEventListener('keydown', (e) => {
      if (isPrimaryShortcut(e, 'Enter', o.isMac) && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
      // Keys typed here never reach the viewport's shortcuts.
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => {
      this.sendBtn.disabled = this.input.value.trim() === '';
    });
    this.sendBtn.disabled = true;
    this.lockEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-copy]')) this.copy();
      if (target.closest('[data-connect]')) o.openConnect();
      if (target.closest('[data-open-folder]')) o.openFolder();
    });
    this.logEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-copy]')) this.copy();
      if (target.closest('[data-older]')) void this.loadOlder();
      const ref = target.closest<HTMLElement>('[data-ref]');
      if (ref) {
        const shown = this.past?.entries ?? this.entries;
        const entry = shown.find((x) => x.seq === Number(ref.dataset['ref']));
        if (entry?.ref) o.openComment(entry.ref);
      }
    });
    // The rail's length follows the lines (they re-wrap when the panel is resized).
    new ResizeObserver(() => {
      this.placeRail();
    }).observe(this.logEl);
    this.logEl.addEventListener(
      'toggle',
      (e) => {
        const d = e.target as HTMLDetailsElement;
        const seq = Number(d.dataset['seq']);
        if (d.open) this.openSteps.add(seq);
        else this.openSteps.delete(seq);
        this.placeRail();
      },
      true,
    );
  }

  /** Load the conversation so far and listen for changes. */
  async start(): Promise<void> {
    const api = window.thirdWheel;
    if (!api) return;
    api.onChatEvent((e) => {
      this.onEvent(e);
    });
    const view = await api.chatView();
    // Events may have arrived while loading; the view is complete up to now.
    const known = new Set(this.entries.map((e) => e.seq));
    this.entries = [...view.entries, ...this.entries.filter((e) => !known.has(e.seq))]
      .filter((e, i, all) => all.findIndex((x) => x.seq === e.seq) === i)
      .sort((a, b) => a.seq - b.seq);
    this.takeView(view, false);
    this.render(true);
  }

  /** Another chat is current (project switch, New chat), or the first view. */
  private takeView(view: ChatView, replace: boolean): void {
    if (replace) {
      const projectChanged = view.project !== this.project;
      this.entries = [...view.entries];
      this.openSteps.clear();
      // Lines read back from the project are not new answers.
      this.seenSeq = Math.max(0, ...this.entries.filter(isAnswer).map((e) => e.seq));
      if (projectChanged) {
        this.past = undefined;
        this.topicUnread.clear();
      }
    }
    this.hasOlder = view.hasOlder;
    this.chatId = view.chatId;
    this.inProject = view.inProject;
    this.project = view.project;
    this.unsaved = view.unsaved === true;
    this.setStatus(view.status);
  }

  /** The tab became visible or hidden. */
  shownChanged(): void {
    if (this.o.isShowing()) this.markSeen();
    this.badge();
  }

  focusInput(): void {
    this.input.focus();
  }

  /** The agent's name as people know it ("Claude Code"). */
  get agentName(): string {
    return agentLabel(this.status.agent);
  }

  /** The agent's state now. */
  get state(): ChatAgentState {
    return this.status.state;
  }

  /** Show an entry main just made (a thread reply, a sent review) without waiting for its event. */
  added(entry: ChatEntry): void {
    if (!this.entries.some((x) => x.seq === entry.seq)) this.entries.push(entry);
    this.render(false);
  }

  private onEvent(e: ChatEvent): void {
    if (e.kind === 'entry' && e.chatId !== undefined && e.chatId !== this.chatId) {
      this.earlierEntry(e.chatId, e.entry);
      return;
    }
    if (e.kind === 'entry') {
      if (!this.entries.some((x) => x.seq === e.entry.seq)) this.entries.push(e.entry);
    } else if (e.kind === 'reset') {
      this.takeView(e.view, true);
      this.render(true);
      return;
    } else this.setStatus(e.status);
    this.render(false);
  }

  /** A line of an earlier topic (the agent answered there): live when open, else counted. */
  private earlierEntry(chatId: string, entry: ChatEntry): void {
    const past = this.past;
    if (past?.id === chatId) {
      if (!past.entries.some((x) => x.seq === entry.seq)) past.entries.push(entry);
    } else if (isAnswer(entry)) {
      this.topicUnread.set(chatId, (this.topicUnread.get(chatId) ?? 0) + 1);
    }
    this.render(false);
  }

  // --- New chat, history, past chats ----------------------------------------------------------

  private async startNew(): Promise<void> {
    const ok = await window.thirdWheel?.chatNew();
    if (ok) {
      this.past = undefined;
      this.focusInput();
    }
  }

  private async openHistory(): Promise<void> {
    const api = window.thirdWheel;
    if (!api) return;
    let chats: ChatListItem[];
    try {
      chats = await api.chatList();
    } catch {
      chats = [];
    }
    const now = Date.now();
    const entries: MenuEntry[] = chats.length
      ? chats.map((c) => ({
          label: c.title || 'Topic',
          detail: c.current
            ? 'current'
            : this.topicUnread.get(c.id)
              ? `${String(this.topicUnread.get(c.id))} new · ${chatWhen(c.last, now)}`
              : chatWhen(c.last, now),
          checked: this.past ? this.past.id === c.id : c.current,
          title: `${c.title}\nStarted ${new Date(c.created).toLocaleString()} · last ${new Date(c.last).toLocaleString()}`,
          action: `chat-${c.id}`,
          onSelect: () => {
            if (c.current) this.backToCurrent();
            else void this.showPast(c, now);
          },
        }))
      : [{ label: 'No saved topics yet', disabled: true }];
    this.o.openMenu(this.historyBtn, entries);
  }

  private async showPast(c: ChatListItem, now: number): Promise<void> {
    const page = await window.thirdWheel?.chatRead(c.id);
    if (!page) return;
    this.past = {
      id: c.id,
      title: c.title || 'Topic',
      when: chatWhen(c.last, now),
      entries: [...page.entries],
      hasOlder: page.hasOlder,
    };
    this.topicUnread.delete(c.id);
    this.openSteps.clear();
    this.render(true);
  }

  /** Show topic `id` (the current one, or an earlier one read-only). */
  private async openTopic(id: string): Promise<void> {
    const chats = (await window.thirdWheel?.chatList().catch(() => [])) ?? [];
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    if (c.current) this.backToCurrent();
    else await this.showPast(c, Date.now());
  }

  private backToCurrent(): void {
    if (!this.past) return;
    this.past = undefined;
    this.render(true);
  }

  /** "Show earlier messages": the 200 lines before the first one shown. */
  private async loadOlder(): Promise<void> {
    const past = this.past;
    const id = past ? past.id : this.chatId;
    const shown = past ? past.entries : this.entries;
    const first = shown[0];
    if (!id || !first || this.loadingOlder) return;
    this.loadingOlder = true;
    try {
      const page = await window.thirdWheel?.chatRead(id, first.seq);
      if (!page || this.past !== past) return;
      const log = this.logEl;
      const fromBottom = log.scrollHeight - log.scrollTop;
      if (past) {
        past.entries = [...page.entries, ...past.entries];
        past.hasOlder = page.hasOlder;
      } else {
        const known = new Set(this.entries.map((e) => e.seq));
        this.entries = [...page.entries.filter((e) => !known.has(e.seq)), ...this.entries];
        this.hasOlder = page.hasOlder;
      }
      this.render(false);
      log.scrollTop = log.scrollHeight - fromBottom; // keep the lines the user was reading in place
    } finally {
      this.loadingOlder = false;
    }
  }

  private setStatus(status: ChatStatus): void {
    if (status.state === 'working' && this.status.state !== 'working')
      this.workingSince = Date.now();
    if (status.state !== 'working') this.workingSince = undefined;
    const changed = status.state !== this.status.state;
    this.status = status;
    this.o.onStatus?.(status);
    if (changed) this.o.onState(status.state);
    if (status.state !== 'none' && !this.connected) {
      this.connected = true;
      this.o.onFirstConnect();
    }
  }

  private async send(): Promise<void> {
    const text = this.input.value;
    if (text.trim() === '' || this.sending || chatLock(this.inProject, this.status)) return;
    // Take the text and clear the box first: a second Cmd/Ctrl+Enter can't send it twice.
    this.sending = true;
    this.input.value = '';
    this.sendBtn.disabled = true;
    let entry: ChatEntry | null | undefined;
    try {
      entry = await window.thirdWheel?.chatSend(text);
    } catch {
      entry = null; // shown as not sent below; the text comes back
    } finally {
      this.sending = false;
    }
    if (!entry) {
      // Give the text back unless the user started a new one meanwhile.
      if (this.input.value === '') this.input.value = text;
      this.sendBtn.disabled = this.input.value.trim() === '';
      this.o.notice(
        text.length > MAX_CHAT_MESSAGE_LENGTH
          ? 'Message not sent: it is too long.'
          : 'Message not sent. Try again.',
      );
      return;
    }
    if (!this.entries.some((x) => x.seq === entry.seq)) this.entries.push(entry);
    this.render(true);
  }

  /** Copy the start phrase. */
  private copy(): void {
    navigator.clipboard.writeText(LISTEN_COMMAND).then(
      () => {
        this.o.notice('Copied the start phrase. Paste it in your agent’s terminal.');
      },
      () => {
        this.o.notice(`Couldn’t copy. Type this in your agent’s terminal: ${LISTEN_COMMAND}`);
      },
    );
  }

  private markSeen(): void {
    if (this.past) return; // the current chat isn't on screen
    const lastAgent = this.entries.filter(isAnswer).at(-1);
    if (lastAgent) this.seenSeq = Math.max(this.seenSeq, lastAgent.seq);
  }

  private badge(): void {
    this.o.onBadge(unreadCount(this.entries, this.seenSeq), stateLine(this.status).dot);
  }

  private render(forceBottom: boolean): void {
    const log = this.logEl;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

    const line = stateLine(this.status);
    this.stateEl.dataset['dot'] = line.dot;
    const text = this.stateEl.querySelector('.chat-state-text');
    if (text) text.textContent = line.text;
    this.input.placeholder = inputPlaceholder(this.status);
    const hasMessages = this.entries.some(isChatMessage);
    this.newBtn.disabled = !this.inProject || this.unsaved || !hasMessages;
    this.newBtn.title = !this.inProject
      ? 'New topic: open a project first (topics are saved in its folder)'
      : this.unsaved
        ? 'New topic: this project is read-only, so its topic is kept until you quit'
        : `New topic\n${NEW_TOPIC_TIP}`;
    this.historyBtn.disabled = !this.inProject;
    let unreadEarlier = 0;
    for (const n of this.topicUnread.values()) unreadEarlier += n;
    this.historyBtn.title = !this.inProject
      ? 'Earlier topics: open a project first (topics are saved in its folder)'
      : unreadEarlier
        ? `Earlier topics of this project · ${String(unreadEarlier)} new ${unreadEarlier === 1 ? 'answer' : 'answers'}`
        : 'Earlier topics of this project';
    if (unreadEarlier) this.historyBtn.dataset['unread'] = String(unreadEarlier);
    else delete this.historyBtn.dataset['unread'];
    const past = this.past;
    this.pastEl.hidden = !past;
    const lock = past ? undefined : chatLock(this.inProject, this.status);
    this.composeEl.hidden = !!past || lock !== undefined;
    this.lockEl.hidden = lock === undefined;
    if (lock !== this.lockShown) {
      this.lockShown = lock;
      this.lockEl.replaceChildren(...(lock ? [lockCard(lock)] : []));
    }
    if (past) {
      const unread = unreadCount(this.entries, this.seenSeq);
      const back = this.pastEl.querySelector('#chat-back');
      if (back)
        back.textContent = unread
          ? `Back to current topic (${String(unread)} new)`
          : 'Back to current topic';
      const title = this.pastEl.querySelector('#chat-past-title');
      if (title) title.textContent = `Earlier topic · ${past.title} · read-only`;
      this.pastEl.title = `${past.title} · ${past.when} — read-only: new messages go to the current topic`;
    }

    const frag = document.createDocumentFragment();
    const help = past ? undefined : chatHelp(this.status, hasMessages);
    if (help) frag.append(helpBox(help));
    if (past ? past.hasOlder : this.hasOlder) {
      const older = document.createElement('button');
      older.type = 'button';
      older.className = 'link-btn chat-older';
      older.dataset['older'] = '1';
      older.textContent = 'Show earlier messages';
      frag.append(older);
    }
    const now = Date.now();
    // An earlier topic is read-only; it shows the "…" while the agent works on its message.
    const workedOn = past !== undefined && past.id === this.status.workingIn?.chatId;
    const pastStatus: ChatStatus = {
      state: workedOn ? 'working' : 'none',
      waitSec: this.status.waitSec,
      queued: [],
      ...(workedOn && this.status.quiet ? { quiet: true as const } : {}),
    };
    const items = chatItems({
      entries: past ? past.entries : this.entries,
      status: past ? pastStatus : this.status,
      now,
      hintMs: this.hintMs,
      ...(this.workingSince === undefined || (past && !workedOn)
        ? {}
        : { workingSince: this.workingSince }),
    });
    for (const item of items) {
      const el = this.itemEl(item);
      if (item.rail === 'before') el.classList.add('before-rail');
      if (item.rail === 'start' || item.rail === 'top') el.dataset['railStart'] = item.rail;
      frag.append(el);
    }
    log.replaceChildren(frag);
    log.classList.toggle(
      'has-rail',
      items.some((it) => it.rail && it.rail !== 'before'),
    );
    this.placeRail();

    // Re-draw once when the permission hint is due (not on a timer: that would drop a selection).
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    const working = items.find((it) => it.kind === 'working');
    if (working && !working.hint)
      this.hintTimer = setTimeout(
        () => {
          this.render(false);
        },
        Math.max(0, working.hintAt - now) + 50,
      );

    if (forceBottom || nearBottom) log.scrollTop = log.scrollHeight;
    if (this.o.isShowing()) this.markSeen();
    this.badge();
  }

  private itemEl(item: ChatItem): HTMLElement {
    switch (item.kind) {
      case 'user': {
        const wrap = div('chat-msg chat-user');
        wrap.dataset['seq'] = String(item.seq);
        const bubble = div('chat-bubble');
        bubble.textContent = item.text;
        wrap.append(bubble);
        if (item.queued) wrap.classList.add('queued');
        if (item.queuedNote) wrap.append(div('chat-note', item.queuedNote));
        return wrap;
      }
      case 'thread':
      case 'review': {
        const wrap = div(`chat-msg chat-user chat-${item.kind}`);
        wrap.dataset['seq'] = String(item.seq);
        if (item.ref)
          wrap.append(refButton(item.seq, `↳ You replied under ${refLabel(item.ref)}`, item.ref));
        const bubble = div('chat-bubble');
        bubble.textContent = item.text;
        wrap.append(bubble);
        if (item.queued) wrap.classList.add('queued');
        if (item.queuedNote) wrap.append(div('chat-note', item.queuedNote));
        return wrap;
      }
      case 'replied': {
        const wrap = div('chat-msg chat-agent chat-replied');
        wrap.dataset['seq'] = String(item.seq);
        wrap.append(refButton(item.seq, `↳ Replied under ${refLabel(item.ref)} →`, item.ref));
        if (item.steps.length) wrap.append(this.stepsEl(item.seq, item.steps));
        return wrap;
      }
      case 'agent': {
        const wrap = div('chat-msg chat-agent');
        wrap.dataset['seq'] = String(item.seq);
        if (item.name) wrap.append(agentNameEl(item.name));
        const bubble = div('chat-bubble chat-md');
        bubble.innerHTML = renderChatMarkdown(item.text); // escaped by renderChatMarkdown
        wrap.append(bubble);
        if (item.steps.length) wrap.append(this.stepsEl(item.seq, item.steps));
        return wrap;
      }
      case 'event': {
        const el = div('chat-msg chat-event', item.text);
        el.dataset['seq'] = String(item.seq);
        el.title = new Date(item.at).toLocaleString();
        return el;
      }
      case 'folded': {
        const d = document.createElement('details');
        d.className = 'chat-msg chat-event chat-folded';
        d.dataset['seq'] = String(item.seq);
        d.open = this.openSteps.has(item.seq);
        const sum = document.createElement('summary');
        sum.textContent = item.text;
        sum.title = new Date(item.at).toLocaleString();
        const body = div('chat-folded-body', item.detail);
        d.append(sum, body);
        return d;
      }
      case 'working-in':
      case 'answered-in': {
        const text = topicNote(
          item.kind === 'working-in' ? 'Working on your message' : 'Answered',
          item,
        );
        const id = item.chatId;
        const cls =
          item.kind === 'working-in' ? 'chat-working-in' : 'chat-working-in chat-answered-in';
        if (id === undefined) {
          const d = div(cls, text);
          if (item.kind === 'answered-in') d.dataset['seq'] = String(item.seq);
          return d;
        }
        const link = document.createElement('button');
        link.type = 'button';
        link.className = cls;
        link.textContent = text;
        if (item.kind === 'answered-in') {
          link.dataset['seq'] = String(item.seq);
          link.title = 'The agent answered there: your message was asked in that topic';
        }
        link.addEventListener('click', () => void this.openTopic(id));
        return link;
      }
      case 'steps': {
        const wrap = div('chat-msg chat-agent');
        wrap.append(this.stepsEl(item.seq, item.steps));
        return wrap;
      }
      case 'working': {
        const wrap = div('chat-msg chat-agent chat-working');
        const dots = div('chat-bubble chat-typing');
        dots.setAttribute('aria-label', 'The agent is working');
        dots.append(span(''), span(''), span(''));
        wrap.append(dots);
        if (item.latest) wrap.append(div('chat-progress', item.latest));
        if (item.quiet)
          wrap.append(
            div(
              'chat-hint',
              'No news for 10 min — check its terminal (a permission question, or it may have stopped).',
            ),
          );
        else if (item.hint)
          wrap.append(
            div(
              'chat-hint',
              'Taking a while? Your agent may be asking for permission in its terminal.',
            ),
          );
        return wrap;
      }
    }
  }

  /** The rail: one line from the first line the connection received down to the last. */
  private placeRail(): void {
    const log = this.logEl;
    log.querySelector('.chat-rail')?.remove();
    const start = log.querySelector<HTMLElement>('[data-rail-start]');
    if (!start || !log.classList.contains('has-rail')) return;
    const rail = div('chat-rail');
    rail.title = 'What this connection has received';
    const offTop = start.dataset['railStart'] === 'top';
    if (offTop) rail.classList.add('off-top');
    const top = offTop ? 0 : start.offsetTop;
    // Down to the last line, not to the bottom of an emptier panel.
    const last = log.lastElementChild as HTMLElement | null;
    const bottom = last ? last.offsetTop + last.offsetHeight : log.scrollHeight;
    rail.style.top = `${String(top)}px`;
    rail.style.height = `${String(Math.max(0, bottom - top))}px`;
    log.append(rail);
  }

  private stepsEl(seq: number, steps: readonly string[]): HTMLElement {
    const d = document.createElement('details');
    d.className = 'chat-steps';
    d.dataset['seq'] = String(seq);
    d.open = this.openSteps.has(seq);
    const s = document.createElement('summary');
    s.textContent = stepsLabel(steps.length);
    const list = document.createElement('ol');
    for (const step of steps) {
      const li = document.createElement('li');
      li.textContent = step;
      list.append(li);
    }
    d.append(s, list);
    return d;
  }
}

/** The New topic tooltip: the agent's memory is in its terminal. */
export const NEW_TOPIC_TIP =
  'Your agent keeps its memory. To make it forget, type /clear in its terminal.';

/** "Claude Code ⌨" above an answer: the agent runs in the user's terminal, not in the app. */
function agentNameEl(name: string): HTMLElement {
  const el = div('chat-agent-name');
  el.title = `${name} runs in your terminal — Third Wheel shows its answers here`;
  const mark = document.createElement('span');
  mark.className = 'chat-terminal-mark';
  mark.setAttribute('aria-label', 'from the terminal');
  mark.textContent = '>_';
  el.append(span(name), mark);
  return el;
}

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A link-like line that highlights the comment (full title + file in the tooltip). */
function refButton(seq: number, label: string, ref: ChatCommentRef): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chat-ref';
  b.dataset['ref'] = String(seq);
  b.textContent = label;
  b.title = `#${String(ref.n)} ${ref.title}\n${ref.file} · click to show the comment`;
  return b;
}

function span(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

/** The start phrase to paste, with a Copy button. */
function commandRow(): HTMLElement {
  const row = div('chat-command');
  const code = document.createElement('code');
  code.textContent = LISTEN_COMMAND;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'link-btn';
  copy.dataset['copy'] = '1';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', 'Copy the start phrase');
  row.append(code, copy);
  return row;
}

function linkButton(text: string, data: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-btn';
  b.dataset[data] = '1';
  b.textContent = text;
  return b;
}

/** The card in place of the message box: open a project first, or connect an agent. */
function lockCard(kind: 'project' | 'agent'): HTMLElement {
  const card = div('chat-help chat-lock-card');
  card.dataset['lock'] = kind;
  if (kind === 'project') {
    const p = document.createElement('p');
    p.className = 'chat-help-text';
    p.textContent = 'Open a project folder to talk to your agent.';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn';
    open.dataset['openFolder'] = '1';
    open.textContent = 'Open folder…';
    open.title = 'Open the folder with your models (chats are saved in it)';
    card.append(p, open);
    return card;
  }
  const head = document.createElement('p');
  head.className = 'chat-help-text chat-lock-head';
  head.textContent = 'Connect your agent to chat here';
  const steps = document.createElement('ol');
  steps.className = 'chat-lock-steps';
  const one = document.createElement('li');
  one.textContent = 'Start your agent (e.g. Claude Code) in this project’s folder.';
  const two = document.createElement('li');
  two.append('Paste this in its terminal:', commandRow());
  steps.append(one, two);
  const help = document.createElement('p');
  help.className = 'chat-help-text chat-lock-note';
  help.append('If your agent says it can’t find Third Wheel, add Third Wheel to it first: ');
  help.append(linkButton('How to set it up…', 'connect'));
  card.append(head, steps, help);
  return card;
}

function helpBox(kind: 'listening-empty' | 'restart'): HTMLElement {
  if (kind === 'listening-empty') {
    const box = div('chat-help');
    // One text block: the box lays its children out in a column.
    const p = document.createElement('p');
    p.className = 'chat-help-text';
    p.append(
      'Ask about the whole model here. About one spot: reply under its comment — the agent answers there. New comments go out with ',
    );
    const b = document.createElement('strong');
    b.textContent = 'Send review';
    p.append(b, '.');
    box.append(p);
    return box;
  }
  const box = div('chat-help warn');
  box.append('The agent stopped listening. Paste this in its terminal:', commandRow());
  return box;
}
