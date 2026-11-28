/**
 * Model files the window may read (Open / Add file), version scans and file states, the project
 * session, and the project IPC for a shown model.
 */
import {
  type ModelFile,
  type ModelVersionFile,
  type VersionFileState,
  IPC,
} from '../../shared/ipc.js';
import { canonicalModelPath } from '../model-path.js';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import nodePath, { basename, dirname, extname, join, isAbsolute } from 'node:path';
import { STEP_EXTENSIONS, sameModelName, LOADABLE_EXTENSIONS, parseLock } from '@third-wheel/core';
import { ProjectSession } from '../project-session.js';
import { nodeProjectFs } from '../project-fs.js';
import { homedir, hostname } from 'node:os';
import { BrowserWindow, dialog, shell, ipcMain } from 'electron';
import { PROJECTS_GUIDE_URL } from '../../shared/about.js';
import { chatProjectShown, useChatProject } from '../chat-wiring.js';
import { readFileSync, rmSync } from 'node:fs';
import { rememberRecent, setEmptyProject } from '../index.js';

export const MODEL_FILTERS: Electron.FileFilter[] = [
  {
    name: 'Models (STEP, STL, 3MF)',
    extensions: ['step', 'stp', 'stl', '3mf', 'STEP', 'STP', 'STL', '3MF'],
  },
  { name: 'STEP', extensions: ['step', 'stp', 'STEP', 'STP'] },
  { name: 'Mesh (STL, 3MF)', extensions: ['stl', '3mf', 'STL', '3MF'] },
];

/** Model files handed to the renderer: these may be re-read (`IPC.rereadModelFile`). */
export const openedModelPaths = new Set<string>();

/** Reads a model the user (or the AI) opens: under its canonical path (`canonicalModelPath`). */
export async function openModelFile(path: string): Promise<ModelFile> {
  return readModelFile(await canonicalModelPath(path));
}

export async function readModelFile(path: string, open = true): Promise<ModelFile> {
  const buf = await readFile(path);
  if (open) openedModelPaths.add(path);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const contentHash = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
  return { path, name: basename(path), data, contentHash };
}

export function checkModelPath(path: unknown): string {
  if (typeof path !== 'string' || !openedModelPaths.has(path))
    throw new Error('Only the sidecar of an opened model can be used');
  return path;
}

/**
 * Other versions of an opened model, found by `listModelVersions`, `versionFileStates` or
 * listed by its project (`openVersion`, Versions ▾): their files and notes may be read (compare,
 * open, bring notes over), and they may be named as the version a shown model was made from. Their
 * notes are never written: only the shown model's are.
 */
export const versionModelPaths = new Set<string>();

/** Most versions of one model looked at (each costs a `stat`). */
const MAX_VERSION_SCAN = 5000;

/**
 * STEP files next to an opened model whose names make them versions of it (`part.step`,
 * `part_v2.step`, …), with their sidecar's modification time when they have one.
 */
export async function listModelVersions(modelPath: string): Promise<ModelVersionFile[]> {
  const folder = dirname(modelPath);
  const own = basename(modelPath);
  let names: string[];
  try {
    names = (await readdir(folder))
      .filter((n) => STEP_EXTENSIONS.includes(extname(n).toLowerCase()))
      .filter((n) => sameModelName(n, own))
      .slice(0, MAX_VERSION_SCAN);
  } catch {
    return []; // folder gone or not listable: nothing to offer
  }
  const out: ModelVersionFile[] = [];
  for (const name of names) {
    const path = join(folder, name);
    // Has notes in its project (or an old notes file not moved in yet).
    const sidecarMtimeMs = await projects.notesTime(path).catch(() => undefined);
    versionModelPaths.add(path);
    out.push(sidecarMtimeMs === undefined ? { path, name } : { path, name, sidecarMtimeMs });
  }
  return out;
}

/** Most version-chain files checked at once. */
export const MAX_VERSION_STATES = 200;
/** Content hash per file, kept while its size and modification time stay the same. */
const fileHashes = new Map<string, { size: number; mtimeMs: number; contentHash: string }>();

/**
 * Content hash of each version-chain file (null = not found). STEP, STL and 3MF (a
 * mesh's STEP version links back to it); found ones may then be read like listed versions (compare,
 * open, bring notes over).
 */
