/** Electron main process: one window hosting the renderer. */
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, rename, stat } from 'node:fs/promises';
import { APP_DISPLAY_NAME } from '../shared/app-name.js';
import { NOTICES_FILE_NAME } from '../shared/about.js';
import { appMenuTemplate } from './app-menu.js';
import type { MenuCommand } from '../shared/menu-commands.js';
import { canonicalModelPath } from './model-path.js';
import { dialogStartFolder } from './dialog-folder.js';
import { isLaunchRequest, modelPathFromArgs, type LaunchRequest } from './launch-file.js';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  bridgeFileSegments,
  BRIDGE_PROTOCOL,
  LOADABLE_EXTENSIONS,
  STEP_EXTENSIONS,
  loadParamsSchema,
  MAX_WAIT_SECONDS,
  parseParams,
  formatJson,
  MAX_VERSION_LINKS,
  sameModelName,
  chainEditSchema,
  editChain,
  versionChainSchema,
  versionLinkSchema,
  waitReviewParamsSchema,
  type PingResult,
} from '@third-wheel/core';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron';
import {
  IPC,
  perfModeFromEnv,
  type BridgeRendererReply,
  type BridgeRendererRequest,
  type LoadRequest,
  type ModelFile,
  type ModelVersionFile,
  type SaveResult,
  type VersionFileState,
} from '../shared/ipc.js';
import { BridgeMethodError, startBridge, type Bridge, type BridgeHandler } from './bridge.js';
import {
  MCP_RUN_AS_NODE,
  toolOfMethod,
  type AiActivity,
  type ConnectResult,
  type McpSetup,
} from '../shared/ai-status.js';
import {
  codexConfigPath,
  connectClaudeCode,
  connectCodex,
  connectGemini,
  findClaude,
  findGemini,
} from './agent-cli.js';
import { cursorInstallUrl, vscodeInstallUrl } from '../shared/agents.js';
import { sidecarBackupName, sidecarFileName } from '../shared/sidecar-path.js';
import { isThemeMode } from '../shared/theme.js';
import { fitAfterMove, fitBounds } from '../shared/window-fit.js';

// Matches --bg in the renderer's styles.css so the window doesn't flash on load.
const BACKGROUND = { light: '#f4f5f7', dark: '#1b1d21' } as const;
const PREFERRED_SIZE = { width: 1440, height: 900 };
const MIN_SIZE = { width: 960, height: 600 };
/** Quiet time after the last move event before checking the window still fits its display. */
const MOVE_SETTLE_MS = 400;

/**
 * Keep the window inside the display it is on: after moving to a smaller / more scaled screen,
 * or when the display's resolution or scaling changes. Maximized/fullscreen windows are left to the OS.
 */
function fitToDisplay(win: BrowserWindow, mode: 'display-changed' | 'moved'): void {
  if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  win.setMinimumSize(
    Math.min(MIN_SIZE.width, workArea.width),
    Math.min(MIN_SIZE.height, workArea.height),
  );
  const fit = mode === 'moved' ? fitAfterMove : fitBounds;
  const fitted = fit(win.getBounds(), workArea);
  if (fitted) win.setBounds(fitted);
}

/**
 * App icon (copies of `assets/icons/` in `apps/desktop/resources/`): `.ico` on Windows,
 * PNG elsewhere. Packaged builds get theirs from the installer config (R4).
 */
const APP_ICON = join(
  import.meta.dirname,
  '../../resources',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png',
);

