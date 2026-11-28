/**
 * Open folder… and Open Recent (projects): the recent list, the app menu, choosing a folder.
 */
import { type RecentProject, parseRecent, addRecent, recentLabel } from '../recent-projects.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { app, Menu, dialog } from 'electron';
import { homedir } from 'node:os';
import { appMenuTemplate } from '../app-menu.js';
import { readdir } from 'node:fs/promises';
import { LOADABLE_EXTENSIONS } from '@third-wheel/core';
import {
  menuWindow,
  MODEL_FILTERS,
  offerEmpty,
  openInApp,
  projects,
  sendMenuCommand,
  showAbout,
} from '../index.js';

// --- Open folder…, Open Recent (projects) ---------------------------------------------------

const RECENT_FILE = 'recent-projects.json';
export let recentProjects: RecentProject[] = [];
/** Sets `recentProjects` from another module (an import can't be assigned). */
export function setRecentProjects(value: typeof recentProjects): void {
  recentProjects = value;
}

export function loadRecent(): RecentProject[] {
  try {
    return parseRecent(readFileSync(join(app.getPath('userData'), RECENT_FILE), 'utf8'));
  } catch {
    return [];
  }
}

function saveRecent(): void {
  try {
    writeFileSync(
      join(app.getPath('userData'), RECENT_FILE),
      JSON.stringify(recentProjects, null, 2),
    );
  } catch (err) {
    console.warn('Could not save the recent projects', err);
  }
}

export function rememberRecent(entry: RecentProject): void {
  const next = addRecent(recentProjects, { ...entry, opened: new Date().toISOString() });
  if (JSON.stringify(next) === JSON.stringify(recentProjects)) return;
  recentProjects = next;
  saveRecent();
  buildMenu();
}

export function buildMenu(): void {
  const home = homedir();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        platform: process.platform,
        dev: !app.isPackaged,
        onAbout: showAbout,
        onCommand: sendMenuCommand,
        recent: recentProjects.map((r) => ({ label: recentLabel(r, home), folder: r.folder })),
        onOpenRecent: (folder) => {
          void openFolder(folder);
        },
        onClearRecent: () => {
          recentProjects = [];
          saveRecent();
          buildMenu();
        },
      }),
    ),
  );
}

export async function chooseFolder(): Promise<void> {
  const win = menuWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Open a folder (its project)',
    buttonLabel: 'Open folder',
    properties: ['openDirectory'],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const folder = result.filePaths[0];
  if (result.canceled || folder === undefined) return;
  await openFolder(folder);
}

/**
 * Show a folder's project: the model shown there last, else its newest version. A folder without
 * a project: its only model, else the Open dialog inside it.
 */
export async function openFolder(folder: string): Promise<void> {
  const last = recentProjects.find((r) => r.folder === folder)?.model;
  let model = await projects.modelOf(folder, last).catch(() => undefined);
  let names: string[] = [];
  if (!model) {
    try {
      names = (await readdir(folder)).filter((n) =>
        LOADABLE_EXTENSIONS.includes(extname(n).toLowerCase()),
      );
    } catch {
      // gone or not readable: the dialog says so
    }
    if (names.length === 1 && names[0] !== undefined) model = join(folder, names[0]);
  }
  if (model) {
    openInApp(model);
    return;
  }
  if (names.length === 0) {
    // Nothing to open here yet (a new project folder): the start page offers Add file….
    offerEmpty(folder);
    return;
  }
  const win = menuWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Open a model in this folder',
    defaultPath: folder,
    properties: ['openFile'],
    filters: MODEL_FILTERS,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const picked = result.filePaths[0];
  if (!result.canceled && picked !== undefined) openInApp(picked);
  else offerEmpty(folder);
}
