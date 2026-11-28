/**
 * Versions menu: add a new version, open, compare and remove versions.
 */
import { type StepModel, meshFormatOf } from '@third-wheel/geometry';
import { type VersionDiff, versionDiff } from '../version-diff.js';
import { ModelLoader } from '../model-loader.js';
import { SurfaceRaycaster } from '../brush-cursor.js';
import type { ModelFile, AddModelPick } from '../../../shared/ipc.js';
import { sameModelName } from '@third-wheel/core';
import {
  type VersionRow,
  addFileQuestion,
  versionRows,
  versionLabel,
  versionDetail,
} from '../version-list.js';
import type { MenuEntry } from '../context-menu.js';
import { differentPartQuestion } from '../revision.js';
import { isPrimaryShortcut } from '../../../shared/shortcuts.js';
import {
  askChoice,
  autosave,
  type DifferentPart,
  byId,
  closeChoice,
  contextMenu,
  count,
  ipcErrorText,
  isMac,
  loadModel,
  openDropdown,
  openFolderDialog,
  previousVersion,
  setPartMayChange,
  shortcutOnce,
  showAlert,
  shownFile,
  shownModel,
  showNotice,
  shownPath,
  viewport,
} from '../main.js';

// --- Versions menu (open or compare others) and Add file ------------------
// Compare = overlay: the other version's changed surface see-through red, the shown one's
// changed parts tinted green. The other version is the previous one still in memory, or a file
// next to the model whose name makes it a version, read just for this (no copies
// of model files, so an overwritten version can't be compared after a restart).
const versionsButton = byId('versions-menu') as HTMLButtonElement;
const compareLegend = byId('compare-legend');
/** The version compared with the shown one, and the legend's words for both colours. */
interface CompareTarget {
  readonly name: string;
  readonly model: StepModel;
  readonly oldKey: string;
  readonly newKey: string;
}
export let compareDiff: { old: StepModel; now: StepModel; diff: VersionDiff } | undefined;
/** Sets `compareDiff` from another module (an import can't be assigned). */
export function setCompareDiff(value: typeof compareDiff): void {
  compareDiff = value;
}
let comparing: CompareTarget | undefined;
/** A version read from disk only to compare (kept for comparing with it again). */
export let compareFile: { path: string; contentHash: string; model: StepModel } | undefined;
/** Sets `compareFile` from another module (an import can't be assigned). */
export function setCompareFile(value: typeof compareFile): void {
  compareFile = value;
}
/** Its own import worker: the shown model's kernel (exact values) stays untouched. */
const compareLoader = new ModelLoader();
/** Reading the other version or working out the difference (seconds on big models). */
let compareBusy = false;
/** Most version rows in the menu (a folder may hold many exports). */
const MAX_VERSION_ROWS = 30;
const VERSIONS_TITLE = 'Versions: open or compare other versions of this model';
versionsButton.title = VERSIONS_TITLE;
export function renderVersionsButton(): void {
  // A mesh has its chain; compare is between STEP files only.
  versionsButton.disabled = !shownModel || compareBusy;
  versionsButton.title = VERSIONS_TITLE;
  // Only the label: the icon and ▾ stay (the label hides when the toolbar is narrow).
  const versionsLabel = versionsButton.querySelector('.tb-label');
  if (versionsLabel) versionsLabel.textContent = compareBusy ? 'Comparing…' : 'Versions';
  versionsButton.setAttribute('aria-pressed', String(comparing !== undefined));
  compareLegend.hidden = !comparing;
  if (comparing) {
    byId('compare-legend-text').textContent = `Comparing with ${comparing.name}:`;
    byId('compare-key-old').textContent = comparing.oldKey;
    byId('compare-key-new').textContent = comparing.newKey;
  }
}
/** The previous version still in memory, when its geometry differs. */
function previousTarget(): CompareTarget | undefined {
  const prev = previousVersion;
  // No compare with a mesh (other origin, no CAD tessellation).
  if (!prev?.model || prev.carried || prev.model.meshFormat || shownModel?.meshFormat)
    return undefined;
  return {
    name: prev.path === shownPath ? `${prev.name} before reload` : prev.name,
    model: prev.model,
    oldKey: 'Previous version',
    newKey: 'New or moved',
  };
}
async function startCompare(target: CompareTarget): Promise<void> {
  const old = target.model;
  const now = shownModel;
  if (!now) return;
  if (compareDiff?.old !== old || compareDiff.now !== now) {
    // Takes seconds on big models (main thread): say so before the work blocks the window.
    compareBusy = true;
    renderVersionsButton();
    await viewport.afterNextFrame();
    compareBusy = false;
    if (shownModel !== now) {
      renderVersionsButton(); // another model was loaded meanwhile
      return;
    }
    const t0 = performance.now();
    // On the other version's surface within twice the mesh's chord error = not changed.
    const onOld = new SurfaceRaycaster(old);
    const onNew = new SurfaceRaycaster(now);
    const tol = 2 * Math.max(old.tessellation.linearDeflection, now.tessellation.linearDeflection);
    const diff = versionDiff(old, now, {
      old: (x, y, z) => onOld.near(x, y, z, tol),
      new: (x, y, z) => onNew.near(x, y, z, tol),
    });
    onOld.dispose();
    onNew.dispose();
    compareDiff = { old, now, diff };
    console.info(`Compare: diff in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  comparing = target;
  viewport.setCompare(compareDiff.diff);
  renderVersionsButton();
}
/** Compare with a version file next to the model (read and imported, not shown). */
async function compareWithFile(row: {
  readonly path: string;
  readonly name: string;
}): Promise<void> {
  const api = window.thirdWheel;
  const now = shownModel;
  const shown = shownFile;
  if (!api || !now || !shown) return;
  endCompare();
  compareBusy = true;
  renderVersionsButton();
  let model: StepModel | undefined;
  try {
    const file = await api.rereadModelFile(row.path);
    if (compareFile?.path === file.path && compareFile.contentHash === file.contentHash)
      model = compareFile.model;
    else {
      const loaded = await compareLoader.load(file, () => undefined);
      compareLoader.release(); // no exact values needed: free the kernel
      if (!loaded) return;
      compareFile = { path: file.path, contentHash: file.contentHash, model: loaded.model };
      model = loaded.model;
    }
  } catch (err) {
    if (shownModel === now)
      showNotice(`Couldn't read ${row.name} to compare: ${ipcErrorText(err)}`);
    return;
  } finally {
    compareBusy = false;
    renderVersionsButton();
  }
  if (shownModel !== now) return; // another model was opened meanwhile
  await startCompare({
    name: row.name,
    model,
    oldKey: `Only in ${row.name}`,
    newKey: `Only in ${shown.name} (shown)`,
  });
}
export function endCompare(): void {
  if (!comparing) return;
  comparing = undefined;
  viewport.setCompare(undefined);
  renderVersionsButton();
}
/**
 * A model added as a separate part is listed in the project at once (not only after its first
 * marker), so Versions ▾ and the next Add file know it.
 */
export async function listAsPart(file: ModelFile): Promise<void> {
  if (shownFile?.path !== file.path) return; // the load failed or another model came
  try {
    await window.thirdWheel?.addProjectPart(file.path);
  } catch (err) {
    console.warn(`Could not list ${file.name} in the project`, err);
  }
}
/**
 * File ▸ Add file… (⌘I / Ctrl+I, toolbar Add file): pick a file in the project folder; ask New
 * version of the shown model / Separate part (never guessed). The old version guess only checks
 * the choice. A file outside the project opens its own project.
 */
export async function addModel(): Promise<void> {
  const api = window.thirdWheel;
  if (!api || compareBusy) return;
  const shown = shownFile;
  await autosave.flush();
  let pick: AddModelPick | null;
  try {
    pick = await api.addModelDialog();
  } catch (err) {
    showAlert('Add file', ipcErrorText(err));
    return;
  }
  if (!pick || shownFile !== shown) return; // cancelled, or another model was opened meanwhile
  const { file } = pick;
  if (pick.place === 'outside') {
    if (!pick.project) {
      await loadModel(file, undefined, true); // nothing open yet: its own project
      return;
    }
    const answer = await askChoice(
      'Outside this project',
      `${file.name} is outside the folder of the project "${pick.project.name}" (${pick.project.folder}). Models are never copied into a project, so it can't be added here.`,
      'Open its folder as a project',
      'Cancel',
    );
    // Its own project: no "new version of …?" guess against this project's models.
    if (answer === 'first') await loadModel(file);
    return;
  }
  if (pick.place === 'other') {
    const answer = await askChoice(
      'In another project',
      `${file.name} belongs to the project "${pick.project.name}" (${pick.project.folder}), a folder inside this one with its own project.`,
      `Open "${pick.project.name}"`,
      'Cancel',
    );
    if (answer === 'first') await loadModel(file);
    return;
  }
  if (!shown) {
    // No model shown: the project's list stands in for it — a part whose name matches asks.
    const earlier = pick.versionOf;
    if (earlier && !meshFormatOf(file.name)) {
      const answer = await askChoice(
        `Add ${file.name}`,
        `Is it a new version of ${earlier.name} (its markers and comments move over) or a separate part of this project? Its name looks like a version of ${earlier.name}.`,
        `New version of ${earlier.name}`,
        'Separate part',
      );
      if (answer === 'none' || shownFile) return;
      if (answer === 'first') {
        await addVersion(file, earlier);
        return;
      }
    }
    await loadModel(file); // the first model of an empty project, or a separate part
    await listAsPart(file);
    return;
  }
  if (file.path === shown.path) {
    // The same file: Reload from disk (a changed file is a new version of itself).
    if (file.contentHash === shown.contentHash) showNotice(`${shown.name} hasn't changed on disk.`);
    else await loadModel(file);
    return;
  }
  const fromMesh = meshFormatOf(shown.name) !== undefined;
  const sameName = sameModelName(file.name, shown.name);
  // A STEP of a mesh often has another name: no "doesn't look like a version" check for it.
  const looksLikeVersion = fromMesh || sameName;
  const answer = await askChoice(
    `Add ${file.name}`,
    addFileQuestion(file.name, shown.name, {
      fromMesh,
      fileIsMesh: meshFormatOf(file.name) !== undefined,
      sameName,
    }),
    `New version of ${shown.name}`,
    'Separate part',
  );
  if (answer === 'none' || shownFile !== shown) return;
  if (answer === 'second') {
    // The shown file is a part too, even if it was only looked at so far (nothing written yet).
    try {
      await window.thirdWheel?.addProjectPart(shown.path);
    } catch (err) {
      console.warn(`Could not list ${shown.name} in the project`, err);
    }
    await loadModel(file);
    await listAsPart(file);
    return;
  }
  if (!looksLikeVersion) {
    const sure = await askChoice(
      'Add as a new version?',
      `${file.name} doesn't look like a version of ${shown.name}: the names differ. The markers and comments of ${shown.name} move onto it.`,
      'Add as new version',
      'Cancel',
    );
    if (sure !== 'first' || shownFile !== shown) return;
  }
  await addVersion(file, shown);
}
/** The open "looks like another part" question, if any. */
let differentPartAsked: { closedByLoad: boolean } | undefined;
/** A new model starts loading: the open "looks like another part" question is moot now. */
export function closeDifferentPartQuestion(): void {
  if (!differentPartAsked) return;
  differentPartAsked.closedByLoad = true;
  closeChoice();
}
/**
 * A new version the user added looks like another part (most markers lost, or a very different
 * size): asked with the model on screen, before its moved markers are saved. **New version**
 * (default, Esc) saves it; **Separate part** takes it out of the versions (as Remove from
 * versions… on the earlier one; the file stays on disk) and opens it on its own: nothing moved
 * was saved, so it starts without those markers. The earlier version never changes.
 */
export async function askDifferentPart(d: DifferentPart): Promise<void> {
  const q = differentPartQuestion(d.file.name, d.parent.name, d.reason);
  const asked = { closedByLoad: false };
  differentPartAsked = asked;
  let answer: Awaited<ReturnType<typeof askChoice>>;
  try {
    answer = await askChoice(q.title, q.text, q.version, q.separate, undefined, q.tips);
  } finally {
    if (differentPartAsked === asked) differentPartAsked = undefined;
  }
  const stillShown = (): boolean =>
    shownFile?.path === d.file.path && shownFile.contentHash === d.file.contentHash;
  // Another model was opened meanwhile (the question closed as it started loading, while this
  // file may still be on screen): nothing was saved, so the markers move over again the next
  // time this file opens (its link is kept).
  if (asked.closedByLoad || !stillShown()) return;
  if (answer !== 'second') {
    setPartMayChange(true);
    autosave.changed();
    return;
  }
  const api = window.thirdWheel;
  if (!api) return;
  let file: ModelFile;
  let removed = false;
  try {
    const list = await api.projectVersions(d.parent.path, d.parent.contentHash);
    const row = list?.rows.find((r) => r.contentHash === d.file.contentHash && !r.shown);
    if (!row) throw new Error(`${d.file.name} is not listed as a version of ${d.parent.name}`);
    await api.removeProjectVersion(d.parent.path, d.parent.contentHash, row.id);
    removed = true;
    file = await api.rereadModelFile(d.file.path, true);
  } catch (err) {
    if (removed) {
      // Separate already, only the reopen failed: what moved over must not be saved onto the
      // separate part, and opening the file again shows it without those markers.
      showNotice(
        `${d.file.name} is a separate part now but couldn't be reopened (${ipcErrorText(err)}). Open it again to see it without the markers of ${d.parent.name}.`,
      );
      return;
    }
    // Still linked: keep what moved over rather than lose it.
    if (stillShown()) {
      setPartMayChange(true);
      autosave.changed();
    }
    showNotice(`Couldn't make ${d.file.name} a separate part: ${ipcErrorText(err)}`);
    return;
  }
  if (!stillShown()) return;
  await loadModel(file);
  if (shownFile?.path === d.file.path)
    showNotice(
      `${d.file.name} is a separate part now, without the markers of ${d.parent.name}. ${d.parent.name} keeps its notes.`,
    );
}
/**
 * Link `file` as the newer version of `shown` (the shown model, or with none shown the project's
 * newest version of a matching part) and move its notes over.
 */
async function addVersion(file: ModelFile, shown: ShownVersion): Promise<void> {
  const shownBefore = shownFile?.path;
  if (meshFormatOf(file.name)) {
    // Mesh → STEP only (mesh → mesh: backlog).
    showAlert(
      'Not added as a version',
      `${file.name} is a mesh file. Notes move onto a STEP file (from a STEP or a mesh), not onto a mesh; add it as a separate part instead.`,
    );
    return;
  }
  // A file can't become newer than one of its own newer versions (a circle).
  let circle = false;
  try {
    circle =
      (await window.thirdWheel?.isEarlierVersion(
        { path: file.path, contentHash: file.contentHash },
        { path: shown.path, contentHash: shown.contentHash },
      )) ?? false;
  } catch (err) {
    console.warn('Could not check the version list', err);
  }
  if (shownFile?.path !== shownBefore) return; // another model was opened meanwhile
  if (circle) {
    showAlert(
      'Not added as a version',
      `${file.name} is an earlier version of ${shown.name}, so it can't also be a newer one. To change the order, remove it under Versions ▾ first.`,
    );
    return;
  }
  // The user is here: a file already linked to another earlier version asks which one is right.
  await loadModel(file, { path: shown.path, name: shown.name }, true);
}
/**
 * Open a version (or a part, Parts ▾) from the menu, like Open… (a version the project doesn't
 * list may ask to bring notes over).
 */
export async function openVersion(row: {
  readonly path: string;
  readonly name: string;
}): Promise<void> {
  const api = window.thirdWheel;
  if (!api) return;
  let file: ModelFile;
  try {
    file = await api.rereadModelFile(row.path, true);
  } catch (err) {
    showNotice(`Couldn't open ${row.name}: ${ipcErrorText(err)}`);
    return;
  }
  await loadModel(file, undefined, true);
}
/** The shown file as the menu sees it. */
type ShownVersion = { readonly path: string; readonly name: string; readonly contentHash: string };
/**
 * The shown part's versions as menu rows, from the project's list (each file checked on disk).
 * Empty when the project doesn't list the shown file yet (nothing saved for it so far).
 */
async function projectRows(shown: ShownVersion): Promise<VersionRow[]> {
  const api = window.thirdWheel;
  if (!api) return [];
  try {
    // The window's latest links first (a load that just linked a version saves right after).
    await autosave.flush();
    const list = await api.projectVersions(shown.path, shown.contentHash);
    if (list) return versionRows(list.rows);
  } catch (err) {
    console.warn('Could not read the versions of the project', err);
  }
  return [];
}
/** One version row of the menu. */
function versionEntry(shown: ShownVersion, row: VersionRow): MenuEntry {
  const base = { label: versionLabel(row), detail: versionDetail(row) };
  const locate: MenuEntry = {
    label: 'Locate…',
    action: 'locate-version',
    onSelect: () => void locateVersion(row),
  };
  // Every other version can be taken out of the list (the file stays on disk).
  const remove: MenuEntry = {
    label: 'Remove from versions…',
    action: 'remove-version',
    title: 'Take this file out of the versions (for a wrong import). The file stays on disk.',
    onSelect: () => void removeVersion(shown, row),
  };
  switch (row.state) {
    case 'shown':
      return { ...base, checked: true, disabled: true };
    case 'overwritten':
      return {
        ...base,
        action: 'version-row',
        title: 'A newer version was saved over this file, so these contents are gone from disk.',
        submenu: [remove],
      };
    case 'missing':
      return {
        ...base,
        action: 'version-row',
        title: `${row.path} is not there any more (moved, renamed or deleted).`,
        submenu: [locate, remove],
      };
    case 'changed':
      return {
        ...base,
        action: 'version-row',
        title: `${row.path} has other contents than the version listed here`,
        submenu: [
          {
            label: 'Open (as it is now)',
            action: 'open-version',
            onSelect: () => void openVersion(row),
          },
          locate,
          remove,
        ],
      };
    case 'found':
      return {
        ...base,
        action: 'version-row',
        title: row.path,
        submenu: [
          // Compare is between STEP files only; greyed with the reason.
          meshFormatOf(row.name) || meshFormatOf(shown.name)
            ? {
                label: `Compare with ${shown.name}`,
                action: 'compare-version',
                disabled: true,
                title:
                  'Compare works between STEP files only: an STL / 3MF has its own position and turn, so it would show as all changed',
              }
            : {
                label: `Compare with ${shown.name}`,
                action: 'compare-version',
                onSelect: () => void compareWithFile(row),
              },
          { label: 'Open', action: 'open-version', onSelect: () => void openVersion(row) },
          'separator',
          remove,
        ],
      };
  }
}
/**
 * "Remove from versions…": take `row`'s version out of the part's list, like unlinking a node from
 * a list — the versions made from it are now made from its earlier one. The file, its paint and the
 * part's comments stay; adding it again (Add file → New version) links it back. It writes
 * the project at once (no Undo), so it asks first.
 */
async function removeVersion(shown: ShownVersion, row: VersionRow): Promise<void> {
  const api = window.thirdWheel;
  const file = shownFile;
  if (!api || !file || file.path !== shown.path) return;
  const label = versionLabel(row);
  const answer = await askChoice(
    `Remove ${label} from the versions?`,
    `${
      row.state === 'overwritten'
        ? 'These contents are already gone from disk; only the entry goes.'
        : 'The file stays on disk.'
    } It is no longer listed as a version of ${file.name}, and Third Wheel stops suggesting it as a version. To link it again, use Add file, pick it and answer New version.`,
    'Remove',
    'Cancel',
  );
  if (answer !== 'first' || shownFile !== file) return;
  if (compareFile?.path === row.path && compareFile.contentHash === row.contentHash) endCompare();
  await autosave.flush(); // the project has the window's latest notes first
  if (shownFile !== file) return;
  try {
    await api.removeProjectVersion(file.path, file.contentHash, row.id);
  } catch (err) {
    showNotice(`Couldn't remove ${label} from the versions: ${ipcErrorText(err)}`);
    return;
  }
  showNotice(`Removed ${label} from the versions of ${file.name}. The file stays on disk.`);
  renderVersionsButton();
}
/**
 * "Locate…": the user picks where a moved / renamed version is now. Taken only when its contents
 * are the listed ones (content hash); the project then points there.
 */
async function locateVersion(row: VersionRow): Promise<void> {
  const api = window.thirdWheel;
  const shown = shownFile;
  if (!api || !shown) return;
  const file = await api.openModelDialog(`Locate ${row.name}`, shown.path);
  if (!file || shownFile !== shown) return; // another model was opened meanwhile
  if (file.contentHash !== row.contentHash) {
    showNotice(
      `${file.name} is not the version listed here: its contents are different from ${row.name}.`,
    );
    return;
  }
  await autosave.flush();
  if (shownFile !== shown) return;
  try {
    await api.locateProjectVersion(shown.path, shown.contentHash, row.id, file.path);
  } catch (err) {
    showNotice(`Couldn't use ${file.name}: ${ipcErrorText(err)}`);
    return;
  }
  showNotice(`Found ${row.name} at ${file.path}.`);
}
/**
 * The menu: compare with the previous version, then this model's version chain. Adding a version
 * is Add file (toolbar / File menu), which always asks New version / Separate part.
 */
async function versionEntries(shown: ShownVersion): Promise<MenuEntry[]> {
  const entries: MenuEntry[] = [];
  const prev = previousTarget();
  if (prev)
    entries.push({
      label: 'Compare with previous version',
      action: 'compare-previous',
      detail: prev.name,
      onSelect: () => void startCompare(prev),
    });
  if (comparing)
    entries.push({ label: 'Stop comparing', action: 'compare-stop', onSelect: endCompare });
  const rows = await projectRows(shown);
  if (entries.length > 0) entries.push('separator');
  entries.push({
    label: rows.length > 1 ? 'Versions of this model' : 'No other versions linked yet',
    disabled: true,
  });
  // The shown file always stays listed, even when many versions are cut off.
  const shownAt = Math.max(
    0,
    rows.findIndex((r) => r.state === 'shown'),
  );
  const listed = rows.filter((_r, i) => Math.abs(i - shownAt) < MAX_VERSION_ROWS / 2);
  for (const row of listed) entries.push(versionEntry(shown, row));
  if (rows.length > listed.length)
    entries.push({
      label: `… ${count.format(rows.length - listed.length)} more`,
      disabled: true,
    });
  entries.push('separator', {
    label: 'Add a version with Add file',
    title:
      'Add file → New version (or "Bring my notes over" when opening a file) links the two files. Separate part keeps a file on its own.',
    disabled: true,
  });
  return entries;
}
versionsButton.addEventListener('click', () => {
  const shown = shownFile;
  if (!shown || contextMenu.justClosedBy(versionsButton)) return;
  void versionEntries(shown).then((entries) => {
    if (shownFile === shown) openDropdown(versionsButton, entries);
  });
});
byId('compare-end').addEventListener('click', endCompare);
byId('add-file').addEventListener('click', () => {
  void addModel();
});
window.addEventListener('keydown', (e) => {
  if (isPrimaryShortcut(e, 'o', isMac)) {
    e.preventDefault();
    if (shortcutOnce.take('openFolder', 'key', performance.now())) openFolderDialog();
  } else if (isPrimaryShortcut(e, 'i', isMac)) {
    e.preventDefault();
    if (shortcutOnce.take('addModel', 'key', performance.now())) void addModel();
  }
});
window.thirdWheel?.onModelFile((file) => {
  void loadModel(file, undefined, true);
});