function createWindow(openOnStart?: string): BrowserWindow {
  // Open on the display under the cursor, no bigger than its usable area.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(PREFERRED_SIZE.width, workArea.width);
  const height = Math.min(PREFERRED_SIZE.height, workArea.height);
  const win = new BrowserWindow({
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(MIN_SIZE.width, workArea.width),
    minHeight: Math.min(MIN_SIZE.height, workArea.height),
    show: false,
    title: APP_DISPLAY_NAME,
    icon: APP_ICON, // Windows title bar + taskbar (macOS takes the Dock icon, below)
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (openOnStart) {
    win.webContents.once('did-finish-load', () => {
      sendModelFile(win, openOnStart);
    });
  }

  const refit = (): void => {
    fitToDisplay(win, 'display-changed');
  };
  // On macOS 'moved' fires continuously *during* a drag (it aliases 'move'); refitting then
  // pinned the window to its display. Wait until the window has been still for a moment.
  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      fitToDisplay(win, 'moved');
    }, MOVE_SETTLE_MS);
  });
  screen.on('display-metrics-changed', refit);
  screen.on('display-removed', refit);
  const contentsId = win.webContents.id;
  win.webContents.on('did-start-loading', () => {
    dropWindowRequests(contentsId);
  });
  win.webContents.on('render-process-gone', () => {
    dropWindowRequests(contentsId);
  });
  win.on('closed', () => {
    dropWindowRequests(contentsId);
    clearTimeout(moveTimer);
    screen.off('display-metrics-changed', refit);
    screen.off('display-removed', refit);
  });

  // Open external links in the OS browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Dev perf hook (not in packaged builds): THIRD_WHEEL_PERF=1 (live readout) or =bench.
  const perf = app.isPackaged ? 'off' : perfModeFromEnv(process.env['THIRD_WHEEL_PERF']);
  // Test hook (not in packaged builds): THIRD_WHEEL_TEST=1 exposes `window.__thirdWheelTest`
  // to Playwright smoke tests (e2e/).
  const query: Record<string, string> = { perf };
  if (!app.isPackaged && process.env['THIRD_WHEEL_TEST'] === '1') query['test'] = '1';
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    const url = new URL(devUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query });
  }
  return win;
}

/** Model files handed to the renderer: these may be re-read (`IPC.rereadModelFile`). */
const openedModelPaths = new Set<string>();

/** A bigger sidecar is not read (a broken or hostile file must not hang the app). */
const MAX_SIDECAR_BYTES = 256 * 1024 * 1024;

function sidecarPath(modelPath: string): string {
  return join(dirname(modelPath), sidecarFileName(basename(modelPath)));
}

