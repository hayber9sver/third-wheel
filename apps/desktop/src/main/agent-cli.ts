/**
 * One-click Connect, the engines that run an agent description (`apps/desktop/agents/*.json`):
 * **command** finds the agent's program and runs its add command (`claude mcp add …`), **settings**
 * writes its settings file (Codex's `config.toml`). The **install link** engine is a URL that
 * main opens (`wiring/agent-setup.ts`). A description only fills in these; it can't make them run anything else.
 *
 * Apps started from the Dock / Start menu don't get the terminal's PATH (macOS gives them a bare
 * one), so besides PATH we look in the program's usual install folders, in the copy an editor
 * extension carries, and (macOS / Linux, only when the user clicks "Look again") ask the user's
 * login shell, which runs their shell start-up files.
 *
 * Nothing is written before the user saw it: `planCommand` reads the settings and says what
 * Connect would run; `connectCommand` runs it, replacing an existing entry only when the user
 * agreed.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { isAbsolute } from 'node:path';
import type {
  AgentDesc,
  ApprovalSpec,
  CommandSpec,
  FileSpec,
  McpScope,
} from '../shared/agent-desc.js';
import {
  commandArgs,
  commandText,
  defaultScope,
  keyPath,
  removeArgs,
  removeText,
  settingsWith,
} from '../shared/agents.js';
import {
  MCP_SERVER_NAME,
  type ConnectPlan,
  type ConnectResult,
  type ConnectTarget,
  type McpSetup,
} from '../shared/ai-status.js';
import {
  approvalOf,
  checkSetup,
  entryInJson,
  objectAt,
  entryWhereOf,
  type FoundEntry,
  type RawEntry,
} from '../shared/claude-setup.js';

export interface FindEnv {
  readonly platform: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Folders (under home) where editors keep extensions; the Claude Code extension ships `claude`. */
const EDITOR_EXTENSION_DIRS = [
  ['.vscode', 'extensions'],
  ['.vscode-insiders', 'extensions'],
  ['.cursor', 'extensions'],
  ['.windsurf', 'extensions'],
];

/** `anthropic.claude-code-2.1.322-darwin-arm64` → [2, 1, 322]; newest first when sorted. */
function extensionVersion(folder: string): number[] {
  const m = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(folder);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
}

