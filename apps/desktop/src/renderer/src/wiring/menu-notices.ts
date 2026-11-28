/**
 * App menu items the window carries out, the notice bar over the view and the pop-ups when notes
 * are at risk.
 */
import { DialogQuestion } from '../dialog-question.js';
import { isPrimaryShortcut } from '../../../shared/shortcuts.js';
import {
  addModel,
  aiConnect,
  feedback,
  autosave,
  byId,
  count,
  ipcErrorText,
  isMac,
  isTextField,
  lastSave,
  newProjectFolder,
  openButton,
  projectCommand,
  reloadFromDisk,
  renderSaveStatus,
  setHelpOpen,
  setLastSave,
  shortcutOnce,
  undoRedo,
} from '../main.js';

// --- App menu items the window carries out -------------------------------------------
// Same code as the buttons and keys. Undo / Redo: the app's history, or typing in a text field.
window.thirdWheel?.onMenuCommand((command) => {
  const now = performance.now();
  // Behind an open pop-up the keys don't reach the app either (dialogs stop them).
  const modalOpen = document.querySelector('dialog[open]') !== null;
  if (modalOpen && command !== 'shortcuts' && command !== 'connect' && command !== 'feedback') {
    if ((command === 'undo' || command === 'redo') && isTextField(document.activeElement)) {
      window.thirdWheel?.textUndoRedo(command);
    }
    return;
  }
  switch (command) {
    case 'undo':
    case 'redo':
      if (isTextField(document.activeElement)) {
        window.thirdWheel?.textUndoRedo(command);
      } else if (shortcutOnce.take(command, 'menu', now)) {
        undoRedo(command);
      }
      return;
    case 'openFolder':
      if (shortcutOnce.take(command, 'menu', now)) openFolderDialog();
      return;
    case 'addModel':
      if (shortcutOnce.take(command, 'menu', now)) void addModel();
      return;
    case 'newProjectFolder':
      void newProjectFolder();
      return;
    case 'makeOwnProject':
      void projectCommand('new');
      return;
    case 'saveProjectAs':
      void projectCommand('save-as');
      return;
    case 'reloadFromDisk':
      void reloadFromDisk();
      return;
    case 'shortcuts':
      setHelpOpen(true);
      return;
    case 'connect':
      aiConnect.open();
      return;
    case 'feedback':
      feedback.open();
      return;
  }
});
// onSaved runs before onState: it keeps the error message the indicator's tooltip shows.
autosave.onSaved = (error) => {
  if (error) {
    setLastSave({ at: new Date(), error });
    showNotice(`Could not save the annotations: ${error}. Trying again with the next change.`);
  }
};
autosave.onState = (state) => {
  if (state === 'saved') setLastSave({ at: new Date(), error: undefined });
  renderSaveStatus(state);
};
// Cmd/Ctrl+S saves now (habit from CAD tools; auto-save does it anyway).
window.addEventListener('keydown', (e) => {
  if (!isPrimaryShortcut(e, 's', isMac)) return;
  e.preventDefault();
  if (autosave.pending) void autosave.flush();
  else if (lastSave) renderSaveStatus(lastSave.error === undefined ? 'saved' : 'error');
});
// Last changes when the window closes (blocking: the page is going away).
window.addEventListener('beforeunload', () => {
  autosave.flushSync();
});

// --- Notice bar over the view: sidecar problems ----------------------------
export const notice = byId('notice');
export const noticeText = byId('notice-text');
let noticesShown = 0;
export function showNotice(text: string): void {
  noticeText.textContent = text;
  notice.hidden = false;
  noticesShown++;
}
/** Marks "now": {@link addNotice} adds to a notice shown after it. */
export function noticeMark(): number {
  return noticesShown;
}
/** `text` after the notice shown since `mark` when it is still open, else on its own. */
export function addNotice(text: string, mark: number): void {
  const before = !notice.hidden && noticesShown !== mark ? noticeText.textContent : '';
  showNotice(before ? `${before} ${text}` : text);
}
export function hideNotice(): void {
  notice.hidden = true;
}
byId('notice-close').addEventListener('click', hideNotice);

