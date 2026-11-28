/**
 * Auto-save of the annotation sidecar: a change marks the model dirty and a write follows
 * `delayMs` after the last change; `flushSync` writes at once (opening another model, closing the
 * window). Nothing is written until something changed, so viewing a model leaves no file.
 */
import type { SaveResult } from '../../shared/ipc.js';

export interface SaveTarget {
  /** Model file path (main writes the sidecar next to it). */
  readonly modelPath: string;
  /** The sidecar text as of now. */
  build(): string;
}

export interface SaveIo {
  write(modelPath: string, text: string): Promise<SaveResult>;
  writeSync(modelPath: string, text: string): SaveResult;
}

export const AUTOSAVE_DELAY_MS = 1000;

/** For the save indicator: `pending` = changed, write not started; `saving` = write in flight. */
export type SaveState = 'pending' | 'saving' | 'saved' | 'error';

export class Autosave {
  private target: SaveTarget | undefined;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The write in flight (writes never overlap). */
  private writing: Promise<void> = Promise.resolve();
  /** Called after each write: undefined = saved, else the error. */
  onSaved: ((error: string | undefined) => void) | undefined;
  /** Called when the save state changes (indicator). Not called by `setTarget`. */
  onState: ((state: SaveState) => void) | undefined;

  constructor(
    private readonly io: SaveIo,
    private readonly delayMs = AUTOSAVE_DELAY_MS,
  ) {}

  /** The model whose annotations are saved from now on (undefined: none, changes are ignored). */
  setTarget(target: SaveTarget | undefined): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.target = target;
    this.dirty = false;
  }

  get pending(): boolean {
    return this.dirty;
  }

  changed(): void {
    if (!this.target) return;
    this.dirty = true;
    this.onState?.('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  /** Write now if anything changed (after a write already in flight). */
  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const target = this.take();
      if (!target) return;
      this.onState?.('saving');
      let result: SaveResult;
      try {
        const text = target.build();
        result = await this.io.write(target.modelPath, text);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      this.done(target, result);
    });
    return this.writing;
  }

  /** Write now, blocking (the window is closing / another model replaces this one). */
  flushSync(): void {
    const target = this.take();
    if (!target) return;
    this.onState?.('saving');
    let result: SaveResult;
    try {
      result = this.io.writeSync(target.modelPath, target.build());
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.done(target, result);
  }

  private take(): SaveTarget | undefined {
    if (!this.dirty || !this.target) return undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    return this.target;
  }

  private done(target: SaveTarget, result: SaveResult): void {
    // A failed write stays dirty, so the next change (or close) tries again.
    if (!result.ok && this.target === target) this.dirty = true;
    this.onSaved?.(result.ok ? undefined : result.error);
    // After onSaved (it may keep the error message). A change during the write stays "pending".
    if (this.target === target) {
      this.onState?.(!result.ok ? 'error' : this.dirty ? 'pending' : 'saved');
    }
  }
}
