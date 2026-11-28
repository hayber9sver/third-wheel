/**
 * About and third-party notices, menu commands, starting the bridge, quitting, files handed to the
 * app (double-click, second launch), single instance and start-up.
 */
import { app, ipcMain, BrowserWindow, shell } from 'electron';
import { join, resolve } from 'node:path';
import { NOTICES_FILE_NAME } from '../../shared/about.js';
import { feedbackUrl, isFeedbackPlace, type SystemInfo } from '../../shared/feedback.js';
import { IPC } from '../../shared/ipc.js';
import { readFile } from 'node:fs/promises';
import type { MenuCommand } from '../../shared/menu-commands.js';
import {
  bridgeFileSegments,
  type PingResult,
  BRIDGE_PROTOCOL,
  waitReviewParamsSchema,
  MAX_WAIT_SECONDS,
} from '@third-wheel/core';
import { homedir } from 'node:os';
import { startBridge } from '../bridge.js';
import { chatHandlers, chatToolCall, disposeChat } from '../chat-wiring.js';
import { modelPathFromArgs, type LaunchRequest, isLaunchRequest } from '../launch-file.js';
import { APP_DISPLAY_NAME } from '../../shared/app-name.js';
import {
  APP_ICON,
  askWindow,
  bridge,
  bridgeLoad,
  buildMenu,
  createWindow,
  loadRecent,
  mainParams,
  openModelFile,
  quietTest,
  recordingCalls,
  releaseLockSync,
  setAiActivity,
  setBridge,
  setRecentProjects,
  WAIT_GRACE_MS,
  WINDOW_ANSWER_MS,
  WINDOW_RENDER_MS,
} from '../index.js';

/**
 * Third-party notices: `resources/` in dev; packaged builds ship it next to the app
 * (`process.resourcesPath`, installer config: electron-builder.yml).
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
ipcMain.handle(IPC.getSystemInfo, (): SystemInfo => ({
  platform: process.platform,
  osVersion: process.getSystemVersion(),
  arch: process.arch,
}));
// Help ▸ Send feedback…: only the two fixed addresses open; the page gives only the setup line.
ipcMain.handle(IPC.openFeedback, async (_e, place: unknown, setup: unknown): Promise<boolean> => {
  if (!isFeedbackPlace(place)) return false;
  try {
    await shell.openExternal(feedbackUrl(place, typeof setup === 'string' ? setup : undefined));
    return true;
  } catch {
    return false;
  }
});

/** The window a menu item acts on: the focused (or first) one, brought to the front. */
export function menuWindow(): BrowserWindow | undefined {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return undefined;
  if (quietTest) return win;
  if (win.isMinimized()) win.restore();
  win.focus();
  return win;
}

/** About Third Wheel (menu): show the in-app dialog. */
export function showAbout(): void {
  menuWindow()?.webContents.send(IPC.showAbout);
}

/** File / Undo / Redo / Help menu items: the window carries them out. */
export function sendMenuCommand(command: MenuCommand): void {
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
    const started = await startBridge({
      filePath,
      version,
      handlers: recordingCalls(
        {
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
          ...chatHandlers,
        },
        chatToolCall,
      ),
    });
    setBridge(started);
    setAiActivity({ bridge: 'on' });
    console.info(`App bridge on 127.0.0.1:${String(started.port)} (${filePath})`);
  } catch (err) {
    // The app still works without it; only AI agents can't reach it.
    console.error('App bridge could not start:', err);
    setAiActivity({ bridge: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Quitting waits (up to {@link CHAT_QUIT_WAIT_MS}) for the last chat lines to be written. */
const CHAT_QUIT_WAIT_MS = 3000;
let chatFlushed = false;
app.on('before-quit', (event) => {
  if (chatFlushed) return;
  event.preventDefault();
  chatFlushed = true;
  const timeout = new Promise((resolve) => setTimeout(resolve, CHAT_QUIT_WAIT_MS));
  void Promise.race([disposeChat().catch(() => undefined), timeout]).then(() => {
    app.quit();
  });
});

app.on('will-quit', () => {
  releaseLockSync();
  bridge?.removeFileSync();
});

/** Reads a model file and hands it to the window, as a double-click does. */
export function sendModelFile(win: BrowserWindow, path: string): void {
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
export function openInApp(path?: string): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) {
    createWindow(path);
    return;
  }
  if (!quietTest) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
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

// Display name for menus / About. Electron derives its user-data folder (settings,
// single-instance lock) from the app name, so pin it to the folder used before the rename.
// Packaged builds are named "Third Wheel", which would start in a new, empty folder: pin
// them to the dev folder too (unless a test passes --user-data-dir).
const userDataFolder =
  app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')
    ? join(app.getPath('appData'), '@third-wheel', 'desktop')
    : app.getPath('userData');
app.setName(APP_DISPLAY_NAME);
app.setPath('userData', userDataFolder);

// One app copy at a time: two copies both wrote the bridge file and the AI reached only
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
    if (!app.isPackaged && !quietTest) app.dock?.setIcon(APP_ICON);
    setRecentProjects(loadRecent());
    buildMenu();
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
