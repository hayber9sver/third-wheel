/**
 * A project with no model shown (New project folder…, an empty folder), the start page, Add
 * model…, versions and parts of a project, saving notes, perf results, theme.
 */
import {
  type ProjectState,
  IPC,
  type StartState,
  type AddModelPick,
  type ProjectVersions,
  type ProjectPartRow,
  type SaveResult,
  type ModelFile,
} from '../../shared/ipc.js';
import { ipcMain, BrowserWindow, dialog, app, nativeTheme } from 'electron';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { folderLabel } from '../recent-projects.js';
import { MAX_PROJECT_FILE_BYTES } from '@third-wheel/core';
import { dialogStartFolder } from '../dialog-folder.js';
import { statSync } from 'node:fs';
import { isThemeMode } from '../../shared/theme.js';
import {
  checkModelPath,
  checkNotesPath,
  chooseFolder,
  listModelVersions,
  MAX_VERSION_STATES,
  menuWindow,
  MODEL_FILTERS,
  openedModelPaths,
  openFolder,
  openModelFile,
  projects,
  readModelFile,
  recentProjects,
  rememberRecent,
  versionFileStates,
  versionModelPaths,
} from '../index.js';

// --- A project with no model shown (New project folder…, an empty folder), start page ---------

/** The project shown with no model (the start page shows it); cleared when a model is shown. */
export let emptyProject: ProjectState | undefined;
/** Sets `emptyProject` from another module (an import can't be assigned). */
export function setEmptyProject(value: typeof emptyProject): void {
  emptyProject = value;
}
/** Folders main offered to the window as an empty project (`IPC.openEmptyProject` takes only these). */
const offeredFolders = new Set<string>();

/** Open folder… found no model to show: the window shows the folder's project, empty. */
export function offerEmpty(folder: string): void {
  offeredFolders.add(folder);
  const win = menuWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.emptyProject, folder);
}

ipcMain.handle(IPC.openEmptyProject, async (_event, folder: unknown) => {
  if (typeof folder !== 'string' || !offeredFolders.has(folder))
    throw new Error('Only a folder the app offered can be opened this way');
  const state = await projects.openEmpty(folder);
  emptyProject = state;
  rememberRecent({ folder: state.folder, name: state.name, model: '' });
  return state;
});

ipcMain.handle(IPC.newProjectFolder, async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: 'New project folder — pick or create an empty folder',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  // Never a second project in one folder: one that has a project asks Open it / Pick another.
  for (;;) {
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const folder = result.filePaths[0];
    if (result.canceled || folder === undefined) return null;
    const r = await projects.newFolderProject(folder);
    if (!('existing' in r)) return newFolderResult(win, folder, r);
    if (r.shown) return { alreadyOpen: r.existing.name };
    const box: Electron.MessageBoxOptions = {
      type: 'info',
      buttons: ['Open it', 'Pick another folder', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `${basename(folder)} already has a project`,
      detail: `"${r.existing.name}" has ${countText(r.models, 'model')} and ${countText(r.comments, 'comment')}. A folder holds one project.`,
    };
    const answer = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
    if (answer.response === 0) {
      await openFolder(r.existing.folder); // like Open folder…: the model shown there last
      return null;
    }
    if (answer.response !== 1) return null;
  }
});