function newestFirst(a: string, b: string): number {
  const va = extensionVersion(a);
  const vb = extensionVersion(b);
  for (let i = 0; i < 3; i++) if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
  return 0;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

type ProgramSpec = CommandSpec['program'];

/** Where a program may be, most likely first (not checked for existence). */
export function programCandidates(
  spec: ProgramSpec,
  { platform, home, env }: FindEnv,
  list: (dir: string) => string[] = listDir,
): string[] {
  const win = platform === 'win32';
  // The rules of the platform asked about (tests run Windows paths on a Mac).
  const p = win ? path.win32 : path.posix;
  const join = (...parts: string[]): string => p.join(...parts);
  const names = win ? spec.windows : [spec.name];
  const homeDirs = spec.folders.map((f) => f.replace(/^~\//, '').split('/'));
  const out: string[] = [];
  const pathDirs = (env['PATH'] ?? env['Path'] ?? '')
    .split(p.delimiter)
    .filter((d) => d && p.isAbsolute(d));
  for (const dir of pathDirs) for (const n of names) out.push(join(dir, n));
  // Native installer / old local install, Homebrew / npm global.
  if (win) {
    for (const dirs of homeDirs.slice(0, 1)) out.push(join(home, ...dirs, names[0] ?? ''));
    if (env['APPDATA']) out.push(join(env['APPDATA'], 'npm', `${spec.name}.cmd`));
  } else {
    for (const dirs of homeDirs) out.push(join(home, ...dirs, spec.name));
    out.push(`/opt/homebrew/bin/${spec.name}`, `/usr/local/bin/${spec.name}`);
    out.push(join(home, '.npm-global', 'bin', spec.name));
  }
  // The copy inside an editor extension (newest version first).
  const prefix = spec.editorExtension;
  if (prefix)
    for (const parts of EDITOR_EXTENSION_DIRS) {
      const dir = join(home, ...parts);
      const folders = list(dir)
        .filter((f) => f.startsWith(prefix))
        .sort(newestFirst);
      for (const f of folders)
        out.push(join(dir, f, 'resources', 'native-binary', win ? `${spec.name}.exe` : spec.name));
    }
  return [...new Set(out)];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Why an argument can't go through cmd.exe safely: cmd expands `%NAME%` even inside quotes and a
 * `"` would end the quoting; undefined = fine.
 */
export function unsafeForCmd(args: readonly string[]): string | undefined {
  const bad = args.find((a) => /[%"\r\n]/.test(a));
  return bad === undefined
    ? undefined
    : `${bad} has a character (% or ") that Windows' command line can't pass on safely`;
}

/**
 * How `claude` is started: a `.cmd` / `.bat` (npm's shim on Windows) only runs through cmd.exe
 * (Node refuses to spawn it directly), with every argument quoted by us; anything else directly.
 * Throws for an argument cmd.exe can't pass on safely ({@link unsafeForCmd}).
 */
export function commandLine(
  platform: string,
  file: string,
  args: readonly string[],
): { exe: string; argv: string[]; verbatim: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const unsafe = unsafeForCmd([file, ...args]);
    if (unsafe) throw new Error(unsafe);
    const quote = (a: string): string => (/[\s&()^|<>!,;=]/.test(a) ? `"${a}"` : a);
    // `/d`: no AutoRun commands; `/v:off`: `!` stays a letter; `/s`: cmd strips only the outer
    // pair of quotes and keeps the rest of the line as is.
    return {
      exe: 'cmd.exe',
      argv: ['/d', '/v:off', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`],
      verbatim: true,
    };
  }
  return { exe: file, argv: [...args], verbatim: false };
}

export function run(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    // npm tools (gemini) start with `#!/usr/bin/env node`; an app started from the Dock has a
    // bare PATH without node, which usually sits next to the tool (Homebrew, nvm, npm global).
    if (isAbsolute(file)) {
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      env[key] = [path.dirname(file), env[key]].filter(Boolean).join(path.delimiter);
    }
    let line: ReturnType<typeof commandLine>;
    try {
      line = commandLine(process.platform, file, args);
    } catch (e) {
      resolve({ code: 1, out: e instanceof Error ? e.message : String(e) });
      return;
    }
    const { exe, argv, verbatim } = line;
    execFile(
      exe,
      argv,
      {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        ...(cwd === undefined ? {} : { cwd }),
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}`.trim() });
      },
    );
  });
}

/** Ask the login shell (macOS / Linux): picks up PATH set in ~/.zshrc etc. */
async function fromLoginShell(name: string): Promise<string | undefined> {
  const shell = process.env['SHELL'];
  if (!shell || !isAbsolute(shell)) return undefined;
  const { out } = await run(shell, ['-ilc', `command -v ${name}`], 5000);
  // Interactive shells may print other lines first; the answer is the last absolute path.
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => isAbsolute(l));
  return line && isFile(line) ? line : undefined;
}

const found = new Map<string, string>();

/** Test hooks (dev / e2e only, never in a packaged app): `THIRD_WHEEL_<ID>` and `…_SETTINGS`. */
export interface Overrides {
  /** Use this program instead; empty = "not installed". */
  readonly program?: string | undefined;
  /** Use this settings file instead of every `~/` file of the description. */
  readonly file?: string | undefined;
}

/**
 * The agent's program, or undefined when it isn't installed where we look. `useShell`: also ask
 * the login shell (after the user clicked "Look again").
 */
export async function findProgram(
  agent: AgentDesc,
  ov: Overrides = {},
  useShell = false,
): Promise<string | undefined> {
  const spec = agent.command?.program;
  if (!spec) return undefined;
  if (ov.program !== undefined) return ov.program || undefined;
  const known = found.get(spec.name);
  if (known && existsSync(known)) return known;
  const home = homedir(); // not $HOME: Git / MSYS tools on Windows may set it to a non-native path
  let hit = programCandidates(spec, { platform: process.platform, home, env: process.env }).find(
    isFile,
  );
  // Only on the user's click: it runs their shell start-up files.
  if (!hit && useShell && process.platform !== 'win32') hit = await fromLoginShell(spec.name);
  if (hit) found.set(spec.name, hit);
  else found.delete(spec.name);
  return hit;
}

export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined; // missing or not JSON: no entries from it
  }
}

/**
 * A description's `~/…` settings file: under home, or in the folder an absolute `fileEnv`
 * variable names (`$CLAUDE_CONFIG_DIR/.claude.json`, `$CODEX_HOME/config.toml`).
 */
export function settingsFile(spec: FileSpec, override?: string): string {
  if (override) return override;
  const rest = spec.file.replace(/^~\//, '').split('/');
  const dir = spec.fileEnv ? process.env[spec.fileEnv] : undefined;
  return dir && isAbsolute(dir) ? path.join(dir, rest.at(-1) ?? '') : path.join(homedir(), ...rest);
}

/** The folder and the ones above it, nearest first. */
function upwards(folder: string): string[] {
  const out = [folder];
  for (let d = folder; path.dirname(d) !== d;) {
    d = path.dirname(d);
    out.push(d);
  }
  return out;
}

/** The git project's top folder that holds `folder`, if any. */
function gitTop(folder: string): string | undefined {
  return upwards(folder).find((d) => existsSync(path.join(d, '.git')));
}

/** A folder the user may connect: absolute, existing, as its real path; undefined otherwise. */
export async function realFolder(folder: string | undefined): Promise<string | undefined> {
  if (!folder || !isAbsolute(folder)) return undefined;
  try {
    const real = await realpath(folder);
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every Third Wheel entry the agent would see in `folder` (or for all folders, without one), from
 * its description's `command.entries`. A file without `~/` (`.mcp.json`) counts in the folder and
 * the ones above it: the nearest one with an entry.
 */
export async function agentEntries(
  agent: AgentDesc,
  folder: string | undefined,
  ov: Overrides = {},
): Promise<FoundEntry[]> {
  const raw: RawEntry[] = [];
  const projectKey = folder === undefined ? undefined : (gitTop(folder) ?? folder);
  for (const spec of agent.command?.entries ?? []) {
    const key = keyPath(spec.key);
    if (spec.file.startsWith('~/')) {
      const file = settingsFile(spec, ov.file);
      const e = entryInJson(
        await readJson(file),
        key,
        spec.where,
        file,
        projectKey,
        process.platform,
      );
      if (e) raw.push(e);
    } else if (folder !== undefined)
      for (const dir of upwards(folder)) {
        const file = path.join(dir, spec.file);
        if (!existsSync(file)) continue;
        const e = entryInJson(
          await readJson(file),
          key,
          spec.where,
          file,
          projectKey,
          process.platform,
        );
        if (e) {
          raw.push(e);
          break;
        }
      }
  }
  const out: FoundEntry[] = [];
  for (const e of raw) {
    const spec = agent.command?.entries.find((x) => x.where === e.where)?.approval;
    const approval =
      spec && folder !== undefined
        ? approvalOf(
            await approvalObjects(spec, [folder, projectKey, path.dirname(e.file)], projectKey, ov),
            spec,
            MCP_SERVER_NAME,
          )
        : undefined;
    out.push({
      ...e,
      serverExists: e.serverPath !== undefined && isAbsolute(e.serverPath) && isFile(e.serverPath),
      ...(approval === undefined ? {} : { approval }),
    });
  }
  return out;
}

/**
 * The objects that may hold the user's yes / no for a folder's entries (see `ApprovalSpec`): the
 * home files, and the folder files in `dirs` (the folder, its git top, the `.mcp.json`'s folder).
 */
async function approvalObjects(
  spec: ApprovalSpec,
  dirs: readonly (string | undefined)[],
  projectKey: string | undefined,
  ov: Overrides,
): Promise<(Record<string, unknown> | undefined)[]> {
  const out: (Record<string, unknown> | undefined)[] = [];
  const folders = [...new Set(dirs.filter((d): d is string => d !== undefined))];
  for (const f of spec.files) {
    const files = f.file.startsWith('~/')
      ? [settingsFile(f, ov.file)]
      : folders.map((d) => path.join(d, f.file));
    for (const file of files)
      out.push(objectAt(await readJson(file), f.key, projectKey, process.platform));
  }
  return out;
}

/** Where "This folder only" runs: the chosen folder, else the shown project's, else the model's. */
export async function targetFolder(target: ConnectTarget): Promise<string | undefined> {
  return realFolder(
    target.folder ??
      target.projectFolder ??
      (target.modelPath ? path.dirname(target.modelPath) : undefined),
  );
}

function blockedBySetup(setup: McpSetup): string | undefined {
  if (setup.temporaryLocation)
    return 'Move Third Wheel to your Applications folder and open it from there first.';
  if (!setup.exists) return 'The MCP server file is missing (see above).';
  return undefined;
}

/** Shown in the plan: Windows can't run a `.cmd` with these paths safely. */
function blockedByCmd(program: string, args: readonly string[]): string | undefined {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(program)) return undefined;
  const unsafe = unsafeForCmd([program, ...args]);
  return unsafe ? `${unsafe}. Copy the command below and run it in a terminal instead.` : undefined;
}

/** The scope asked for, if the agent offers it; else its only one. */
function scopeOf(cmd: CommandSpec, target: ConnectTarget): McpScope {
  return cmd.scopes[target.scope] ? target.scope : defaultScope(cmd);
}

/**
 * What one-click Connect would do for a command agent: the program, the folder, the commands
 * and the existing entry it would replace. Reads files only; runs nothing (besides the login shell
 * when `useShell`).
 */
export async function planCommand(
  agent: AgentDesc,
  setup: McpSetup,
  target: ConnectTarget,
  ov: Overrides = {},
  useShell = false,
): Promise<ConnectPlan> {
  const cmd = agent.command;
  if (!cmd) return { program: null, steps: [], blocked: 'This agent has no command to run.' };
  const scope = scopeOf(cmd, target);
  const program = (await findProgram(agent, ov, useShell)) ?? null;
  const folder = scope === 'folder' ? await targetFolder(target) : undefined;
  const checkFolder = folder ?? (await targetFolder({ ...target, folder: undefined }));
  const entries = await agentEntries(agent, checkFolder, ov);
  const where = entryWhereOf(agent, scope);
  const replace = entries.find((e) => e.where === where);
  const steps = [...(replace ? [removeText(cmd, where)] : []), commandText(cmd, setup, scope)];
  const blocked =
    blockedBySetup(setup) ??
    (scope === 'folder' && !folder
      ? `Choose the folder you start ${agent.label} in.`
      : program
        ? blockedByCmd(program, commandArgs(cmd, setup, scope))
        : undefined);
  return {
    program,
    ...(folder === undefined ? {} : { folder }),
    ...(blocked === undefined ? {} : { blocked }),
    steps,
    ...(replace ? { replace } : {}),
    ...(cmd.check ? { check: checkSetup(agent, entries, setup, checkFolder) } : {}),
  };
}

/**
 * Add the MCP server where the user chose: "This folder only" runs the add command in that
 * folder, "All my folders" with the scope's arguments. An entry of the same scope is removed first
 * only when the user agreed (`target.replace`); otherwise `exists` sends them back to the plan.
 */
export async function connectCommand(
  agent: AgentDesc,
  setup: McpSetup,
  target: ConnectTarget,
  ov: Overrides = {},
): Promise<ConnectResult> {
  const cmd = agent.command;
  if (!cmd) return { ok: false, reason: 'failed' };
  if (setup.temporaryLocation) return { ok: false, reason: 'temporary-location' };
  const program = await findProgram(agent, ov);
  if (!program) return { ok: false, reason: 'not-found' };
  if (target.program !== undefined && target.program !== program)
    return { ok: false, reason: 'changed' };
  const scope = scopeOf(cmd, target);
  const folder = scope === 'folder' ? await targetFolder(target) : undefined;
  if (scope === 'folder' && !folder)
    return { ok: false, reason: 'failed', detail: 'the folder doesn’t exist (any more)' };
  const where = entryWhereOf(agent, scope);
  const existing = (await agentEntries(agent, folder, ov)).find((e) => e.where === where);
  if (existing && !target.replace) return { ok: false, reason: 'exists' };
  const cwd = folder ?? homedir();
  const timeout = cmd.timeoutSec * 1000;
  if (existing) {
    const removed = await run(program, removeArgs(cmd, where), timeout, cwd);
    if (removed.code !== 0)
      return { ok: false, reason: 'failed', detail: removed.out.slice(0, 500) };
  }
  const { code, out } = await run(program, commandArgs(cmd, setup, scope), timeout, cwd);
  if (code !== 0) return { ok: false, reason: 'failed', detail: out.slice(0, 500) };
  if (!cmd.check) return { ok: true, path: program };
  const checkFolder = folder ?? (await targetFolder({ ...target, folder: undefined }));
  const check = checkSetup(agent, await agentEntries(agent, checkFolder, ov), setup, checkFolder);
  return { ok: true, path: program, check };
}

/**
 * Write a settings file the safe way: the file before is kept as `.bak` (`existed`); written next
 * to it and swapped in, so a crash never leaves half a file; a symlinked file (dotfiles) stays a
 * link (written where it points). Makes the folder when needed.
 */
export async function writeWithBackup(file: string, text: string, existed: boolean): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  if (existed) await copyFile(file, `${file}.bak`);
  const target = existed ? await realpath(file) : file;
  const tmp = `${target}.thirdwheel-tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, target);
}

/**
 * Write the Third Wheel entry into a settings-file agent's file (Codex's `config.toml`, with the
 * `tool_timeout_sec` its own `mcp add` can't set). An older entry is replaced; the file before is
 * kept as `.bak`; written next to it and swapped in, so a crash never leaves half a file.
 */
export async function connectSettings(
  agent: AgentDesc,
  setup: McpSetup,
  ov: Overrides = {},
): Promise<ConnectResult> {
  const spec = agent.settings;
  if (!spec) return { ok: false, reason: 'failed' };
  if (setup.temporaryLocation) return { ok: false, reason: 'temporary-location' };
  const file = settingsFile(spec, ov.file);
  try {
    let existing = '';
    try {
      existing = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const next = settingsWith(spec, setup, existing);
    if (next === undefined)
      return {
        ok: false,
        reason: 'failed',
        detail:
          spec.format === 'toml'
            ? `${file} has a layout the app doesn't change safely (multi-line text or an old Third Wheel entry over several lines); nothing was written`
            : `${file} isn't JSON the app can change safely; nothing was written`,
      };
    await writeWithBackup(file, next, existing !== '');
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
