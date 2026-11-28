/**
 * Save indicator in the status bar and the project of the shown model (window title, read-only,
 * start page).
 */
import type { SaveState } from '../autosave.js';
import { saveStatusView } from '../../../shared/ai-status.js';
import type { ProjectState, StartState } from '../../../shared/ipc.js';
import { APP_DISPLAY_NAME } from '../../../shared/app-name.js';
import { type StartPageElements, renderStartPage } from '../start-page.js';
import {
  addModel,
  autosave,
  byId,
  emptyView,
  ipcErrorText,
  notice,
  noticeText,
  showAlert,
  shownFile,
  shownModel,
  showNotice,
} from '../main.js';

// --- Save indicator in the status bar ---------------------------
// Like Google Docs / Figma: "Saving…" → "Saved"; hidden until the first change of a model
// (a read-only project shows "Read-only — not saved" at once).
const saveStatus = byId('save-status');
export let lastSave: { at: Date; error: string | undefined } | undefined;
/** Sets `lastSave` from another module (an import can't be assigned). */
export function setLastSave(value: typeof lastSave): void {
  lastSave = value;
}
const saveStatusLabel = byId('save-status-label');
/** Where notes are saved, for the indicator's tooltip. */
function saveWhere(): string {
  return shownProject
    ? `the project "${shownProject.name}" (.thirdwheel folder in ${shownProject.folder})`
    : `the .thirdwheel folder next to ${shownFile?.name ?? 'the model'}`;
}
export function renderSaveStatus(state: SaveState | 'hidden'): void {
  // Read-only project: shown from the moment it opens, not only after the first change; red dot
  // (nothing is saved), calm text (it was chosen, not a failure); the tooltip says why.
  if (shownProject?.readOnly !== undefined && state !== 'error') {
    saveStatus.hidden = false;
    saveStatus.dataset['dot'] = 'readonly';
    saveStatusLabel.textContent = 'Read-only — not saved';
    saveStatus.title = shownProject.readOnly;
    return;
  }
  saveStatus.hidden = state === 'hidden';
  if (state === 'hidden') return;
  // Same dot + label look as the AI status: grey Saved, amber Saving…, red Not saved.
  const view = saveStatusView(state);
  saveStatus.dataset['dot'] = view.dot;
  saveStatusLabel.textContent = view.label;
  if (state === 'pending' || state === 'saving')
    saveStatus.title = `Annotations are saved to ${saveWhere()}`;
  else if (state === 'saved')
    saveStatus.title = `Annotations saved to ${saveWhere()} at ${lastSave?.at.toLocaleTimeString() ?? ''}`;
  else
    saveStatus.title = `Could not save to ${saveWhere()}: ${lastSave?.error ?? ''}. Trying again with the next change.`;
}

// --- Project of the shown model (window title, read-only, notices) ---------------------
/** The shown model's project (title `project — model`); undefined before the first model. */
export let shownProject: ProjectState | undefined;
export function renderTitle(): void {
  const file = shownFile?.name;
  const title = file
    ? shownProject
      ? `${shownProject.name} — ${file}`
      : file
    : (shownProject?.name ?? APP_DISPLAY_NAME);
  // Like SolidWorks / Word: the title says read-only too, also when the status bar is out of sight.
  document.title = shownProject?.readOnly !== undefined ? `${title} (read-only)` : title;
}
export function setProject(state: ProjectState | undefined): void {
  const wasReadOnly = shownProject?.readOnly;
  shownProject = state;
  renderTitle();
  if (state?.readOnly === wasReadOnly) return;
  // Read-only shows at once; leaving it goes back to what the last save said (hidden before any).
  if (lastSave) renderSaveStatus(lastSave.error === undefined ? 'saved' : 'error');
  else renderSaveStatus('hidden');
}
window.thirdWheel?.onProjectState(setProject);
/** File ▸ Make this folder its own project… / Save project as…: the last changes are saved first. */
export async function projectCommand(which: 'new' | 'save-as'): Promise<void> {
  const api = window.thirdWheel;
  const path = shownFile?.path;
  if (!api || !path) {
    showNotice('Open a model first.');
    return;
  }
  await autosave.flush();
  try {
    const state = which === 'new' ? await api.newProjectHere(path) : await api.saveProjectAs(path);
    if (!state) return;
    setProject(state);
    showNotice(
      which === 'new'
        ? `${state.name} is now its own project (.thirdwheel folder in ${state.folder}).`
        : `Project saved to ${state.folder}. Changes are saved there from now on; the model files stay where they are.`,
    );
  } catch (err) {
    showAlert(which === 'new' ? 'New project' : 'Save project as', ipcErrorText(err));
  }
}
/**
 * File ▸ New project folder…: main asks for the folder and makes its project; the window then
 * shows it empty (start page with Add file…). A shown model is saved first; the page reloads so
 * nothing of the old project stays.
 */
export async function newProjectFolder(): Promise<void> {
  const api = window.thirdWheel;
  if (!api) return;
  await autosave.flush();
  try {
    const r = await api.newProjectFolder();
    if (!r) return;
    if ('alreadyOpen' in r) {
      showNotice(`${r.alreadyOpen} is already open.`);
      return;
    }
    showEmptyProject(r.state);
  } catch (err) {
    showAlert('New project folder', ipcErrorText(err));
  }
}
/** Show a project with no model (start page). A shown model goes: the page starts again. */
function showEmptyProject(state: ProjectState): void {
  if (shownModel) {
    autosave.flushSync();
    window.location.reload(); // main hands the project back (`startState`)
    return;
  }
  setProject(state);
  void refreshStartPage();
}
// Open folder… found nothing to show in a folder: its project, empty.
window.thirdWheel?.onEmptyProject((folder) => {
  void (async () => {
    const api = window.thirdWheel;
    if (!api) return;
    await autosave.flush();
    try {
      showEmptyProject(await api.openEmptyProject(folder));
    } catch (err) {
      showAlert('Open folder', ipcErrorText(err));
    }
  })();
});
const startPage: StartPageElements = {
  logo: byId('empty-logo'),
  title: byId('empty-title'),
  text: byId('empty-text'),
  folder: byId('empty-folder'),
  addModel: byId('empty-add-model'),
  newProject: byId('empty-new-project'),
  open: byId('empty-open'),
  recent: byId('empty-recent'),
  recentList: byId('empty-recent-list'),
};
/** Fill the start page (recent projects, an empty project) while no model is shown. */
export async function refreshStartPage(): Promise<void> {
  const api = window.thirdWheel;
  if (!api || shownModel) return;
  let state: StartState;
  try {
    state = await api.startState();
  } catch {
    return;
  }
  if (emptyView.hidden) return; // a model is loading or shown meanwhile
  if (state.project && !shownProject) setProject(state.project);
  renderStartPage(startPage, state, (row) => {
    void api.openRecentProject(row.folder).catch((err: unknown) => {
      showAlert('Open recent project', ipcErrorText(err));
    });
  });
}
startPage.addModel.addEventListener('click', () => {
  void addModel();
});
startPage.newProject.addEventListener('click', () => {
  void newProjectFolder();
});
void refreshStartPage();
// Several project messages in one load stack in the notice bar.
window.thirdWheel?.onProjectNotice((text) => {
  if (!notice.hidden && noticeText.textContent && !noticeText.textContent.includes(text))
    showNotice(`${noticeText.textContent}\n${text}`);
  else showNotice(text);
});
