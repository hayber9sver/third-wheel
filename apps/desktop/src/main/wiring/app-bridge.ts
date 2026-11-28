/**
 * App bridge: the MCP server talks to the app over a localhost WebSocket; requests the window
 * answers.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { BridgeMethodError, type Bridge } from '../bridge.js';
import { APP_DISPLAY_NAME } from '../../shared/app-name.js';
import {
  type BridgeRendererRequest,
  IPC,
  type LoadRequest,
  type BridgeRendererReply,
} from '../../shared/ipc.js';
import { parseParams, loadParamsSchema, LOADABLE_EXTENSIONS } from '@third-wheel/core';
import { isAbsolute, extname, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { openModelFile, projects, quietTest } from '../index.js';

// --- App bridge: the MCP server talks to the app over a localhost WebSocket ----------

/** How long the window may take to answer a bridge request. */
export const WINDOW_ANSWER_MS = 30_000;
/** Opening a model (huge assemblies take minutes) and taking pictures may take longer. */
const WINDOW_LOAD_MS = 10 * 60_000;
export const WINDOW_RENDER_MS = 120_000;
/** Extra time over a `wait_review` long-poll before main gives up on the window. */
export const WAIT_GRACE_MS = 10_000;
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
export function askWindow(
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
    if (bringToFront && !quietTest) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    win.webContents.send(IPC.bridgeRequest, request);
  });
}

/** Checks bridge params in main; a bad one is the caller's fault (`bad_request`). */
export function mainParams<T>(
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
export async function bridgeLoad(params: unknown): Promise<unknown> {
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
  // The AI works inside the project folder: a wrong place or a reused name is refused, unloaded.
  const check = await projects.checkAiLoad(path, file.contentHash, revisionOf !== undefined);
  if (!check.ok) throw new BridgeMethodError('failed', check.message);
  const request: LoadRequest = {
    ...file,
    ...(revisionOf ? { revisionOf } : {}),
    saveNextAs: check.saveNextAs,
  };
  return askWindow('load', request, WINDOW_LOAD_MS, true);
}

/** The window reloaded or crashed: its requests will never be answered. */
export function dropWindowRequests(sender: number): void {
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

export let bridge: Bridge | undefined;
/** Sets `bridge` from another module (an import can't be assigned). */
export function setBridge(value: typeof bridge): void {
  bridge = value;
}
