/**
 * Shared setup for the Electron e2e tests (`pnpm test:e2e`, which builds first): each spec file starts
 * its own app copy (`test.beforeAll(launchApp)` / `test.afterAll(closeApp)`) on a generated
 * 10×20×30 box in a fresh temp folder, with fake `claude` / `gemini` programs, plus helpers the files share.
 */
import { resolve, join } from 'node:path';
import {
  type ElectronApplication,
  _electron as electron,
  type Page,
  expect,
} from '@playwright/test';

export { expect, test } from '@playwright/test';
import {
  realpathSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { OcctKernel } from 'occt-wasm';
import { mustReadNotes } from './notes.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** What the renderer exposes as `window.__thirdWheelTest` (renderer `wiring/test-hook.ts`, THIRD_WHEEL_TEST=1). */
export interface TestHook {
  viewport: {
    pick(x: number, y: number): { kind: string; id: number; body: number } | undefined;
    projectToCanvas(p: [number, number, number]): { x: number; y: number };
    brushCursorState():
      | { center: number[]; normal: number[]; radius: number; style: string; color: number }
      | undefined;
    paintShownTriangles(): number;
    paintShownPieces(): number;
    fillPreviewTriangles(): number;
    isStroking(): boolean;
    markerEntityStats(): { tris: number; lines: number; bodyLines: number; dots: number };
    commentFocusStats(): { items: number; markers: number; faded: number };
    dimensionStats(): { label: string; shown: boolean }[];
    pinStats(): {
      id: string;
      number: number;
      focused: boolean;
      behind: boolean;
      x: number;
      y: number;
    }[];
  };
  comments: { list(): { id: string; text: string; markerIds: string[]; status: string }[] };
  paint():
    | { count(markerId: string): number; paintedArea(markerId: string): number; splitCount: number }
    | undefined;
  markers: {
    active(): { id: string } | undefined;
    list(): { id: string; entities: { kind: string; id: number }[] }[];
    add(entities: { kind: string; id: number }[], name?: string): { id: string };
    setActive(id: string): void;
    remove(id: string): boolean;
  };
  history: { canUndo(): boolean; canRedo(): boolean };
  reopen(saveFirst?: boolean): Promise<void>;
  flush(): Promise<void>;
  notice(): string | undefined;
  alert(): string | undefined;
  brushRadius(): number;
  fillAngle(): number;
  selection: {
    list(): { kind: string; id: number }[];
    addAll(items: { kind: string; id: number }[]): void;
    clear(): void;
  };
  model():
    | {
        positions: Float32Array;
        indices: Uint32Array;
        triangleFace: Uint32Array;
        edgePoints: Float32Array;
        edgeRanges: Uint32Array;
        vertexPositions: Float32Array;
        faceGeometry: Float32Array;
        edgeGeometry: Float32Array;
        edgeTypes: string[];
        edgeChain: Uint32Array;
      }
    | undefined;
  /** The shown model is drawn and its load finished. */
  loaded(): boolean;
  /** Shortens the chat's permission hint delay (ms). */
  chatHintMs(ms: number): void;
}

export type HookWindow = Window & { __thirdWheelTest?: TestHook };

export const appDir = resolve(import.meta.dirname, '..');

export let dir: string;

/** THIRD_WHEEL_E2E_SCALE=1.75 fakes Windows display scaling (175 %) on any machine. */
const e2eScale = process.env['THIRD_WHEEL_E2E_SCALE'];

export const scaleArgs = e2eScale ? [`--force-device-scale-factor=${e2eScale}`] : [];

export let app: ElectronApplication;

/** Own bridge file: a Third Wheel the developer has open keeps its own. */
export let bridgeFile: string;

/** Fake `claude` program (one-click Connect) and the file it logs its calls to. */
export let fakeClaude: string;

export let claudeLog: string;

/** A fake `gemini` / `copilot` and their call logs; a folder in place of `~/.codex`. */
export let fakeGemini: string;

export let geminiLog: string;

export let fakeCopilot: string;

export let copilotLog: string;

/** A program that only writes its arguments into `log`. */
function fakeProgram(name: string, log: string): string {
  if (process.platform === 'win32') {
    const file = join(dir, `${name}.cmd`);
    writeFileSync(file, `@echo %*>> "${log}"\r\n@exit /b 0\r\n`);
    return file;
  }
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
  return file;
}

let claudeConfigDir: string;

export let codexHome: string;

/** Kills this spec file's app copy if the test process exits first (one per launch). */
let killOnExit = (): void => undefined;

/** Starts this spec file's app copy on the box (`test.beforeAll(launchApp)` in each spec file). */
export async function launchApp(): Promise<void> {
  // Real path (macOS /var → /private/var): the app names opened models by their real path.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'third-wheel-e2e-')));
  const kernel = await OcctKernel.init();
  bridgeFile = join(dir, 'bridge.json');
  const boxPath = join(dir, 'box.step');
  writeFileSync(boxPath, kernel.exportStep(kernel.makeBox(10, 20, 30)));
  // A second part for the multi-model review.
  writeFileSync(join(dir, 'lid.step'), kernel.exportStep(kernel.makeBox(10, 20, 5)));
  // The same box as a mesh.
  writeFileSync(join(dir, 'box.stl'), kernel.exportStl(kernel.makeBox(10, 20, 30), 0.1));

  // A fake `claude` for the one-click Connect: logs "<folder> | <arguments>", one call per
  // line, and keeps a Third Wheel entry in $CLAUDE_CONFIG_DIR/.claude.json like Claude Code 2.1
  // (local = under the folder, user = top level; `add` refuses an existing one).
  claudeLog = join(dir, 'claude-calls.log');
  claudeConfigDir = join(dir, 'claude-config');
  mkdirSync(claudeConfigDir);
  const fakeClaudeJs = join(dir, 'fake-claude.cjs');
  writeFileSync(
    fakeClaudeJs,
    `const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(claudeLog)}, process.cwd() + ' | ' + args.join(' ') + '\\n');
let c = {}; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const si = Math.max(args.indexOf('-s'), args.indexOf('--scope'));
const scope = si >= 0 ? args[si + 1] : 'local';
c.projects ??= {}; c.projects[process.cwd()] ??= {};
const servers = scope === 'user' ? (c.mcpServers ??= {}) : (c.projects[process.cwd()].mcpServers ??= {});
if (args[1] === 'remove') delete servers['third-wheel'];
if (args[1] === 'add') {
  if (servers['third-wheel']) { console.error('already exists'); process.exit(1); }
  const dash = args.indexOf('--');
  servers['third-wheel'] = { command: args[dash + 1], args: args.slice(dash + 2) };
}
fs.writeFileSync(file, JSON.stringify(c));
`,
  );
  if (process.platform === 'win32') {
    fakeClaude = join(dir, 'claude.cmd');
    writeFileSync(fakeClaude, `@node "${fakeClaudeJs}" %*\r\n`);
  } else {
    fakeClaude = join(dir, 'claude');
    writeFileSync(fakeClaude, `#!/bin/sh\nexec node '${fakeClaudeJs}' "$@"\n`, { mode: 0o755 });
  }
  geminiLog = join(dir, 'gemini-calls.log');
  fakeGemini = fakeProgram('gemini', geminiLog);
  copilotLog = join(dir, 'copilot-calls.log');
  fakeCopilot = fakeProgram('copilot', copilotLog);
  codexHome = join(dir, 'codex-home');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env['ELECTRON_RUN_AS_NODE']; // set when started from some editors; Electron must run as an app
  delete env['ELECTRON_RENDERER_URL']; // use the built renderer, not a dev server
  app = await electron.launch({
    // Own profile: the app's saved settings (e.g. the selection filter) must not leak in or out.
    args: [appDir, `--user-data-dir=${join(dir, 'profile')}`, ...scaleArgs],
    env: {
      ...env,
      THIRD_WHEEL_OPEN: boxPath,
      THIRD_WHEEL_TEST: '1',
      THIRD_WHEEL_BRIDGE_FILE: bridgeFile,
      THIRD_WHEEL_CLAUDE: fakeClaude,
      THIRD_WHEEL_GEMINI: fakeGemini,
      THIRD_WHEEL_COPILOT: fakeCopilot,
      // The Connect pop-up hides agents nobody tried with the real program; e2e checks them all.
      THIRD_WHEEL_SHOW_UNTESTED: '1',
      THIRD_WHEEL_CODEX_SETTINGS: join(codexHome, 'config.toml'),
      THIRD_WHEEL_GEMINI_SETTINGS: join(dir, 'gemini-settings.json'),
      THIRD_WHEEL_COPILOT_SETTINGS: join(dir, 'copilot-mcp-config.json'),
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      // Chat: short waits so the scripted agent walks every state in seconds.
      THIRD_WHEEL_CHAT_WAIT_SEC: '2',
      THIRD_WHEEL_CHAT_GRACE_SEC: '2',
      THIRD_WHEEL_CHAT_LEAVE_SEC: '2',
    },
  });
  // A worker that crashes never runs afterAll: its app copy would stay open. Close it on exit.
  const child = app.process();
  killOnExit = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once('exit', killOnExit);
  // After a failed test Playwright starts a fresh worker (and app): the next test must not
  // start while the window is still loading or the box isn't open yet (Windows).
  await loadedWindow();
}

/**
 * Open the file the stubbed Open dialog returns, the way a double-click does (its folder's
 * project). The File menu has no "open a file" item since projects (Open folder… / Add file…).
 */
export async function openStubbed(): Promise<void> {
  await app.evaluate(async ({ app: a, dialog }) => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'] });
    const p = r.filePaths[0];
    if (!r.canceled && p) a.emit('second-instance', {}, [], '', { open: p });
  });
}

