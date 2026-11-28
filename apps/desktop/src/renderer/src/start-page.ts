/**
 * The start page (no project open): app icon, New project folder / Open folder, Recent projects
 * (name, folder, last opened; a click reopens the model seen there last), the agent hint.
 * A project open with no model shown (New project folder…, an empty folder) gets its own page:
 * no icon, the project name as the title with its folder under it, Add file… and
 * Open another folder…, no Recent projects (File ▸ Open Recent has them).
 */
import type { ProjectState, RecentProjectRow, StartState } from '../../shared/ipc.js';

/** Most rows on the start page (Open Recent in the File menu lists them all). */
export const START_RECENT_ROWS = 6;

/** "Today", "Yesterday", else a short date ("12 Nov", with the year when not this year). */
export function openedLabel(iso: string | undefined, now: Date, locale?: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Characters of a Recent projects folder line before its middle is cut (440 px at 12 px). */
export const FOLDER_LINE_CHARS = 56;

/**
 * A long folder keeps its start (`~`, `C:`) and its last folders — the part that tells projects
 * apart: `~/…/clients/acme/bracket`. Narrower than that, the line's end is cut by CSS as before.
 */
export function shortFolder(label: string, max = FOLDER_LINE_CHARS): string {
  if (label.length <= max) return label;
  const sep = label.includes('\\') && !label.includes('/') ? '\\' : '/';
  const parts = label.split(sep);
  const head = parts[0] ?? '';
  let tail = parts[parts.length - 1] ?? '';
  for (let i = parts.length - 2; i >= 1; i--) {
    const longer = `${parts[i] ?? ''}${sep}${tail}`;
    if (`${head}${sep}…${sep}${longer}`.length > max) break;
    tail = longer;
  }
  return parts.length > 2 ? `${head}${sep}…${sep}${tail}` : label;
}

export interface StartPageElements {
  readonly logo: Element;
  readonly title: HTMLElement;
  readonly text: HTMLElement;
  readonly folder: HTMLElement;
  readonly addModel: HTMLElement;
  readonly newProject: HTMLElement;
  readonly open: HTMLElement;
  readonly recent: HTMLElement;
  readonly recentList: HTMLElement;
}

const WELCOME =
  'A project is a folder with your STEP files (or STL / 3MF meshes). Mark them up and talk them through with your AI.';

/** What the start page shows for `state`: the start page, or an open project with no model. */
export interface StartPageView {
  readonly logo: boolean;
  readonly title: string;
  readonly text: string;
  /** The project's folder under the title; `undefined` = hidden. */
  readonly folder: string | undefined;
  readonly addModel: boolean;
  readonly newProject: boolean;
  readonly openLabel: string;
  readonly recent: readonly RecentProjectRow[];
}

export function startPageView(state: StartState): StartPageView {
  const project: ProjectState | undefined = state.project;
  if (project) {
    return {
      logo: false,
      title: project.name,
      text: 'This project has no models yet. Add a STEP file (or an STL / 3MF mesh) from its folder.',
      folder: project.folder,
      addModel: true,
      newProject: false,
      // "another": it leaves this project (same action as File ▸ Open folder…).
      openLabel: 'Open another folder…',
      recent: [],
    };
  }
  return {
    logo: true,
    title: 'Third Wheel',
    text: WELCOME,
    folder: undefined,
    addModel: false,
    newProject: true,
    openLabel: 'Open folder…',
    recent: state.recent.slice(0, START_RECENT_ROWS),
  };
}

/** Fill the start page for `state` (`project`: shown with no model). */
export function renderStartPage(
  el: StartPageElements,
  state: StartState,
  onRecent: (row: RecentProjectRow) => void,
  now = new Date(),
): void {
  const view = startPageView(state);
  el.logo.toggleAttribute('hidden', !view.logo);
  el.title.textContent = view.title;
  el.text.textContent = view.text;
  el.folder.hidden = view.folder === undefined;
  el.folder.textContent = view.folder ?? '';
  el.addModel.hidden = !view.addModel;
  el.newProject.hidden = !view.newProject;
  el.open.textContent = view.openLabel;
  const rows = view.recent;
  el.recent.hidden = rows.length === 0;
  el.recentList.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'empty-recent-row';
      b.title = `Open ${r.name} (${r.folder})`;
      const name = document.createElement('span');
      name.className = 'empty-recent-name';
      name.textContent = r.name;
      const when = document.createElement('span');
      when.className = 'empty-recent-when';
      when.textContent = openedLabel(r.opened, now);
      const folder = document.createElement('span');
      folder.className = 'empty-recent-folder';
      folder.textContent = shortFolder(r.folderLabel);
      b.append(name, when, folder);
      b.addEventListener('click', () => {
        onRecent(r);
      });
      li.append(b);
      return li;
    }),
  );
}