export async function versionFileStates(paths: unknown): Promise<VersionFileState[]> {
  if (!Array.isArray(paths)) throw new Error('Paths missing');
  const out: VersionFileState[] = [];
  for (const path of paths.slice(0, MAX_VERSION_STATES)) {
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      !LOADABLE_EXTENSIONS.includes(extname(path).toLowerCase())
    )
      continue;
    let contentHash: string | null = null;
    try {
      const info = await stat(path);
      if (info.isFile()) {
        const known = fileHashes.get(path);
        if (known?.size === info.size && known.mtimeMs === info.mtimeMs)
          contentHash = known.contentHash;
        else {
          contentHash = `sha256:${createHash('sha256')
            .update(await readFile(path))
            .digest('hex')}`;
          fileHashes.set(path, { size: info.size, mtimeMs: info.mtimeMs, contentHash });
        }
        versionModelPaths.add(path);
      }
    } catch {
      // not there (moved, renamed, deleted) or not readable
    }
    out.push({ path, contentHash });
  }
  return out;
}

/**
 * Notes of models live in the project (`project-session.ts`): the window still reads and saves
 * one model's notes at a time, the session turns that into project files.
 */
export const projects = new ProjectSession({
  fs: nodeProjectFs,
  path: nodePath,
  home: homedir(),
  self: {
    host: hostname(),
    pid: process.pid,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'; // runs, but not ours to signal
      }
    },
  },
  now: () => new Date(),
  realpath: (p) => realpath(p),
  confirm: async (message, detail, button, learnMore) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const buttons = learnMore ? [button, 'Cancel', 'Learn more…'] : [button, 'Cancel'];
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: 1,
      message,
      detail,
    };
    // "Learn more…" opens the user guide and asks again.
    for (;;) {
      const r = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (r.response !== 2) return r.response === 0;
      void shell.openExternal(PROJECTS_GUIDE_URL);
    }
  },
  askTakeOver: async (holder) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const since = new Date(holder.since);
    const when = Number.isNaN(since.getTime()) ? holder.since : since.toLocaleString();
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Open read-only', 'Take over'],
      defaultId: 0,
      cancelId: 0,
      message: holder.otherHost
        ? `This project is open on ${holder.host}`
        : 'This project is open in another Third Wheel',
      detail: `${holder.folder}\nOpen since ${when}.\n\nRead-only: you can look and mark, but nothing is saved. Take over: this app saves from now on; if the other one is still open, its changes may be lost.`,
    };
    const r = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return r.response === 1;
  },
  notice: (text) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.projectNotice, text);
    }
  },
  stateChanged: (state) => {
    chatProjectShown(state?.folder);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.projectState, state);
    }
  },
});
useChatProject(projects);

/** Paths the window may read notes of: opened models and versions found for them. */
export function checkNotesPath(path: unknown): string {
  if (typeof path === 'string' && versionModelPaths.has(path)) return path;
  return checkModelPath(path);
}

/** Release the project's lock as the app quits (sync: no awaiting while quitting). */
export function releaseLockSync(): void {
  const lock = projects.heldLock();
  if (!lock) return;
  try {
    const held = parseLock(readFileSync(lock, 'utf8'));
    if (held?.pid === process.pid && held.host === hostname()) rmSync(lock, { force: true });
  } catch {
    // gone already
  }
}

ipcMain.handle(IPC.openVersion, async (_event, modelPath: unknown, contentHash: unknown) => {
  const opened = await projects.open(
    checkNotesPath(modelPath),
    typeof contentHash === 'string' ? contentHash : undefined,
  );
  // Versions the project lists may be read (compare, bring notes over).
  for (const v of [opened.parent, opened.newer, opened.replaced])
    if (v) versionModelPaths.add(v.path);
  return opened;
});
ipcMain.handle(IPC.projectShown, async (_event, modelPath: unknown) => {
  const path = checkModelPath(modelPath);
  const state = await projects.shown(path);
  setEmptyProject(undefined);
  rememberRecent({ folder: state.folder, name: state.name, model: path });
  return state;
});
ipcMain.handle(IPC.newProjectHere, async (_event, modelPath: unknown) => {
  const path = checkModelPath(modelPath);
  const state = await projects.newProjectHere(path);
  if (state) rememberRecent({ folder: state.folder, name: state.name, model: path });
  return state ?? null;
});
ipcMain.handle(IPC.saveProjectAs, async (event, modelPath: unknown) => {
  const path = checkModelPath(modelPath);
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: 'Save project as — pick a folder for the copy',
    buttonLabel: 'Save here',
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const folder = result.filePaths[0];
  if (result.canceled || folder === undefined) return null;
  const state = await projects.saveAs(folder);
  rememberRecent({ folder: state.folder, name: state.name, model: path });
  return state;
});