/** Sidecar text next to `modelPath`, or null when there is none. Other errors reject. */
async function readSidecar(modelPath: string): Promise<string | null> {
  const path = sidecarPath(modelPath);
  try {
    if ((await stat(path)).size > MAX_SIDECAR_BYTES) {
      throw new Error(`bigger than ${String(MAX_SIDECAR_BYTES / 1024 ** 2)} MB`);
    }
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Reads a model the user (or the AI) opens: under its canonical path (`canonicalModelPath`). */
async function openModelFile(path: string): Promise<ModelFile> {
  return readModelFile(await canonicalModelPath(path));
}

async function readModelFile(path: string, open = true): Promise<ModelFile> {
  const buf = await readFile(path);
  if (open) openedModelPaths.add(path);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const contentHash = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
  return { path, name: basename(path), data, contentHash };
}

function checkModelPath(path: unknown): string {
  if (typeof path !== 'string' || !openedModelPaths.has(path))
    throw new Error('Only the sidecar of an opened model can be used');
  return path;
}

/**
 * Other versions of an opened model, found by `listModelVersions` (T8.4) or named in its version
 * chain (`versionFileStates`, T8.6): their files and sidecars may be read (compare, open, bring
 * notes over). Written only through `addNewerVersion` (only for `nearVersionPaths`) and, after the
 * user confirmed Remove from versions, `editVersionLinks` (existing notes of these contents only).
 */
const versionModelPaths = new Set<string>();
/**
 * Versions in an opened model's own folder (`listModelVersions`): besides opened models, the only
 * files whose notes may get a "newer version" line, or a new notes file (T8.6). T13.4: the chain
 * edits of `editVersionLinks` (Remove from versions, a moved link) may also change `versions` in
 * the existing notes of files found through a chain, but only when those notes belong to the linked
 * contents (content hash); nothing else in them is written, and no notes file is created.
 */
const nearVersionPaths = new Set<string>();

/** Most versions of one model looked at (each costs a `stat`). */
const MAX_VERSION_SCAN = 5000;

/**
 * STEP files next to an opened model whose names make them versions of it (`part.step`,
 * `part_v2.step`, …), with their sidecar's modification time when they have one (T8.4).
 */
async function listModelVersions(modelPath: string): Promise<ModelVersionFile[]> {
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
    let sidecarMtimeMs: number | undefined;
    try {
      const info = await stat(sidecarPath(path));
      if (info.isFile()) sidecarMtimeMs = info.mtimeMs;
    } catch {
      // no sidecar
    }
    versionModelPaths.add(path);
    nearVersionPaths.add(path);
    out.push(sidecarMtimeMs === undefined ? { path, name } : { path, name, sidecarMtimeMs });
  }
  return out;
}

/** Most version-chain files checked at once (T8.6). */
const MAX_VERSION_STATES = 200;
/** Content hash per file, kept while its size and modification time stay the same. */
const fileHashes = new Map<string, { size: number; mtimeMs: number; contentHash: string }>();

/**
 * T8.6: content hash of each version-chain file (null = not found). STEP, STL and 3MF (T11.2: a
 * mesh's STEP version links back to it); found ones may then be read like listed versions (compare,
 * open, bring notes over).
 */
async function versionFileStates(paths: unknown): Promise<VersionFileState[]> {
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
 * T8.6: add a "newer version" line to an earlier version's notes. Only
 * `versions.newer` changes; markers, comments and fields this app doesn't know stay as they are.
 * Without notes, `emptyNotes` (a sidecar without markers, made by the window) gets the line.
 */
async function addNewerVersion(
  olderPath: unknown,
  link: unknown,
  emptyNotes: unknown,
): Promise<void> {
  if (
    typeof olderPath !== 'string' ||
    !(openedModelPaths.has(olderPath) || nearVersionPaths.has(olderPath))
  )
    throw new Error('Only the notes of a model opened before can get a newer version');
  const newer = versionLinkSchema.parse(link);
  const text = (await readSidecar(olderPath)) ?? emptyNotes;
  if (typeof text !== 'string') throw new Error('Notes missing');
  const doc: unknown = JSON.parse(text);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    throw new Error('Notes are not a JSON object');
  const notes = doc as Record<string, unknown>;
  const chain =
    typeof notes.versions === 'object' && notes.versions !== null && !Array.isArray(notes.versions)
      ? (notes.versions as Record<string, unknown>)
      : {};
  const old = Array.isArray(chain.newer) ? (chain.newer as unknown[]) : [];
  const same = (l: unknown): boolean =>
    typeof l === 'object' &&
    l !== null &&
    (l as { path?: unknown }).path === newer.path &&
    (l as { contentHash?: unknown }).contentHash === newer.contentHash;
  // Linked again (T13.4): the "removed from its chain" mark goes.
  const rest = { ...chain };
  delete rest.unlinked;
  notes.versions = {
    ...rest,
    newer: [newer, ...old.filter((l) => !same(l))].slice(0, MAX_VERSION_LINKS),
  };
  const result = writeSidecarText(olderPath, formatJson(notes), false);
  if (!result.ok) throw new Error(result.error);
}

/**
 * T13.4 (Remove from versions): change the version chain in the notes of another version — only
 * `versions`; markers, comments and unknown fields stay. Only an existing notes file of a model
 * opened before or found through a version chain (`versionModelPaths`), and only when those notes
 * belong to `contentHash` (the version meant); never creates a notes file. A chain that can't be
 * read is replaced by the edit's result on an empty one.
 */
async function editVersionLinks(path: unknown, contentHash: unknown, edit: unknown): Promise<void> {
  if (typeof path !== 'string' || !(openedModelPaths.has(path) || versionModelPaths.has(path)))
    throw new Error('Only the notes of a version found before can be changed');
  if (typeof contentHash !== 'string') throw new Error('Content hash missing');
  const change = chainEditSchema.parse(edit);
  const text = await readSidecar(path);
  if (text === null) throw new Error('It has no notes file');
  const doc: unknown = JSON.parse(text);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    throw new Error('Notes are not a JSON object');
  const notes = doc as Record<string, unknown>;
  const model = notes.model as { contentHash?: unknown } | undefined;
  if (model?.contentHash !== contentHash)
    throw new Error('Its notes belong to other contents of the file');
  const chain = versionChainSchema.safeParse(notes.versions);
  const next = editChain(chain.success ? chain.data : undefined, change);
  if (next) notes.versions = next;
  else delete notes.versions;
  const result = writeSidecarText(path, formatJson(notes), false);
  if (!result.ok) throw new Error(result.error);
}

/**
 * Write the sidecar: to a temporary file first, then renamed over the old one, so a crash
 * mid-write never leaves half a file. (Rename replaces an existing file on macOS and Windows.)
 */
function writeSidecar(modelPath: unknown, text: unknown, backupFirst: unknown): SaveResult {
  try {
    return writeSidecarText(checkModelPath(modelPath), text, backupFirst);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `writeSidecar` for a path already checked. */
function writeSidecarText(model: string, text: unknown, backupFirst: unknown): SaveResult {
  let tmp: string | undefined;
  try {
    const path = sidecarPath(model);
    if (typeof text !== 'string') throw new Error('Sidecar text missing');
    if (text.length > MAX_SIDECAR_BYTES) throw new Error('Annotations too big to save');
    // A load dropped data the app can't keep (T5.2): copy the old file first. If the
    // copy fails, nothing is overwritten (the write fails and is retried with the next change).
    let backup: string | undefined;
    if (backupFirst === true && existsSync(path)) {
      backup = freeBackupPath(model);
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
    }
    tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameWithRetry(tmp, path);
    return backup === undefined ? { ok: true } : { ok: true, backup: basename(backup) };
  } catch (err) {
    if (tmp !== undefined) rmSync(tmp, { force: true });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Codes Windows gives while antivirus / the indexer / OneDrive briefly holds a file. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** `renameSync`, retried a few times (50 ms apart) while the target is briefly locked (Windows). */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 4 || !BUSY_CODES.has(code)) throw err;
      // Synchronous wait: this also runs for the last save while the window closes.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Backup path that doesn't exist yet (`….bak.json`, then `….bak-2.json`, …). */
function freeBackupPath(model: string): string {
  const first = join(dirname(model), sidecarBackupName(basename(model), new Date()));
  if (!existsSync(first)) return first;
  for (let n = 2; ; n++) {
    const next = first.replace(/\.bak\.json$/, `.bak-${String(n)}.json`);
    if (!existsSync(next)) return next;
  }
}

ipcMain.handle(IPC.readSidecar, (_event, modelPath: unknown) =>
  readSidecar(
    typeof modelPath === 'string' && versionModelPaths.has(modelPath)
      ? modelPath
      : checkModelPath(modelPath),
  ),
);
ipcMain.handle(IPC.listModelVersions, (_event, modelPath: unknown) =>
  listModelVersions(checkModelPath(modelPath)),
);

ipcMain.handle(IPC.versionFileStates, (_event, paths: unknown) => versionFileStates(paths));
ipcMain.handle(IPC.addNewerVersion, (_event, olderPath: unknown, link: unknown, notes: unknown) =>
  addNewerVersion(olderPath, link, notes),
);
ipcMain.handle(IPC.editVersionLinks, (_event, path: unknown, contentHash: unknown, edit: unknown) =>
  editVersionLinks(path, contentHash, edit),
);

ipcMain.handle(IPC.saveSidecar, (_event, modelPath: unknown, text: unknown, backupFirst: unknown) =>
  writeSidecar(modelPath, text, backupFirst),
);
ipcMain.on(
  IPC.saveSidecarSync,
  (event, modelPath: unknown, text: unknown, backupFirst: unknown) => {
    event.returnValue = writeSidecar(modelPath, text, backupFirst);
  },
);
ipcMain.handle(IPC.backupSidecar, async (_event, modelPath: unknown): Promise<string | null> => {
  const model = checkModelPath(modelPath);
  const backup = freeBackupPath(model);
  try {
    await rename(sidecarPath(model), backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return basename(backup);
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
      ...(startIn === undefined ? {} : { defaultPath: startIn }), // T12.8
      // T8.5 "Import new version…" names the model it is for.
      title: typeof title === 'string' && title.length <= 300 ? title : 'Open model',
      properties: ['openFile'],
      filters: [
        {
          name: 'Models (STEP, STL, 3MF)',
          extensions: ['step', 'stp', 'stl', '3mf', 'STEP', 'STP', 'STL', '3MF'],
        },
        { name: 'STEP', extensions: ['step', 'stp', 'STEP', 'STP'] },
        { name: 'Mesh (STL, 3MF)', extensions: ['stl', '3mf', 'STL', '3MF'] },
      ],
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
    // T8.5: a version listed by `listModelVersions` may be read too (opened or compared from the
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

// --- App bridge (T7.1): the MCP server talks to the app over a localhost WebSocket ----------

/** How long the window may take to answer a bridge request. */
const WINDOW_ANSWER_MS = 30_000;
/** Opening a model (huge assemblies take minutes) and taking pictures may take longer. */
const WINDOW_LOAD_MS = 10 * 60_000;
const WINDOW_RENDER_MS = 120_000;
/** Extra time over a `wait_review` long-poll before main gives up on the window. */
const WAIT_GRACE_MS = 10_000;
let nextWindowRequest = 1;
const windowRequests = new Map<
  number,
  {
    sender: number;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

/** Ask the app window to answer a bridge method (it holds the model and annotations). */
function askWindow(
  method: string,
  params: unknown,
  timeoutMs = WINDOW_ANSWER_MS,
  bringToFront = false,
): Promise<unknown> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win)
    return Promise.reject(
      new BridgeMethodError('no_window', `${APP_DISPLAY_NAME} has no window open`),
    );
  // Still starting up / reloading: it can't answer yet, say so now instead of after the timeout.
  if (win.webContents.isLoading())
    return Promise.reject(
      new BridgeMethodError('no_window', 'The app window is still loading — try again'),
    );
  const requestId = nextWindowRequest++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      windowRequests.delete(requestId);
      reject(new BridgeMethodError('timeout', `The app window did not answer "${method}"`));
    }, timeoutMs);
    windowRequests.set(requestId, { sender: win.webContents.id, resolve, reject, timer });
    const request: BridgeRendererRequest = { requestId, method, params };
    if (bringToFront) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    win.webContents.send(IPC.bridgeRequest, request);
  });
}

/** Checks bridge params in main; a bad one is the caller's fault (`bad_request`). */
function mainParams<T>(
  schema: Parameters<typeof parseParams<T>>[0],
  params: unknown,
  method: string,
): T {
  try {
    return parseParams(schema, params, method);
  } catch (err) {
    throw new BridgeMethodError('bad_request', err instanceof Error ? err.message : String(err));
  }
}

/** `load` (MCP `load_model`): read a model file (STEP / STL / 3MF) from disk, then the window shows it. */
async function bridgeLoad(params: unknown): Promise<unknown> {
  const { path, revisionOf } = mainParams(loadParamsSchema, params, 'load');
  if (!isAbsolute(path))
    throw new BridgeMethodError('bad_request', `Give an absolute path (got "${path}")`);
  // Network shares: opening \\host\share makes Windows log in to that host (credential leak).
  if (/^[\\/]{2}/.test(path))
    throw new BridgeMethodError(
      'bad_request',
      'Network paths are not opened; copy the file locally',
    );
  if (!LOADABLE_EXTENSIONS.includes(extname(path).toLowerCase()))
    throw new BridgeMethodError(
      'bad_request',
      `Only STEP, STL and 3MF files (${LOADABLE_EXTENSIONS.join(', ')}) can be opened (got "${basename(path)}")`,
    );
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new BridgeMethodError('failed', `No such file: ${path}`);
  }
  if (!info.isFile()) throw new BridgeMethodError('failed', `Not a file: ${path}`);
  const file = await openModelFile(path);
  const request: LoadRequest = revisionOf ? { ...file, revisionOf } : file;
  return askWindow('load', request, WINDOW_LOAD_MS, true);
}

/** The window reloaded or crashed: its requests will never be answered. */
function dropWindowRequests(sender: number): void {
  for (const [id, pending] of windowRequests) {
    if (pending.sender !== sender) continue;
    windowRequests.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new BridgeMethodError('no_window', 'The app window reloaded or closed'));
  }
}

ipcMain.on(IPC.bridgeReply, (event, reply: BridgeRendererReply | undefined) => {
  if (typeof reply?.requestId !== 'number') return;
  const pending = windowRequests.get(reply.requestId);
  if (!pending || pending.sender !== event.sender.id) return;
  windowRequests.delete(reply.requestId);
  clearTimeout(pending.timer);
  if (reply.ok) pending.resolve(reply.result);
  else pending.reject(new Error(reply.message));
});

let bridge: Bridge | undefined;

// --- AI status (T7.6): bridge state + last MCP tool call, for the status-bar item -------------
// One bridge connection per tool call: the app can only know the last call, never "connected".
let aiActivity: AiActivity = { bridge: 'starting' };
function setAiActivity(next: AiActivity): void {
  aiActivity = next;
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send(IPC.aiActivity, aiActivity);
}
/** Wrap the bridge handlers so every MCP tool call is recorded (ping / status are not tools). */
function recordingCalls(
  handlers: Readonly<Record<string, BridgeHandler>>,
): Record<string, BridgeHandler> {
  const out: Record<string, BridgeHandler> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    const tool = toolOfMethod(method);
    out[method] = tool
      ? async (params) => {
          const record = (): void => {
            setAiActivity({ ...aiActivity, lastCall: { tool, at: Date.now() } });
          };
          record();
          // Also when it ends: a long wait_for_review must not turn the dot grey mid-wait.
          try {
            return await handler(params);
          } finally {
            record();
          }
        }
      : handler;
  }
  return out;
}
ipcMain.handle(IPC.getAiActivity, (): AiActivity => aiActivity);

/** The MCP server file: inside the app's resources when packaged (R4: installers must ship it), else the repo build. */
function mcpSetup(): McpSetup {
  const serverPath = app.isPackaged
    ? join(process.resourcesPath, 'mcp', 'third-wheel-mcp.js')
    : resolve(
        app.getAppPath(),
        '..',
        '..',
        'packages',
        'mcp-server',
        'build',
        'third-wheel-mcp.js',
      );
  const exe = process.execPath;
  return {
    serverPath,
    exists: existsSync(serverPath),
    packaged: app.isPackaged,
    platform: process.platform,
    // Packaged: the app's own Electron runs the server as Node, so users need no Node (R4).
    command: app.isPackaged ? exe : 'node',
    env: app.isPackaged ? MCP_RUN_AS_NODE : {},
    temporaryLocation:
      app.isPackaged &&
      process.platform === 'darwin' &&
      (exe.startsWith('/Volumes/') || exe.includes('/AppTranslocation/')),
  };
}
ipcMain.handle(IPC.getMcpSetup, (): McpSetup => mcpSetup());
/**
 * Test hooks (not in packaged builds): a fake `claude` / `gemini` program (empty = "not
 * installed"), a folder in place of `~/.codex`.
 */
const testOverride = (name: string): string | undefined =>
  app.isPackaged ? undefined : process.env[name];
const claudeOverride = testOverride('THIRD_WHEEL_CLAUDE');
const geminiOverride = testOverride('THIRD_WHEEL_GEMINI');
const codexOverride = testOverride('THIRD_WHEEL_CODEX_HOME');
ipcMain.handle(IPC.findAgent, async (_e, agent: unknown): Promise<string | null> => {
  if (agent === 'claude') return (await findClaude(claudeOverride)) ?? null;
  if (agent === 'gemini') return (await findGemini(geminiOverride)) ?? null;
  if (agent === 'codex') return codexConfigPath(codexOverride);
  return null;
});
ipcMain.handle(IPC.connectAgent, async (_e, agent: unknown): Promise<ConnectResult> => {
  const setup = mcpSetup();
  if (agent === 'claude') return connectClaudeCode(setup, claudeOverride);
  if (agent === 'gemini') return connectGemini(setup, geminiOverride);
  if (agent === 'codex') return connectCodex(setup, codexOverride);
  if (agent !== 'cursor' && agent !== 'vscode') return { ok: false, reason: 'failed' };
  if (setup.temporaryLocation) return { ok: false, reason: 'temporary-location' };
  // Built here, not taken from the page: the renderer can't make main open any other link.
  const url = agent === 'cursor' ? cursorInstallUrl(setup) : vscodeInstallUrl(setup);
  try {
    await shell.openExternal(url);
    return { ok: true, path: url };
  } catch {
    return { ok: false, reason: 'not-found' }; // no app handles the link: not installed
  }
});

/**
 * Third-party notices (T13.1): `resources/` in dev; packaged builds ship it next to the app
 * (`process.resourcesPath`, installer config in R4).
 */
const NOTICES_PATH = app.isPackaged
  ? join(process.resourcesPath, NOTICES_FILE_NAME)
  : join(import.meta.dirname, '../../resources', NOTICES_FILE_NAME);
ipcMain.on(IPC.textUndoRedo, (event, which: unknown) => {
  if (which === 'undo') event.sender.undo();
  else if (which === 'redo') event.sender.redo();
});
ipcMain.handle(IPC.getAppVersion, (): string => app.getVersion());
ipcMain.handle(IPC.getThirdPartyNotices, (): Promise<string> => readFile(NOTICES_PATH, 'utf8'));

/** The window a menu item acts on: the focused (or first) one, brought to the front. */
function menuWindow(): BrowserWindow | undefined {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return undefined;
  if (win.isMinimized()) win.restore();
  win.focus();
  return win;
}

/** About Third Wheel (menu): show the in-app dialog. */
function showAbout(): void {
  menuWindow()?.webContents.send(IPC.showAbout);
}

/** File / Undo / Redo / Help menu items (T13.2): the window carries them out. */
function sendMenuCommand(command: MenuCommand): void {
  menuWindow()?.webContents.send(IPC.menuCommand, command);
}

async function startAppBridge(): Promise<void> {
  // THIRD_WHEEL_BRIDGE=0 turns it off; THIRD_WHEEL_BRIDGE_FILE moves the file (tests, two setups).
  if (process.env['THIRD_WHEEL_BRIDGE'] === '0') {
    setAiActivity({ bridge: 'off' });
    return;
  }
  const filePath = join(...bridgeFileSegments(process.platform, process.env, homedir()));
  const version = app.getVersion();
  try {
    bridge = await startBridge({
      filePath,
      version,
      handlers: recordingCalls({
        ping: (): PingResult => ({ app: 'third-wheel', version, protocol: BRIDGE_PROTOCOL }),
        status: (params) => askWindow('status', params),
        open_model: (params) => askWindow('status', params),
        search_parts: (params) => askWindow('search_parts', params),
        load: bridgeLoad,
        annotations: (params) => askWindow('annotations', params),
        request_review: (params) => askWindow('request_review', params, WINDOW_ANSWER_MS, true),
        wait_review: (params) => {
          const { timeoutSec } = mainParams(waitReviewParamsSchema, params, 'wait_review');
          return askWindow(
            'wait_review',
            params,
            Math.min(timeoutSec, MAX_WAIT_SECONDS) * 1000 + WAIT_GRACE_MS,
          );
        },
        render: (params) => askWindow('render', params, WINDOW_RENDER_MS),
        set_comment_status: (params) => askWindow('set_comment_status', params),
        reply_comment: (params) => askWindow('reply_comment', params),
      }),
    });
    setAiActivity({ bridge: 'on' });
    console.info(`App bridge on 127.0.0.1:${String(bridge.port)} (${filePath})`);
  } catch (err) {
    // The app still works without it; only AI agents can't reach it.
    console.error('App bridge could not start:', err);
    setAiActivity({ bridge: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

app.on('will-quit', () => {
  bridge?.removeFileSync();
});

/** Reads a model file and hands it to the window, as Open… does. */
function sendModelFile(win: BrowserWindow, path: string): void {
  openModelFile(resolve(path)).then(
    (file) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.modelFile, file);
    },
    (err: unknown) => {
      console.error(`Cannot open ${path}:`, err);
    },
  );
}

/**
 * Opens a file in the running app (second launch, macOS "Open with" / Dock drop): the window is
 * brought to the front, created if none is open (macOS), and loads the file (if any) once its page
 * is ready.
 */
function openInApp(path?: string): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) {
    createWindow(path);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!path) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      sendModelFile(win, path);
    });
  } else {
    sendModelFile(win, path);
  }
}

