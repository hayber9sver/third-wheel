/**
 * AI status for the status bar, and the Connect pop-up's IPC (agent setup files, find / connect).
 */
import {
  type AiActivity,
  toolOfMethod,
  type McpSetup,
  MCP_RUN_AS_NODE,
  type ConnectTarget,
  type ConnectPlan,
  type ConnectResult,
} from '../../shared/ai-status.js';
import { BrowserWindow, ipcMain, app, dialog, shell } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { BridgeHandler } from '../bridge.js';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AGENT_PROBLEMS, agentById } from '../../shared/agent-list.js';
import type { AgentDesc } from '../../shared/agent-desc.js';
import {
  type Overrides,
  planCommand,
  findProgram,
  settingsFile,
  connectCommand,
  connectSettings,
} from '../agent-cli.js';
import { installUrl } from '../../shared/agents.js';
import type { AllowPlan, AllowResult } from '../../shared/chat-setup.js';
import type { RemoveResult } from '../../shared/claude-setup.js';
import { planAllow, removeEntry, writeAllow } from '../agent-fix.js';

// --- AI status: bridge state + last MCP tool call, for the status-bar item -------------
// One bridge connection per tool call: the app can only know the last call, never "connected".
let aiActivity: AiActivity = { bridge: 'starting' };
export function setAiActivity(next: AiActivity): void {
  aiActivity = next;
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send(IPC.aiActivity, aiActivity);
}
/**
 * Wrap the bridge handlers so every MCP tool call is recorded (ping / status are not tools);
 * `onCall` runs at the start and end of each.
 */
export function recordingCalls(
  handlers: Readonly<Record<string, BridgeHandler>>,
  onCall?: () => void,
): Record<string, BridgeHandler> {
  const out: Record<string, BridgeHandler> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    const tool = toolOfMethod(method);
    out[method] = tool
      ? async (params, context) => {
          const record = (): void => {
            setAiActivity({ ...aiActivity, lastCall: { tool, at: Date.now() } });
            onCall?.();
          };
          record();
          // Also when it ends: a long wait_for_review must not turn the dot grey mid-wait.
          try {
            return await handler(params, context);
          } finally {
            record();
          }
        }
      : handler;
  }
  return out;
}
ipcMain.handle(IPC.getAiActivity, (): AiActivity => aiActivity);

/** The MCP server file: inside the app's resources when packaged (installers must ship it), else the repo build. */
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
    // Packaged: the app's own Electron runs the server as Node, so users need no Node.
    command: app.isPackaged ? exe : 'node',
    env: app.isPackaged ? MCP_RUN_AS_NODE : {},
    temporaryLocation:
      app.isPackaged &&
      process.platform === 'darwin' &&
      (exe.startsWith('/Volumes/') || exe.includes('/AppTranslocation/')),
  };
}
ipcMain.handle(IPC.getMcpSetup, (): McpSetup => mcpSetup());
/** Test hooks (not in packaged builds). */
const testOverride = (name: string): string | undefined =>
  app.isPackaged ? undefined : process.env[name];
/** Dev / e2e: THIRD_WHEEL_SHOW_UNTESTED=1 also shows agents nobody tried with the real program. */
export const showUntestedAgents =
  !app.isPackaged && process.env['THIRD_WHEEL_SHOW_UNTESTED'] === '1';
// CI fails on these; a packaged app just leaves that tab out.
for (const problem of AGENT_PROBLEMS) console.warn(`Agent description left out: ${problem}`);
/**
 * Dev / e2e only: an agent's program (`THIRD_WHEEL_CLAUDE`, empty = not installed) and settings
 * file (`THIRD_WHEEL_CODEX_SETTINGS`) instead of the real ones.
 */