/**
 * Cmd/Ctrl+I once no question is open (an open question swallows keys on purpose). A question
 * just closed must not: its button can keep focus until the next frame ("Projects: New project
 * folder…" lost the key in full runs).
 */
export async function pressAddModel(page: Page): Promise<void> {
  await expect(page.locator('#choice-dialog[open]')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+i');
}

/**
 * File ▸ Add file… (Cmd/Ctrl+I, or the toolbar's Add file with `via: 'button'`) with the stubbed
 * file, answered "New version of …" (and "Add as new version" when the names differ).
 */
export async function addAsVersion(page: Page, via: 'key' | 'button' = 'key'): Promise<void> {
  if (via === 'button') await page.locator('#add-file').click();
  else await pressAddModel(page);
  // The title of an earlier, closed question may still read "Add …": wait for an open one.
  await expect(page.locator('#choice-dialog[open] #choice-title')).toHaveText(/^Add /, {
    timeout: 30_000,
  });
  await page.locator('#choice-first').click();
  await page.waitForTimeout(200);
  const title = page.locator('#choice-dialog[open] #choice-title');
  if ((await title.count()) > 0 && (await title.innerText()) === 'Add as a new version?')
    await page.locator('#choice-first').click();
}

/**
 * The app's window once the box opened on start (`THIRD_WHEEL_OPEN`) is shown. Waits for `loaded()`,
 * not `model()`: that is set before the notes are read and the model is drawn, so a test could
 * pick an empty view.
 */
export async function loadedWindow(): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.loaded() === true, {
    timeout: 60_000,
  });
  return page;
}