// --- Pop-up when annotation data is at risk -----------------------
// Like the slicers' "newer project file" dialog: a backup was made or fields will be dropped.
// Minor things (items that didn't fit) stay in the notice bar.
export const alertDialog = byId('alert-dialog') as HTMLDialogElement;
export const alertTitle = byId('alert-title');
export const alertBody = byId('alert-body');
// Keys stay in the pop-up (tool shortcuts must not fire behind it); Esc / Enter still close it.
alertDialog.addEventListener('keydown', (e) => {
  if (alertDialog.open) e.stopPropagation(); // closed: its button may still hold focus
});
/** A second message while one is open is added below it (the first title stays). */
export function showAlert(title: string, text: string): void {
  if (!alertDialog.open) {
    alertTitle.textContent = title;
    alertBody.replaceChildren();
  }
  const p = document.createElement('p');
  p.textContent = text;
  alertBody.append(p);
  if (!alertDialog.open) alertDialog.showModal();
}

// A question with two answers: `first` is the default button, Esc = neither.
const choiceDialog = byId('choice-dialog') as HTMLDialogElement;
choiceDialog.addEventListener('keydown', (e) => {
  // Tool shortcuts must not fire behind it. Once closed, its button can keep focus until the
  // next frame: keys pressed then (Cmd+I right after an answer) must not be lost.
  if (choiceDialog.open) e.stopPropagation();
});
const choiceQuestion = new DialogQuestion(choiceDialog);
export function askChoice(
  title: string,
  text: string,
  first: string,
  second: string,
  third?: string,
  /** Hover text per button (details that would make the text too long). */
  tips?: { readonly first?: string; readonly second?: string; readonly third?: string },
): Promise<'first' | 'second' | 'third' | 'none'> {
  const button = (id: string, label: string, tip: string | undefined): HTMLElement => {
    const b = byId(id);
    b.textContent = label;
    if (tip) b.title = tip;
    else b.removeAttribute('title');
    return b;
  };
  return choiceQuestion
    .ask(() => {
      byId('choice-title').textContent = title;
      byId('choice-text').textContent = text;
      button('choice-first', first, tips?.first);
      button('choice-second', second, tips?.second);
      const thirdButton = button('choice-third', third ?? '', tips?.third);
      thirdButton.hidden = third === undefined;
    })
    .then((v) => (v === 'first' || v === 'second' || v === 'third' ? v : 'none'));
}

/** Close the open two-answer question without an answer (as Esc). */
export function closeChoice(): void {
  if (choiceDialog.open) choiceDialog.close('');
}

/** Text for fields this version doesn't know, e.g. from a newer Third Wheel. */
export function droppedFieldsText(name: string, paths: readonly string[]): string {
  // `markers.0.tag`, `markers.1.tag` → one entry `markers[].tag`.
  const fields = [...new Set(paths.map((p) => p.replace(/\.\d+(?=\.|$)/g, '[]')))];
  const shown = fields.slice(0, 3).join(', ');
  const more = fields.length > 3 ? ` and ${count.format(fields.length - 3)} more` : '';
  const n = fields.length === 1 ? 'a field' : `${count.format(fields.length)} fields`;
  return `${name} has ${n} this version of Third Wheel doesn't know (${shown}${more}). The file stays as it is until your next change; that save removes them but first keeps a backup copy of the file (….bak.json). If it was saved by a newer Third Wheel, update the app to keep using them.`;
}

/** File ▸ Open folder… (⌘O, toolbar): main asks for the folder and shows its project. */
export function openFolderDialog(): void {
  void window.thirdWheel?.openFolderDialog().catch((err: unknown) => {
    showAlert('Open folder', ipcErrorText(err));
  });
}

openButton.addEventListener('click', openFolderDialog);
