/**
 * The app window: size and placement, icon, test-mode flags, `createWindow`.
 */
import { BrowserWindow, screen, app, nativeTheme, shell } from 'electron';
import { fitAfterMove, fitBounds } from '../../shared/window-fit.js';
import { join } from 'node:path';
import { APP_DISPLAY_NAME } from '../../shared/app-name.js';
import { chatModelHidden, chatProjectShown } from '../chat-wiring.js';
import { perfModeFromEnv } from '../../shared/ipc.js';
import { dropWindowRequests, projects, sendModelFile, showUntestedAgents } from '../index.js';

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
 * PNG elsewhere. Packaged builds get theirs from the installer config.
 */
export const APP_ICON = join(
  import.meta.dirname,
  '../../resources',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png',
);

/**
 * e2e runs (unpackaged, THIRD_WHEEL_TEST=1) stay out of the user's way: the window shows without
 * activating, fully transparent and click-through (macOS puts even an inactive new window on top),
 * the app keeps out of the Dock (macOS), and nothing brings it to the front (opening a file,
 * `load_model`, menu items). Keys and clicks reach it through Playwright, not the OS; it keeps
 * drawing (no background throttling). THIRD_WHEEL_E2E_VISIBLE=1 shows it to watch a run.
 */
export const quietTest = !app.isPackaged && process.env['THIRD_WHEEL_TEST'] === '1';
const hiddenTest = quietTest && process.env['THIRD_WHEEL_E2E_VISIBLE'] !== '1';
if (quietTest && process.platform === 'darwin') app.setActivationPolicy('accessory');
if (hiddenTest) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}
if (quietTest) {
  // A hidden test app must never outlive its test run: when the runner that started it is gone
  // (killed hard, so it couldn't close the app), quit.
  const runner = process.ppid;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  setInterval(() => {
    if (process.ppid !== runner || !alive(runner)) app.exit(0);
  }, 2000).unref();
}

export function createWindow(openOnStart?: string): BrowserWindow {
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
      ...(hiddenTest ? { backgroundThrottling: false } : {}),
    },
  });

  win.once('ready-to-show', () => {
    if (hiddenTest) {
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
    }
    if (quietTest) win.showInactive();
    else win.show();
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
    chatModelHidden();
  });
  win.webContents.on('render-process-gone', () => {
    dropWindowRequests(contentsId);
  });
  win.on('closed', () => {
    dropWindowRequests(contentsId);
    void projects.close(); // macOS keeps the app running: the project's lock goes with the window
    chatProjectShown(undefined);
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
  if (showUntestedAgents) query['agents'] = 'all';
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
