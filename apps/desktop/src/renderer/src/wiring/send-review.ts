/**
 * The Send review button, the AI request banner and the part shown for a review.
 */
import { ReviewRequests } from '../review-request.js';
import { ReviewedFiles, SentComments, sendToAiMessage, reviewSentText } from '../send-to-ai.js';
import {
  autosave,
  byId,
  chatPanel,
  comments,
  commentsPanel,
  leftPanel,
  reopenModel,
  requestCounts,
  shownFile,
  showNotice,
  shownProject,
} from '../main.js';

// --- "Send review" button + AI message banner --------------------------------------
// The AI asks with `request_review` → banner + rainbow button; Send answers its `wait_for_review`.
// A chat agent connected → Send review sends the open comments it hasn't had to the chat.
// Neither → "Copy review" copies a message to paste into the AI chat (all reviewed models).
export const reviews = new ReviewRequests();
const reviewedFiles = new ReviewedFiles();
export const sent = new SentComments();
const aiBanner = byId('ai-banner');
const aiBannerText = byId('ai-banner-text');
const sendAiButton = byId('send-ai') as HTMLButtonElement;
const sendAiCount = byId('send-ai-count');
const sendAiLabel = byId('send-ai-label');
export const openCommentCount = (): number =>
  comments.list().filter((c) => c.status === 'open').length;
/** The shown file's part in its project (Send review counts per part), once the project lists it. */
export let shownPart: { readonly key: string; readonly partId: string } | undefined;
/** The shown file's next save may move it to another part (a load that linked it). */
export let partMayChange = false;
/** Sets `partMayChange` from another module (an import can't be assigned). */
export function setPartMayChange(value: typeof partMayChange): void {
  partMayChange = value;
}
/** The lookup in flight (file + contents). */
let partLookup: string | undefined;
/** Bumped when the part may have changed: an answer from an older lookup is dropped. */
let partLookupRound = 0;
/** The shown file's part is looked up again (a link joined parts): drops a lookup in flight too. */
export function forgetShownPart(): void {
  shownPart = undefined;
  partLookup = undefined;
  partLookupRound++;
}
export function lookUpShownPart(): void {
  const file = shownFile;
  const api = window.thirdWheel;
  if (!file || !api) return;
  const key = `${file.path}\n${file.contentHash}`;
  if (shownPart?.key === key || partLookup === key) return;
  partLookup = key;
  const round = partLookupRound;
  api
    .projectPartOf(file.path, file.contentHash)
    .then((r) => {
      if (!r || shownFile !== file || round !== partLookupRound) return;
      shownPart = { key, partId: r.partId };
      renderSendToAi();
    })
    .catch(() => undefined)
    .finally(() => {
      if (partLookup === key) partLookup = undefined;
    });
}
/** An agent listens to the chat (or did this session: messages wait for it). */
export const chatAgent = (): boolean => chatPanel.state !== 'none';
export function renderSendToAi(): void {
  const open = openCommentCount();
  if (shownFile) {
    lookUpShownPart();
    const key = `${shownFile.path}\n${shownFile.contentHash}`;
    reviewedFiles.update({
      path: shownFile.path,
      name: shownFile.name,
      modelId: shownFile.modelId,
      openComments: open,
      unsent: sent.unsent(comments.list()),
      ...(shownProject ? { project: shownProject.folder } : {}),
      ...(shownPart?.key === key ? { partId: shownPart.partId } : {}),
    });
  }
  const asking = reviews.open() !== undefined;
  const copying = !asking && !chatAgent();
  // A multi-model request sends the open comments of all its models; otherwise the count
  // is what the agent hasn't had yet.
  const sending = asking
    ? requestCounts().reduce((n, c) => n + c.openComments, 0)
    : reviewedFiles.unsentCount();
  sendAiButton.disabled = !shownFile;
  sendAiButton.classList.toggle('asking', asking);
  sendAiLabel.textContent = copying ? 'Copy review' : 'Send review';
  sendAiCount.hidden = !shownFile || sending === 0; // no "0" badge
  sendAiCount.textContent = String(sending);
  sendAiButton.setAttribute(
    'aria-label',
    asking
      ? `Send review, ${String(sending)} open comments`
      : `${copying ? 'Copy review' : 'Send review'}, ${String(sending)} new comments`,
  );
  if (asking) renderBannerModels();
  sendAiButton.title = !shownFile
    ? 'Open a model first'
    : asking
      ? 'The AI is waiting for your review: send your open comments'
      : nothingToSend()
        ? 'Nothing to send yet: add a comment first'
        : copying
          ? 'No agent listens in the Agent tab: copy a message for your AI chat that asks it to read your comments'
          : `Send the comments ${agentName()} hasn't had yet; it answers under each comment`;
}
/** The chat agent's name for notices ("Claude Code"). */
const agentName = (): string => chatPanel.agentName;
/** No AI request and no open comments on any model of this session: nothing to copy. */
function nothingToSend(): boolean {
  if (!shownFile) return true;
  return reviewedFiles.forMessage(shownFile.path).every((f) => f.openComments === 0);
}
const aiBannerModels = byId('ai-banner-models');
reviews.onChange = (open) => {
  aiBanner.hidden = !open;
  const several = (open?.models.length ?? 0) > 1;
  aiBannerText.textContent =
    open?.message ??
    (several
      ? 'Please review these models together and add comments.'
      : 'Please review this model and add comments.');
  renderBannerModels();
  renderSendToAi();
};
/**
 * A request for several models: one button per model with its open comments; the shown one
 * is marked, a click on another opens it (the request stays open). Send answers for all of them.
 */
