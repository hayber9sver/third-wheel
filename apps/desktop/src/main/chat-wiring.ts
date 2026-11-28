/**
 * Chat wiring: the bridge methods the MCP chat tools call (`chat_hello`, `chat_wait`, `chat_send`,
 * `chat_progress`, `chat_history`, `chat_summary`), the IPC the chat panel uses, and an optional JSON-lines debug log
 * (`THIRD_WHEEL_CHAT_LOG` = file path; off by default — it records timings and sizes, no text).
 * `THIRD_WHEEL_CHAT_WAIT_SEC` sets the agent's wait (tests, measurements); `THIRD_WHEEL_CHAT_GRACE_SEC`
 * the grace before "not listening" (e2e); `THIRD_WHEEL_CHAT_LEAVE_SEC` how long "not listening"
 * lasts before the "stopped listening" line (e2e).
 */
import { appendFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { MAX_CHAT_WAIT_SECONDS } from '@third-wheel/core';
import { BrowserWindow, ipcMain } from 'electron';
import type { ChatEntry, ChatEvent, ChatListItem, ChatPage, ChatView } from '../shared/chat.js';
import { IPC } from '../shared/ipc.js';
import { BridgeMethodError, type BridgeHandler } from './bridge.js';
import { ChatSession } from './chat-session.js';
import { ProjectChatStore, type ChatProjectAccess } from './chat-store.js';

function startWait(text: string | undefined): number | undefined {
  const n = Number(text);
  return text !== undefined && n >= 1 && n <= MAX_CHAT_WAIT_SECONDS ? n : undefined;
}

function push(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send(IPC.chatEvent, event);
}

const logPath = process.env['THIRD_WHEEL_CHAT_LOG'];
function writeLog(entry: object): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('chat log:', err);
  }
}

const waitSec = startWait(process.env['THIRD_WHEEL_CHAT_WAIT_SEC']);
const graceSec = startWait(process.env['THIRD_WHEEL_CHAT_GRACE_SEC']);
const leaveAfterSec = startWait(process.env['THIRD_WHEEL_CHAT_LEAVE_SEC']);
/** The project session, once main made it (`useChatProject`). */
let project: ChatProjectAccess | undefined;
function access(): ChatProjectAccess {
  if (!project) throw new Error('No project session for the chat');
  return project;
}
const lazyProject: ChatProjectAccess = {
  chatIndex: (folder) => access().chatIndex(folder),
  chatLines: (folder, id) => access().chatLines(folder, id),
  appendChatLines: (folder, id, lines, title, summary) =>
    access().appendChatLines(folder, id, lines, title, summary),
  chatFacts: (folder, since, chatId) => access().chatFacts(folder, since, chatId),
  versionPlace: (folder, file) => access().versionPlace(folder, file),
  partLink: (folder, part) => access().partLink(folder, part),
};

let errorShown = false;
const chat = new ChatSession({
  ...(waitSec === undefined ? {} : { waitSec }),
  ...(graceSec === undefined ? {} : { graceSec }),
  ...(leaveAfterSec === undefined ? {} : { leaveAfterSec }),
  log: writeLog,
  emit: push,
  store: new ProjectChatStore(lazyProject),
  onError: (err) => {
    console.error('chat:', err);
    if (errorShown) return;
    errorShown = true;
    const text = `Couldn't save the Agent tab's messages: ${err instanceof Error ? err.message : String(err)}`;
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC.projectNotice, text);
  },
});

/** Chats are saved in the shown project (main's `ProjectSession`). */
export function useChatProject(p: ChatProjectAccess): void {
  project = p;
}

/** The shown project changed (undefined: none): its current chat is shown. */
export function chatProjectShown(folder: string | undefined): void {
  void chat.projectShown(folder);
}

/** The window reloaded or closed: no model is on screen (messages stop naming the old one). */
export function chatModelHidden(): void {
  chat.modelHidden();
}

/**
 * The hello's folder as its real path (the project folder is one): "started in another folder"
 * must not fire for /tmp vs /private/tmp or a symlinked folder. Stored again once resolved.
 */
async function helloRealFolder(params: unknown): Promise<{ ok: true }> {
  const p = params as { folder?: unknown };
  if (typeof p.folder !== 'string') return { ok: true };
  try {
    const real = await realpath(p.folder);
    // Only while this start is still the latest: a newer hello must not be overwritten.
    const latest = chat.view().status.started?.connection;
    if (real !== p.folder && latest === (params as { connection?: unknown }).connection)
      chat.hello({ ...(params as object), folder: real });
  } catch {
    // Gone or unreadable: the folder as sent.
  }
  return { ok: true };
}

/** Bad params are the agent's mistake: say so with `bad_request`. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    throw new BridgeMethodError('bad_request', err instanceof Error ? err.message : String(err));
  }
}

/** After a project switch in progress: the line lands in the chat of the project now shown. */
async function afterSwitch<T>(run: () => T): Promise<T> {
  await chat.ready;
  return checked(run);
}

export const chatHandlers: Readonly<Record<string, BridgeHandler>> = {
  chat_hello: async (params) => {
    checked(() => chat.hello(params));
    return helloRealFolder(params);
  },
  chat_wait: (params, context) => checked(() => chat.wait(params, context.signal)),
  chat_send: (params) => afterSwitch(() => chat.agentSend(params)),
  chat_progress: (params) => afterSwitch(() => chat.agentProgress(params)),
  chat_history: async (params) => {
    try {
      return await chat.history(params);
    } catch (err) {
      throw new BridgeMethodError('bad_request', err instanceof Error ? err.message : String(err));
    }
  },
  chat_summary: (params) => afterSwitch(() => chat.agentSummary(params)),
};

ipcMain.handle(IPC.chatSend, async (_event, text: unknown): Promise<ChatEntry | null> => {
  await chat.ready;
  return chat.userSend(text) ?? null;
});
ipcMain.handle(IPC.chatPost, async (_event, post: unknown): Promise<ChatEntry | null> => {
  await chat.ready;
  return chat.post(post) ?? null;
});
ipcMain.handle(IPC.chatView, async (): Promise<ChatView> => {
  await chat.ready;
  return chat.view();
});
ipcMain.handle(IPC.chatList, (): Promise<ChatListItem[]> => chat.list());
ipcMain.handle(IPC.chatRead, (_event, chatId: unknown, before: unknown): Promise<ChatPage> =>
  chat.read(chatId, before),
);
ipcMain.handle(IPC.chatNew, (): Promise<boolean> => chat.newChat());

/** Any MCP tool call: a sign of life while the chat agent works on a message. */
export function chatToolCall(): void {
  chat.agentToolCall();
}

/** App quits: answer an open wait, stop timers. Settles when the last chat lines are written. */
export function disposeChat(): Promise<unknown> {
  chat.dispose();
  return chat.saved;
}