function overridesOf(agent: AgentDesc): Overrides {
  const id = agent.id.toUpperCase().replaceAll('-', '_');
  return {
    program: testOverride(`THIRD_WHEEL_${id}`),
    file: testOverride(`THIRD_WHEEL_${id}_SETTINGS`),
  };
}
/** The agent the renderer asked for: a known one, and tested unless untested ones are shown. */
function askedAgent(id: unknown): AgentDesc | undefined {
  const agent = agentById(id);
  return agent && (agent.tested !== null || showUntestedAgents) ? agent : undefined;
}
/** The renderer's `ConnectTarget`, checked; main checks the folder itself. */
function connectTarget(v: unknown): ConnectTarget {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const text = (x: unknown): string | undefined =>
    typeof x === 'string' && x.length > 0 && x.length < 4096 ? x : undefined;
  return {
    scope: o['scope'] === 'user' ? 'user' : 'folder',
    folder: text(o['folder']),
    projectFolder: text(o['projectFolder']),
    modelPath: text(o['modelPath']),
    program: text(o['program']),
    replace: o['replace'] === true,
  };
}
ipcMain.handle(
  IPC.planConnect,
  async (_e, id: unknown, target: unknown, useShell: unknown): Promise<ConnectPlan> => {
    const agent = askedAgent(id);
    if (agent?.engine !== 'command') return { program: null, steps: [], blocked: 'Unknown agent.' };
    return planCommand(
      agent,
      mcpSetup(),
      connectTarget(target),
      overridesOf(agent),
      useShell === true,
    );
  },
);
ipcMain.handle(IPC.chooseFolder, async (event, startIn: unknown): Promise<string | null> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: 'Folder you start Claude Code in',
    properties: ['openDirectory', 'createDirectory'],
    ...(typeof startIn === 'string' && startIn.length < 4096 ? { defaultPath: startIn } : {}),
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle(IPC.findAgent, async (_e, id: unknown): Promise<string | null> => {
  const agent = askedAgent(id);
  if (agent?.engine === 'command') return (await findProgram(agent, overridesOf(agent))) ?? null;
  if (agent?.engine === 'settings' && agent.settings)
    return settingsFile(agent.settings, overridesOf(agent).file);
  return null;
});
ipcMain.handle(
  IPC.connectAgent,
  async (_e, id: unknown, target: unknown): Promise<ConnectResult> => {
    const setup = mcpSetup();
    const agent = askedAgent(id);
    if (agent?.engine === 'command')
      return connectCommand(agent, setup, connectTarget(target), overridesOf(agent));
    if (agent?.engine === 'settings') return connectSettings(agent, setup, overridesOf(agent));
    if (agent?.engine !== 'link' || !agent.link) return { ok: false, reason: 'failed' };
    if (setup.temporaryLocation) return { ok: false, reason: 'temporary-location' };
    // Built here from the built-in description, not taken from the page: the renderer can't make
    // main open any other link.
    const url = installUrl(agent.link, setup);
    try {
      await shell.openExternal(url);
      return { ok: true, path: url };
    } catch {
      return { ok: false, reason: 'not-found' }; // no app handles the link: not installed
    }
  },
);
ipcMain.handle(
  IPC.planAllow,
  async (_e, id: unknown, folder: unknown, cad: unknown): Promise<AllowPlan> => {
    const agent = askedAgent(id);
    return agent
      ? planAllow(agent, folder, cad)
      : { file: '', exists: false, add: [], error: 'Unknown agent.' };
  },
);
ipcMain.handle(
  IPC.writeAllow,
  async (_e, id: unknown, folder: unknown, cad: unknown, shown: unknown): Promise<AllowResult> => {
    const agent = askedAgent(id);
    return agent ? writeAllow(agent, folder, cad, shown) : { ok: false, error: 'Unknown agent.' };
  },
);
ipcMain.handle(
  IPC.removeEntry,
  async (_e, id: unknown, target: unknown, which: unknown): Promise<RemoveResult> => {
    const agent = askedAgent(id);
    const w = typeof which === 'object' && which !== null ? (which as Record<string, unknown>) : {};
    const where = w['where'];
    const file = w['file'];
    if (
      agent?.engine !== 'command' ||
      (where !== 'local' && where !== 'project' && where !== 'user') ||
      typeof file !== 'string'
    )
      return { ok: false, detail: 'Unknown entry.' };
    return removeEntry(
      agent,
      mcpSetup(),
      connectTarget(target),
      { where, file },
      overridesOf(agent),
    );
  },
);