/**
 * The file this launch asks to open: a model path on the command line, else the dev / test hook
 * THIRD_WHEEL_OPEN=<file> (not in packaged builds).
 */
const launchFile =
  modelPathFromArgs(process.argv.slice(1), process.cwd()) ??
  (app.isPackaged ? undefined : process.env['THIRD_WHEEL_OPEN']);

// Display name for menus / About (T13.0). Electron derives its user-data folder (settings,
// single-instance lock) from the app name, so pin it to the folder used before the rename.
// Packaged builds are named "Third Wheel" (R4), which would start in a new, empty folder: pin
// them to the dev folder too (unless a test passes --user-data-dir).
const userDataFolder =
  app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')
    ? join(app.getPath('appData'), '@third-wheel', 'desktop')
    : app.getPath('userData');
app.setName(APP_DISPLAY_NAME);
app.setPath('userData', userDataFolder);

// One app copy at a time (T11.3): two copies both wrote the bridge file and the AI reached only
// the newest. A second launch hands its file to the first one and quits. The lock is per profile
// folder, so e2e runs with their own --user-data-dir stay separate.
const launchRequest: LaunchRequest = launchFile ? { open: resolve(launchFile) } : {};
if (!app.requestSingleInstanceLock({ ...launchRequest })) {
  app.quit();
} else {
  /** macOS file opened before the app was ready (Finder "Open with", Dock drop). */
  let pendingOpen: string | undefined;
  let ready = false;
  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (ready) openInApp(path);
    else pendingOpen = path;
  });
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    const path =
      (isLaunchRequest(additionalData) ? additionalData.open : undefined) ??
      modelPathFromArgs(argv.slice(1), workingDirectory);
    openInApp(path);
  });

  void app.whenReady().then(() => {
    // Unpackaged (dev) runs would show Electron's own Dock icon.
    if (!app.isPackaged) app.dock?.setIcon(APP_ICON);
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        appMenuTemplate({
          platform: process.platform,
          dev: !app.isPackaged,
          onAbout: showAbout,
          onCommand: sendMenuCommand,
        }),
      ),
    );
    void startAppBridge();
    ready = true;
    createWindow(pendingOpen ?? launchFile);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