/** "2 models", "1 comment". */
function countText(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** New project folder…: a new project, or the box for a folder inside another project. */
async function newFolderResult(
  win: BrowserWindow | null,
  folder: string,
  r: { readonly state: ProjectState } | { readonly parent: ProjectState },
): Promise<{ readonly state: ProjectState } | null> {
  if ('parent' in r) {
    const box: Electron.MessageBoxOptions = {
      type: 'info',
      buttons: [`Open "${r.parent.name}"`, 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `${basename(folder)} already belongs to the project "${r.parent.name}"`,
      detail: `Models in this folder are part of "${r.parent.name}" (${r.parent.folder}). To give the folder a project of its own, open one of its models and use File ▸ Make this folder its own project….`,
    };
    const answer = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
    if (answer.response === 0) await openFolder(r.parent.folder);
    return null;
  }
  emptyProject = r.state;
  rememberRecent({ folder: r.state.folder, name: r.state.name, model: '' });
  return r;
}

ipcMain.handle(IPC.startState, (): StartState => {
  const home = homedir();
  return {
    recent: recentProjects.map((r) => ({
      name: r.name,
      folder: r.folder,
      folderLabel: folderLabel(r.folder, home),
      ...(r.opened ? { opened: r.opened } : {}),
    })),
    ...(emptyProject ? { project: emptyProject } : {}),
  };
});

ipcMain.handle(IPC.openRecentProject, async (_event, folder: unknown) => {
  if (typeof folder !== 'string' || !recentProjects.some((r) => r.folder === folder))
    throw new Error('Not a recent project');
  await openFolder(folder);
});

ipcMain.handle(IPC.openFolderDialog, () => chooseFolder());

ipcMain.handle(IPC.addModelDialog, async (event): Promise<AddModelPick | null> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const current = projects.state();
  const options: Electron.OpenDialogOptions = {
    ...(current ? { defaultPath: current.folder } : {}),
    title: current ? `Add a file to ${current.name}` : 'Add a file',
    buttonLabel: 'Add',
    properties: ['openFile'],
    filters: MODEL_FILTERS,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const picked = result.filePaths[0];
  if (result.canceled || picked === undefined) return null;
  const file = await openModelFile(picked);
  const where = await projects.placeOf(file.path);
  if (where.place === 'inside') {
    const named = where.listed
      ? undefined
      : await projects.namedPart(file.path).catch(() => undefined);
    // Only a version whose file is there with the listed contents can hand its notes over.
    const [state] = named ? await versionFileStates([named.path]) : [];
    const versionOf = named && state?.contentHash === named.contentHash ? named : undefined;
    return { file, place: 'inside', listed: where.listed, ...(versionOf ? { versionOf } : {}) };
  }
  if (where.place === 'other') return { file, place: 'other', project: where.project };
  return current ? { file, place: 'outside', project: current } : { file, place: 'outside' };
});
ipcMain.handle(IPC.listModelVersions, (_event, modelPath: unknown) =>
  listModelVersions(checkModelPath(modelPath)),
);

ipcMain.handle(IPC.versionFileStates, (_event, paths: unknown) => versionFileStates(paths));
/** A path + contents pair sent by the window. */
function versionKey(v: unknown): { file: string; contentHash: string } {
  const o = (v ?? {}) as { path?: unknown; contentHash?: unknown };
  if (typeof o.contentHash !== 'string') throw new Error('Content hash missing');
  return { file: checkNotesPath(o.path), contentHash: o.contentHash };
}
// `path` becomes a version made from `parent` (both in the shown project afterwards).
ipcMain.handle(
  IPC.linkProjectVersion,
  async (_event, path: unknown, contentHash: unknown, parent: unknown) => {
    if (typeof contentHash !== 'string') throw new Error('Content hash missing');
    const file = checkModelPath(path); // only a shown model gets a new place in the list
    return projects.link(file, contentHash, versionKey(parent));
  },
);
ipcMain.handle(IPC.projectFolders, async (_event, paths: unknown) => {
  if (!Array.isArray(paths)) throw new Error('Paths missing');
  const known = paths.slice(0, MAX_VERSION_STATES).map((p) => {
    try {
      return checkNotesPath(p);
    } catch {
      return undefined;
    }
  });
  const folders = await projects.projectFolders(known.filter((p) => p !== undefined));
  let i = 0;
  return known.map((p) => (p === undefined ? '' : (folders[i++] ?? '')));
});
// The shown file was saved over: its version gets the new contents (one file name = one version).
ipcMain.handle(
  IPC.replaceVersionContents,
  async (_event, path: unknown, oldHash: unknown, newHash: unknown) => {
    if (typeof oldHash !== 'string' || typeof newHash !== 'string')
      throw new Error('Content hash missing');
    const file = checkModelPath(path);
    return projects.replaceContents(file, oldHash, newHash);
  },
);
ipcMain.handle(IPC.isEarlierVersion, (_event, maybe: unknown, of: unknown) =>
  projects.isEarlier(versionKey(maybe), versionKey(of)),
);

// Add file… → Separate part: listed in the project at once, with its contents on disk now.
ipcMain.handle(IPC.addProjectPart, async (_event, path: unknown) => {
  const file = checkModelPath(path);
  const [now] = await versionFileStates([file]);
  if (!now?.contentHash) throw new Error('The file is not there any more');
  await projects.addPart(file, now.contentHash);
});
ipcMain.handle(IPC.projectPartOf, (_event, path: unknown, contentHash: unknown) => {
  if (typeof contentHash !== 'string') throw new Error('Content hash missing');
  return projects.partOf(checkModelPath(path), contentHash);
});
// Versions ▾ on the project's list (the shown model's part only).
ipcMain.handle(IPC.projectVersions, async (_event, path: unknown, contentHash: unknown) => {
  if (typeof contentHash !== 'string') throw new Error('Content hash missing');
  const list = await projects.versions(checkModelPath(path), contentHash);
  if (!list) return null;
  const states = new Map(
    (await versionFileStates(list.rows.map((r) => r.file))).map((s) => [s.path, s.contentHash]),
  );
  const out: ProjectVersions = {
    partName: list.partName,
    rows: list.rows.map(({ file, ...r }) => ({
      ...r,
      path: file,
      onDisk: states.get(file) ?? null,
    })),
  };
  return out;
});
// Parts ▾: the shown project's parts (open one = its newest version).
ipcMain.handle(IPC.projectParts, async (_event, shown: unknown) => {
  const s =
    typeof shown === 'object' && shown !== null
      ? (shown as { path?: unknown; contentHash?: unknown })
      : undefined;
  const which =
    s && typeof s.contentHash === 'string'
      ? { file: checkModelPath(s.path), contentHash: s.contentHash }
      : undefined;
  const parts = await projects.parts(which);
  const states = new Map(
    (await versionFileStates(parts.map((p) => p.file))).map((st) => [st.path, st.contentHash]),
  );
  return parts.map(({ file, ...p }): ProjectPartRow => ({
    ...p,
    path: file,
    onDisk: states.get(file) ?? null,
  }));
});
ipcMain.handle(
  IPC.removeProjectVersion,
  async (_event, path: unknown, contentHash: unknown, versionId: unknown) => {
    if (typeof contentHash !== 'string' || typeof versionId !== 'string')
      throw new Error('Version missing');
    return projects.removeVersion(checkModelPath(path), contentHash, versionId);
  },
);
ipcMain.handle(
  IPC.locateProjectVersion,
  async (_event, path: unknown, contentHash: unknown, versionId: unknown, moved: unknown) => {
    if (typeof contentHash !== 'string' || typeof versionId !== 'string')
      throw new Error('Version missing');
    // Only a file the user just picked (opened through the dialog) can be the new place, and only
    // with the version's contents.
    const shown = checkModelPath(path);
    const file = checkModelPath(moved);
    const row = (await projects.versions(shown, contentHash))?.rows.find((r) => r.id === versionId);
    const [now] = await versionFileStates([file]);
    if (!row || now?.contentHash !== row.contentHash)
      throw new Error('That file has other contents than this version');
    return projects.locateVersion(shown, contentHash, versionId, file);
  },
);

function saveNotes(modelPath: unknown, text: unknown, backupFirst: unknown): Promise<SaveResult> {
  try {
    const path = checkModelPath(modelPath);
    if (typeof text !== 'string') throw new Error('Notes missing');
    if (text.length > MAX_PROJECT_FILE_BYTES) throw new Error('Annotations too big to save');
    return projects.save(path, text, backupFirst === true);
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
ipcMain.handle(IPC.saveSidecar, (_event, modelPath: unknown, text: unknown, backupFirst: unknown) =>
  saveNotes(modelPath, text, backupFirst),
);
// Blocking for the window (its last save while it closes); set when the save finished.
ipcMain.on(
  IPC.saveSidecarSync,
  (event, modelPath: unknown, text: unknown, backupFirst: unknown) => {
    void saveNotes(modelPath, text, backupFirst).then((result) => {
      event.returnValue = result;
    });
  },
);
ipcMain.handle(IPC.backupSidecar, (_event, modelPath: unknown, contentHash: unknown) => {
  if (typeof contentHash !== 'string') throw new Error('Content hash missing');
  return projects.backup(checkModelPath(modelPath), contentHash);
});

ipcMain.handle(
  IPC.openModelDialog,
  async (event, title: unknown, shownPath: unknown): Promise<ModelFile | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const startIn = dialogStartFolder(
      shownPath,
      (p) => openedModelPaths.has(p) || versionModelPaths.has(p),
      (p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
    );
    const options: Electron.OpenDialogOptions = {
      ...(startIn === undefined ? {} : { defaultPath: startIn }), // dialog opens in the shown model's folder
      // Dialogs name what they are for (Locate…).
      title: typeof title === 'string' && title.length <= 300 ? title : 'Open model',
      properties: ['openFile'],
      filters: MODEL_FILTERS,
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return null;
    return openModelFile(path);
  },
);

ipcMain.handle(
  IPC.rereadModelFile,
  async (_event, path: unknown, open: unknown): Promise<ModelFile> => {
    // A version listed by `listModelVersions` may be read too (opened or compared from the
    // Versions menu).
    if (typeof path !== 'string' || !(openedModelPaths.has(path) || versionModelPaths.has(path)))
      throw new Error('Only a model opened before can be read again');
    // A version only read (to compare) stays read-only: its sidecar is never written.
    return readModelFile(path, openedModelPaths.has(path) || open === true);
  },
);

ipcMain.on(IPC.perfResult, (_event, result: unknown) => {
  if (app.isPackaged) return;
  // Resident memory per process type (KB → MB); "Tab" is the renderer, "GPU" the GPU process.
  const memoryMB: Record<string, number> = {};
  for (const m of app.getAppMetrics()) {
    const key = m.name ?? m.type;
    memoryMB[key] = (memoryMB[key] ?? 0) + Math.round(m.memory.workingSetSize / 1024);
  }
  console.log(`THIRD_WHEEL_PERF ${JSON.stringify({ ...(result as object), memoryMB })}`);
  app.quit();
});

ipcMain.on(IPC.setThemeSource, (_event, mode: unknown) => {
  if (isThemeMode(mode)) nativeTheme.themeSource = mode;
});
