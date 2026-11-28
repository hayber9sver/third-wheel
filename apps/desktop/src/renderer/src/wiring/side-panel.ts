/**
 * AI status, the Connect pop-up, and the floating left panel (Bodies | Agent chat).
 */
import { setupAiConnect } from '../ai-connect.js';
import { setupAbout } from '../about.js';
import { setupFeedback } from '../feedback.js';
import { LeftPanel, LEFT_PANEL_STORAGE_KEY } from '../left-panel.js';
import { ChatPanel } from '../chat-panel.js';
import type { ChatCommentRef } from '../../../shared/chat.js';
import { type ReviewPayload, commentPayload } from '@third-wheel/geometry';
import {
  askChoice,
  byId,
  comments,
  commentsPanel,
  isMac,
  loadSetting,
  openDropdown,
  openFolderDialog,
  renderSendToAi,
  reopenModel,
  reviews,
  saveSetting,
  sent,
  shownFile,
  shownModel,
  showNotice,
  shownPart,
  shownPath,
  shownProject,
  shownReview,
  viewport,
} from '../main.js';

// --- AI status + "Set up your AI agent" pop-up ------------------------------------
export const aiConnect = setupAiConnect(
  () => shownPath,
  () => shownProject?.folder,
);
setupAbout();
/** Help ▸ Send feedback… and the start page's link. */
export const feedback = setupFeedback({
  // The agent's name once one connected this session ("Agent" = name unknown: left out).
  agent: () => {
    const name = chatPanel.state === 'none' ? undefined : chatPanel.agentName;
    return name === 'Agent' ? undefined : name;
  },
  notice: (text) => {
    showNotice(text);
  },
});
byId('empty-connect').addEventListener('click', () => {
  aiConnect.open();
});

// --- Floating left panel: Bodies | Chat --------------------------------------------------------
const chatTabDot = byId('chat-tab-dot');
const chatUnread = byId('chat-unread');
export const leftPanel = new LeftPanel({
  app: document.querySelector<HTMLElement>('.app') ?? document.body,
  panel: byId('left-panel'),
  view: byId('viewport'),
  load: () => loadSetting(LEFT_PANEL_STORAGE_KEY, (v): v is string => typeof v === 'string', null),
  save: (text) => {
    saveSetting(LEFT_PANEL_STORAGE_KEY, text);
  },
  onChange: () => {
    chatPanel.shownChanged();
    viewport.setLeftCover(leftPanel.cover);
  },
});
viewport.setLeftCover(leftPanel.cover);
export const chatPanel = new ChatPanel({
  root: byId('chat'),
  sendKey: isMac ? '⌘↵' : 'Ctrl+↵',
  isMac,
  isShowing: () => leftPanel.isShowing('chat') && document.visibilityState === 'visible',
  onFirstConnect: () => {
    // Chat opens first when an agent connects (a folded panel stays folded).
    if (!leftPanel.folded) leftPanel.show('chat');
  },
  onBadge: (unread, dot) => {
    chatTabDot.dataset['dot'] = dot;
    chatUnread.hidden = unread === 0;
    chatUnread.textContent = String(unread);
    byId('tab-chat').setAttribute(
      'aria-label',
      unread ? `Agent, ${String(unread)} new answer${unread === 1 ? '' : 's'}` : 'Agent',
    );
  },
  openConnect: () => {
    aiConnect.open('chat');
  },
  openFolder: () => {
    openFolderDialog();
  },
  notice: (text) => {
    showNotice(text);
  },
  openMenu: (button, entries) => {
    openDropdown(button, entries);
  },
  openComment: (ref) => {
    void openCommentRef(ref);
  },
  onStatus: (status) => {
    aiConnect.setChatStatus(status);
  },
  onState: () => {
    renderSendToAi();
  },
});
document.addEventListener('visibilitychange', () => {
  chatPanel.shownChanged();
});

/** A comment of the shown model as a chat link ("#3 first line"). */
function commentRef(commentId: string): ChatCommentRef | undefined {
  const c = comments.get(commentId);
  if (!c || !shownFile) return undefined;
  return {
    modelId: shownFile.modelId,
    file: shownFile.name,
    path: shownFile.path,
    commentId,
    n: comments.numberOf(commentId),
    title: (c.text.split('\n')[0] ?? '').trim(),
  };
}

