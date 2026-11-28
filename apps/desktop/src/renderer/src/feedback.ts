/**
 * Help ▸ Send feedback… pop-up (also the start page's "Send feedback" link): two places to write the
 * feedback — the private feedback form or a new public GitHub issue, opened in the browser with the
 * setup line (version, OS, agent: shown, can be left out) filled in. The model, notes and chats are
 * never part of it. Texts and links: `shared/feedback.ts`.
 */
import { type FeedbackPlace, setupLine } from '../../shared/feedback.js';

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from index.html`);
  return found;
}

export interface FeedbackOptions {
  /** The connected agent's name ("Claude Code"), when one connected this session. */
  readonly agent: () => string | undefined;
  /** A notice in the window (after the pop-up closed). */
  readonly notice: (text: string) => void;
}

export interface Feedback {
  open(): void;
}

export function setupFeedback(opts: FeedbackOptions): Feedback {
  const api = window.thirdWheel;
  const dialog = el('feedback-dialog') as HTMLDialogElement;
  const setupOn = el('feedback-setup-on') as HTMLInputElement;
  const setupText = el('feedback-setup');
  const status = el('feedback-status');

  let setup = '';
  /** The setup line being looked up: a quick click waits for it instead of going out without it. */
  let ready: Promise<void> = Promise.resolve();

  const send = async (place: FeedbackPlace): Promise<void> => {
    if (!api) return;
    await ready;
    const opened = await api.openFeedback(place, setupOn.checked && setup ? setup : undefined);
    if (!opened) {
      status.textContent = 'Couldn’t open your browser.';
      return;
    }
    dialog.close();
    const where = place === 'form' ? 'The feedback form' : 'A new GitHub issue';
    opts.notice(`${where} opened in your browser: write your feedback there and submit it.`);
  };
  el('feedback-form').addEventListener('click', () => void send('form'));
  el('feedback-github').addEventListener('click', () => void send('github'));

  const open = (): void => {
    if (dialog.open) return;
    status.textContent = '';
    setupText.textContent = '…';
    ready = Promise.all([api?.getAppVersion(), api?.getSystemInfo()])
      .then(([version, info]) => {
        if (!version || !info) return;
        setup = setupLine(version, info, opts.agent());
        setupText.textContent = setup;
      })
      .catch(() => {
        setupText.textContent = 'version and system (couldn’t be read)';
      });
    dialog.showModal();
  };
  el('empty-feedback').addEventListener('click', open);
  return { open };
}