/** Quits the app copy and removes its temp folder (`test.afterAll(closeApp)`). */
export async function closeApp(): Promise<void> {
  process.off('exit', killOnExit);
  await app.close();
  expect(existsSync(bridgeFile), 'the app removes its bridge file on quit').toBe(false);
  rmSync(dir, { recursive: true, force: true });
}

/** File ▸ Reload from disk (the app menu item; the window reads the shown file again). */
export async function reloadFromDisk(): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('menu-reload-from-disk');
    if (!item) throw new Error('no menu item menu-reload-from-disk');
    (item.click as (this: typeof item) => void).call(item);
  });
}

/** A folder of copied revision files and helpers for the version tests. */
export async function versionFolder(name: string) {
  const page = await app.firstWindow();
  const revisions = resolve(appDir, '../../packages/geometry/test-data/revisions');
  const folder = join(dir, name);
  mkdirSync(folder);
  const pick = (file: string) =>
    app.evaluate(
      ({ dialog }, p) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
      },
      join(folder, file),
    );
  const loadedName = (file: string) =>
    expect(page.locator('#model-info')).toHaveText(
      new RegExp(`^${file.replace(/[.()]/g, '\\$&')} · `),
      { timeout: 60_000 },
    );
  type Notes = {
    versions?: { earlier?: { name: string }[]; newer?: { name: string }[] };
    comments?: { text: string }[];
  };
  const notes = (file: string): Notes => mustReadNotes(join(folder, file)) as unknown as Notes;
  const flush = () => page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  const question = page.locator('#version-dialog');
  /** Open… a file; a "new version of …?" question is answered "separate part". */
  const open = async (file: string) => {
    await pick(file);
    await openStubbed();
    await expect
      .poll(
        async () =>
          (await question.isVisible()) ||
          new RegExp(`^${file.replace(/[.()]/g, '\\$&')} · `).test(
            await page.locator('#model-info').innerText(),
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    if (await question.isVisible()) await page.locator('#version-separate').click();
    await loadedName(file);
    await flush();
  };
  /** Add file… → New version onto the shown file. */
  const importNew = async (file: string) => {
    await pick(file);
    await addAsVersion(page);
    await loadedName(file);
    await flush();
  };
  const comment = (text: string) =>
    page.evaluate((t) => {
      const h = (window as HookWindow).__thirdWheelTest as unknown as {
        markers: { add(e: { kind: string; id: number }[]): { id: string } };
        comments: { add(text: string, ids: string[]): unknown };
      };
      h.comments.add(t, [h.markers.add([{ kind: 'face', id: 0 }]).id]);
    }, text);
  const copy = (from: string, to: string): void => {
    copyFileSync(join(revisions, from), join(folder, to));
  };
  return { page, folder, pick, loadedName, notes, flush, open, importNew, comment, copy };
}

/** One wait_for_message from a new connection, then it closes; waits for its leave line. */
export async function listenOnce(cwd: string, page: Page): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const agent = new Client({ name: 'claude-code', version: '1' });
  await agent.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js')],
      cwd,
      env: { ...env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
      stderr: 'ignore',
    }),
  );
  try {
    await agent.callTool({ name: 'wait_for_message', arguments: {} });
  } finally {
    await agent.close();
  }
  await expect(page.locator('#chat-compose')).toBeVisible();
  await expect(page.locator('#chat-log .chat-event').last()).toHaveText(
    /^Claude Code stopped listening/,
    { timeout: 15_000 },
  );
}
