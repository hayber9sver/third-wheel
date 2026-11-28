/**
 * Undo/redo history. Pure — no DOM. A step knows how to undo and redo itself; the history
 * keeps them in order, drops the oldest beyond `limit`, and forgets the redo steps when a new
 * step is pushed. Opening a model clears it (ids belong to one model).
 *
 * Undoable: paint strokes (Brush / Shift-erase / Smart fill, one press = one step) and marker add /
 * delete / rename / recolour. Not undoable: selection, hiding (view state, like CAD tools).
 */

export interface UndoStep {
  /** Shown in the buttons' tooltips, e.g. "Brush stroke" → "Undo Brush stroke". */
  readonly label: string;
  undo(): void;
  redo(): void;
}

export interface PushOptions {
  /**
   * Steps with the same key pushed within `mergeMs` of each other become one (the first one's
   * undo, the last one's redo) — e.g. dragging in the system colour picker sends many changes.
   */
  readonly mergeKey?: string;
}

export const UNDO_LIMIT = 100;
export const MERGE_MS = 1000;

interface Entry {
  step: UndoStep;
  mergeKey: string | undefined;
  at: number;
}

export class UndoHistory {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  /** Called after every change of what can be undone / redone. */
  onChange: (() => void) | undefined;

  constructor(
    private readonly limit = UNDO_LIMIT,
    private readonly now: () => number = () => Date.now(),
    private readonly mergeMs = MERGE_MS,
  ) {}

  /** Steps pushed inside `group()`; undefined when no group is running. */
  private collecting: UndoStep[] | undefined;

  /**
   * Runs `fn`; every step it pushes becomes one step `label` (e.g. "Comment on selection" = new
   * marker + new comment). Nothing pushed → nothing recorded. Nested groups join the outer one.
   */
  group(label: string, fn: () => void): void {
    if (this.collecting) {
      fn();
      return;
    }
    const steps: UndoStep[] = [];
    this.collecting = steps;
    try {
      fn();
    } finally {
      this.collecting = undefined;
    }
    if (steps.length === 0) return;
    this.push({
      label,
      undo: () => {
        for (let i = steps.length - 1; i >= 0; i--) steps[i]?.undo();
      },
      redo: () => {
        for (const s of steps) s.redo();
      },
    });
  }

  /** Records a step that has already been done. */
  push(step: UndoStep, options: PushOptions = {}): void {
    if (this.collecting) {
      this.collecting.push(step);
      return;
    }
    const at = this.now();
    const last = this.done[this.done.length - 1];
    const mergeKey = options.mergeKey;
    if (
      mergeKey !== undefined &&
      last?.mergeKey === mergeKey &&
      this.undone.length === 0 &&
      at - last.at <= this.mergeMs
    ) {
      const first = last.step;
      last.step = {
        label: step.label,
        undo: () => {
          first.undo();
        },
        redo: () => {
          step.redo();
        },
      };
      last.at = at;
    } else {
      this.done.push({ step, mergeKey, at });
      if (this.done.length > this.limit) this.done.splice(0, this.done.length - this.limit);
    }
    this.undone = [];
    this.onChange?.();
  }

  canUndo(): boolean {
    return this.done.length > 0;
  }

  canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Label of the step `undo()` would undo. */
  undoLabel(): string | undefined {
    return this.done[this.done.length - 1]?.step.label;
  }

  redoLabel(): string | undefined {
    return this.undone[this.undone.length - 1]?.step.label;
  }

  /** Undoes the last step; returns its label, or undefined when there was nothing to undo. */
  undo(): string | undefined {
    const entry = this.done.pop();
    if (!entry) return undefined;
    entry.step.undo();
    entry.mergeKey = undefined; // a redone step never merges with a new one
    this.undone.push(entry);
    this.onChange?.();
    return entry.step.label;
  }

  redo(): string | undefined {
    const entry = this.undone.pop();
    if (!entry) return undefined;
    entry.step.redo();
    this.done.push(entry);
    this.onChange?.();
    return entry.step.label;
  }

  clear(): void {
    if (this.done.length === 0 && this.undone.length === 0) return;
    this.done = [];
    this.undone = [];
    this.onChange?.();
  }
}
