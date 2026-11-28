/**
 * One `<dialog>` that asks one question at a time; the answer is its `returnValue` when it closes.
 *
 * The browser fires a dialog's "close" event in a later task than the close itself. A new question
 * opened right after an answer (a key press, a quick IPC round trip) can therefore receive the
 * earlier question's "close" event — and, read naively, take its empty `returnValue` as "closed
 * without an answer", so the user's click on the new question is lost. Here a "close" event that
 * arrives while the dialog is open again is skipped, and an earlier question still waiting for its
 * event gets its answer when the next one opens.
 */

/** The parts of `HTMLDialogElement` used here (a fake in tests). */
export interface QuestionDialog {
  readonly open: boolean;
  returnValue: string;
  showModal(): void;
  close(returnValue?: string): void;
  addEventListener(type: 'close', listener: () => void): void;
}

export class DialogQuestion {
  private pending: ((value: string) => void) | undefined;

  constructor(private readonly dialog: QuestionDialog) {
    dialog.addEventListener('close', () => {
      if (dialog.open) return; // an earlier question's close, reached after a new one opened
      this.settle();
    });
  }

  /**
   * Ask: an open question is closed without an answer, `fill` puts in the new words, then the
   * dialog opens. Resolves with the button's value ('' = closed without one, e.g. Esc).
   */
  ask(fill: () => void): Promise<string> {
    if (this.dialog.open) this.dialog.close('');
    this.settle(); // its close event may not have come yet: it gets its own answer now
    fill();
    this.dialog.returnValue = '';
    this.dialog.showModal();
    return new Promise((done) => {
      this.pending = done;
    });
  }

  private settle(): void {
    const done = this.pending;
    this.pending = undefined;
    done?.(this.dialog.returnValue);
  }
}