/** The user replied under a comment: the reply goes to the chat agent with that comment's details. */
export function postThreadReply(commentId: string): void {
  const api = window.thirdWheel;
  const c = comments.get(commentId);
  const reply = c?.replies?.at(-1);
  const ref = commentRef(commentId);
  if (!api || !c || !reply || reply.author !== 'human' || !ref || !shownModel) {
    if (c) sent.forget(c); // marked sent when posted, but it can't go out
    return;
  }
  if (chatPanel.state === 'none') return; // no chat agent: it goes out with Send review
  const notSent = (): void => {
    sent.forget(c);
    renderSendToAi();
    showNotice(
      `Your reply under #${String(ref.n)} couldn’t go to the agent; it goes out with Send review.`,
    );
  };
  let payload: ReviewPayload;
  try {
    payload = commentPayload(shownReview(shownModel, ['open', 'resolved', 'wontfix']), commentId);
  } catch {
    notSent();
    return;
  }
  api
    .chatPost({
      kind: 'thread',
      text: reply.text,
      ref,
      about: {
        kind: 'thread',
        modelId: ref.modelId,
        file: ref.file,
        commentId,
        n: ref.n,
        payload,
      },
    })
    .then((entry) => {
      if (!entry) {
        notSent();
        return;
      }
      chatPanel.added(entry);
      renderSendToAi();
    }, notSent);
}

/** The agent replied under a comment: a "Replied under #n" line in the chat + a dot on the card. */
export function noteAgentReply(commentId: string, text: string): void {
  const ref = commentRef(commentId);
  if (!ref) return;
  commentsPanel.markUnread(commentId);
  void window.thirdWheel?.chatPost({ kind: 'replied', text, ref }).catch(() => undefined);
}

/**
 * A chat link to a comment was clicked: highlight it. Another model is opened first; that cancels
 * an open AI review request unless the model belongs to it, so ask first then.
 */
async function openCommentRef(ref: ChatCommentRef): Promise<void> {
  // A link from a saved chat names the part: any of its versions shows the comment (comments
  // belong to the part); another part opens at its newest version.
  if (ref.modelId === '') {
    const key = shownFile ? `${shownFile.path}\n${shownFile.contentHash}` : undefined;
    const here =
      ref.partId !== undefined && shownPart?.key === key && shownPart?.partId === ref.partId;
    if (!here) {
      if (!ref.path) {
        showNotice(`The model of comment #${String(ref.n)} isn't in this project any more.`);
        return;
      }
      if (!(await confirmLeavingReview(ref.file, undefined, ref.path))) return;
      await reopenModel(ref.path);
      if (shownFile?.path !== ref.path) return;
    }
    if (!commentsPanel.reveal(ref.commentId))
      showNotice(`Comment #${String(ref.n)} isn't in ${ref.file}'s comments any more.`);
    return;
  }
  if (shownFile?.modelId !== ref.modelId) {
    if (!(await confirmLeavingReview(ref.file, ref.modelId))) return;
    await reopenModel(ref.path);
    if (shownFile?.modelId !== ref.modelId) {
      if (shownFile?.path === ref.path)
        showNotice(`${ref.file} has changed since; showing its comments.`);
      else return;
    }
  }
  if (!commentsPanel.reveal(ref.commentId))
    showNotice(`Comment #${String(ref.n)} isn't on ${ref.file} any more.`);
}

/**
 * Opening `file` cancels an open AI review request unless the model belongs to it (`modelId`, or
 * for a saved link that names no live model, its `path`): ask first then. True = go ahead.
 */
async function confirmLeavingReview(
  file: string,
  modelId: string | undefined,
  path?: string,
): Promise<boolean> {
  const request = reviews.open();
  const inRequest = request?.models.some(
    (m) =>
      (modelId !== undefined && m.modelId === modelId) || (path !== undefined && m.path === path),
  );
  if (!request || inRequest) return true;
  const answer = await askChoice(
    `Open ${file}?`,
    `The agent is waiting for your review of ${request.models.map((m) => m.name).join(', ')}. Opening ${file} cancels that request.`,
    'Stay here',
    `Open ${file}`,
  );
  return answer === 'second';
}
void chatPanel.start();
