/** Info section of the right panel: read-only facts about the selection. */
import type { InfoBlock } from './info-format.js';

export const INFO_EMPTY_HINT =
  'Select something to see its size and position. Select two things to measure between them.';
/** A mesh file has nothing to select. */
export const INFO_MESH_HINT =
  'Mesh file: nothing to select or measure here. Open the STEP to see sizes and positions.';

/** The "Exact values" button under the blocks: shown while a value has "≈". */
export interface ExactAction {
  /** Working: the button is disabled and says so; `note` shows progress. */
  readonly busy: boolean;
  /** Small text under the button (re-read warning, progress, error). */
  readonly note?: string | undefined;
  readonly onClick: () => void;
}

export const EXACT_BUTTON_LABEL = 'Exact values';
export const EXACT_BUTTON_TITLE =
  'Ask OpenCascade for the exact values instead of the ≈ ones estimated from the mesh';

export class InfoPanel {
  private note: HTMLElement | undefined;

  constructor(private readonly body: HTMLElement) {
    this.render([]);
  }

  render(blocks: readonly InfoBlock[], exact?: ExactAction, emptyHint = INFO_EMPTY_HINT): void {
    this.note = undefined;
    if (blocks.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = emptyHint;
      this.body.replaceChildren(p);
      return;
    }
    const children: HTMLElement[] = blocks.map((block) => {
      const div = document.createElement('div');
      div.className = 'info-block';
      const h3 = document.createElement('h3');
      h3.textContent = block.title;
      const dl = document.createElement('dl');
      for (const row of block.rows) {
        const dt = document.createElement('dt');
        dt.textContent = row.label;
        const dd = document.createElement('dd');
        dd.textContent = row.value;
        dl.append(dt, dd);
      }
      div.append(h3, dl);
      if (block.note) {
        const note = document.createElement('p');
        note.className = 'info-note';
        note.textContent = block.note;
        div.append(note);
      }
      return div;
    });
    if (exact) children.push(this.exactBox(exact));
    this.body.replaceChildren(...children);
  }

  /** Update the note under the button without rebuilding the panel (progress). */
  setNote(text: string): void {
    if (!this.note) return;
    this.note.textContent = text;
    this.note.hidden = text === '';
  }

  private exactBox(exact: ExactAction): HTMLElement {
    const box = document.createElement('div');
    box.className = 'info-exact';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.id = 'info-exact';
    button.textContent = exact.busy ? 'Computing…' : EXACT_BUTTON_LABEL;
    button.title = EXACT_BUTTON_TITLE;
    button.disabled = exact.busy;
    button.addEventListener('click', exact.onClick);
    const note = document.createElement('p');
    note.className = 'info-note';
    this.note = note;
    box.append(button, note);
    this.setNote(exact.note ?? '');
    return box;
  }
}