function renderBannerModels(): void {
  const open = reviews.open();
  if (!open || open.models.length < 2) {
    aiBannerModels.hidden = true;
    aiBannerModels.replaceChildren();
    return;
  }
  const counts = new Map(requestCounts().map((c) => [c.modelId, c.openComments]));
  const label = document.createElement('span');
  label.textContent = 'Models:';
  const buttons = open.models.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-banner-model';
    const shown = m.modelId === shownFile?.modelId;
    const n = counts.get(m.modelId) ?? 0;
    b.textContent = `${m.name} · ${String(n)}`;
    b.setAttribute('aria-current', String(shown));
    b.title = shown
      ? `${m.path}\nShown now · ${String(n)} open comments`
      : `${m.path}\nOpen it to mark and comment (${String(n)} open comments)`;
    if (!shown)
      b.addEventListener('click', () => {
        void reopenModel(m.path);
      });
    return b;
  });
  aiBannerModels.replaceChildren(label, ...buttons);
  aiBannerModels.hidden = false;
}
function sendToAi(): void {
  if (!shownFile) return;
  const draft = commentsPanel.postDraft(); // typed but not posted: it goes out too
  const sentNote =
    draft === 'posted'
      ? 'Posted your comment and sent.'
      : draft === 'saved'
        ? 'Saved your edit and sent.'
        : 'Sent: the AI is reading your comments.';
  void autosave.flush(); // the AI reads the app; this also keeps the sidecar up to date
  renderSendToAi(); // counts include a comment / reply just posted from the box
  if (reviews.open()) {
    // The AI asked: 0 comments is an answer too ("looks fine"), so it is sent.
    const counts = requestCounts();
    const none = counts.every((c) => c.openComments === 0);
    reviews.send(counts);
    reviewedFiles.markAllSent(sent);
    renderSendToAi();
    showNotice(none && !draft ? 'Sent: no open comments.' : sentNote);
    return;
  }
  if (nothingToSend()) {
    showNotice(
      `${draft === 'saved' ? 'Saved your edit. ' : ''}Nothing to send yet: add a comment first.`,
    );
    return;
  }
  if (chatAgent()) {
    sendReviewToChat(draft);
    return;
  }
  const text = sendToAiMessage(reviewedFiles.forMessage(shownFile.path));
  navigator.clipboard.writeText(text).then(
    () => {
      reviewedFiles.markAllSent(sent);
      renderSendToAi();
      showNotice(
        `${draft ? 'Comment posted. ' : ''}The AI has not asked for a review, so a message was copied. Paste it into your AI chat.`,
      );
    },
    () => {
      showNotice(`Couldn't copy. Paste this into your AI chat:\n${text}`);
    },
  );
}
/** Send review with a chat agent: the comments it hasn't had go to the chat. */
function sendReviewToChat(draft: 'posted' | 'saved' | undefined): void {
  const files = reviewedFiles.withUnsent();
  if (files.length === 0) {
    showNotice(
      `${draft === 'saved' ? 'Saved your edit. ' : ''}Nothing new to send: ${agentName()} has every open comment already.`,
    );
    return;
  }
  const text = reviewSentText(files);
  const models = files.map((f) => ({
    modelId: f.modelId ?? '',
    file: f.name,
    path: f.path,
    openComments: f.openComments,
    newComments: (f.unsent ?? []).map((u) => ({ id: u.id, n: u.n })),
  }));
  const api = window.thirdWheel;
  if (!api || models.some((m) => m.modelId === '')) return;
  api.chatPost({ kind: 'review', text, about: { kind: 'review', models } }).then(
    (entry) => {
      if (!entry) {
        showNotice('Couldn’t send the review to the agent.');
        return;
      }
      reviewedFiles.markAllSent(sent);
      chatPanel.added(entry);
      if (!leftPanel.folded) leftPanel.show('chat');
      renderSendToAi();
      showNotice(
        `${draft === 'posted' ? 'Posted your comment. ' : ''}${text}. ${agentName()} answers under each comment.`,
      );
    },
    () => {
      showNotice('Couldn’t send the review to the agent.');
    },
  );
}
sendAiButton.addEventListener('click', sendToAi);
byId('ai-banner-send').addEventListener('click', sendToAi);
byId('ai-banner-dismiss').addEventListener('click', () => {
  reviews.cancel('The user dismissed the review request');
});
renderSendToAi();
