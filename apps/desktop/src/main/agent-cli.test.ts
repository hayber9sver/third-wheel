import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDesc } from '../shared/agent-desc.js';
import { agentById } from '../shared/agent-list.js';
import { commandArgs, settingsText } from '../shared/agents.js';
import {
  MCP_RUN_AS_NODE,
  type ConnectTarget,
  type McpScope,
  type McpSetup,
} from '../shared/ai-status.js';
import {
  commandLine,
  connectCommand,
  connectSettings,
  planCommand,
  programCandidates,
  settingsFile,
  unsafeForCmd,
  type FindEnv,
} from './agent-cli.js';

function agent(id: string): AgentDesc {
  const a = agentById(id);
  if (!a?.command && !a?.settings) throw new Error(`agents/${id}.json missing`);
  return a;
}
const claude = agent('claude');
const gemini = agent('gemini');
const codex = agent('codex');
const copilot = agent('copilot');
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing in the description');
  return v;
}

// Before the description files these were hand-written per agent; the expectations below are the
// ones they had, now met by the description files run through the engines.
const claudeCandidates = (env: FindEnv, list?: (dir: string) => string[]): string[] =>
  programCandidates(need(claude.command).program, env, list);
const geminiCandidates = (env: FindEnv, list?: (dir: string) => string[]): string[] =>
  programCandidates(need(gemini.command).program, env, list);
const claudeAddArgs = (s: McpSetup, scope: McpScope): string[] =>
  commandArgs(need(claude.command), s, scope);
const codexToml = (s: McpSetup): string => settingsText(need(codex.settings), s);
/** The old test hook named Codex's folder; the engine takes the file. */
const codexConfigPath = (home: string): string =>
  settingsFile(need(codex.settings), join(home, 'config.toml'));
const connectCodex = (s: McpSetup, home: string) =>
  connectSettings(codex, s, { file: join(home, 'config.toml') });
const planClaudeCode = (s: McpSetup, t: ConnectTarget, program?: string) =>
  planCommand(claude, s, t, { program });
const connectClaudeCode = (s: McpSetup, t: ConnectTarget, program?: string) =>
  connectCommand(claude, s, t, { program });
const planGemini = (s: McpSetup, program?: string, file?: string) =>
  planCommand(gemini, s, { scope: 'user' }, { program, file });
const connectGemini = (s: McpSetup, replace: boolean, program?: string, file?: string) =>
  connectCommand(gemini, s, { scope: 'user', replace }, { program, file });

const extensions = (dir: string): string[] =>
  /[\\/]\.vscode[\\/]extensions$/.test(dir)
    ? [
        'anthropic.claude-code-2.1.9-darwin-arm64',
        'anthropic.claude-code-2.1.322-darwin-arm64',
        'ms-python.python-2025.1.0',
      ]
    : [];

describe('claudeCandidates (one-click Connect)', () => {
  it('macOS: PATH first, then install folders, then the newest editor extension copy', () => {
    const home = '/Users/me';
    const list = claudeCandidates(
      { platform: 'darwin', home, env: { PATH: '/usr/bin:/bin:relative/bin' } },
      extensions,
    );
    expect(list.slice(0, 3)).toEqual([
      posix.join('/usr/bin', 'claude'),
      posix.join('/bin', 'claude'),
      posix.join(home, '.local', 'bin', 'claude'),
    ]);
    expect(list).toContain('/opt/homebrew/bin/claude');
    expect(list.some((p) => p.includes('relative'))).toBe(false);
    const ext = list.filter((p) => p.includes('anthropic.claude-code-'));
    expect(ext).toEqual([
      posix.join(
        home,
        '.vscode',
        'extensions',
        'anthropic.claude-code-2.1.322-darwin-arm64',
        'resources',
        'native-binary',
        'claude',
      ),
      posix.join(
        home,
        '.vscode',
        'extensions',
        'anthropic.claude-code-2.1.9-darwin-arm64',
        'resources',
        'native-binary',
        'claude',
      ),
    ]);
  });

  it('Windows: .exe before npm’s .cmd shim; extension copy is claude.exe', () => {
    const home = 'C:\\Users\\me';
    const list = claudeCandidates(
      {
        platform: 'win32',
        home,
        env: { PATH: 'C:\\Tools;C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      },
      extensions,
    );
    expect(list[0]).toBe(win32.join('C:\\Tools', 'claude.exe'));
    expect(list[1]).toBe(win32.join('C:\\Tools', 'claude.cmd'));
    expect(list).toContain(win32.join(home, '.local', 'bin', 'claude.exe'));
    expect(list).toContain(win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'claude.cmd'));
    expect(
      list.filter((p) => p.includes('anthropic.')).every((p) => p.endsWith('claude.exe')),
    ).toBe(true);
  });
});

describe('commandLine', () => {
  const app = 'C:\\Users\\me\\AppData\\Local\\Programs\\Third Wheel';
  const setup = {
    serverPath: `${app}\\resources\\mcp\\third-wheel-mcp.js`,
    exists: true,
    packaged: true,
    platform: 'win32',
    command: `${app}\\Third Wheel.exe`,
    env: MCP_RUN_AS_NODE,
    temporaryLocation: false,
  };

  it('Windows .cmd shim: one cmd.exe line, paths with spaces quoted', () => {
    const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
    expect(commandLine('win32', shim, claudeAddArgs(setup, 'user'))).toEqual({
      exe: 'cmd.exe',
      argv: [
        '/d',
        '/v:off',
        '/s',
        '/c',
        `"${shim} mcp add --scope user third-wheel --env "ELECTRON_RUN_AS_NODE=1" -- "${setup.command}" "${setup.serverPath}""`,
      ],
      verbatim: true,
    });
  });

  it('Windows .cmd: refuses % and " (cmd.exe expands %NAME% even inside quotes)', () => {
    const shim = 'C:\\npm\\claude.cmd';
    expect(unsafeForCmd(['mcp', 'C:\\100% sure\\x.js'])).toContain('100% sure');
    expect(unsafeForCmd(['mcp', 'C:\\a "b"\\x.js'])).toBeDefined();
    expect(unsafeForCmd(claudeAddArgs(setup, 'user'))).toBeUndefined();
    expect(() => commandLine('win32', shim, ['mcp', 'add', '%PATH%'])).toThrow(/%/);
    // `!` stays a letter (delayed expansion off) and is quoted.
    expect(commandLine('win32', shim, ['C:\\a!b\\x.js']).argv.at(-1)).toBe(
      `"${shim} "C:\\a!b\\x.js""`,
    );
    // A native claude.exe gets its arguments directly: nothing to refuse.
    expect(commandLine('win32', 'C:\\x\\claude.exe', ['100%']).argv).toEqual(['100%']);
  });

  it('.exe and macOS: started directly with the arguments as they are', () => {
    const args = claudeAddArgs(setup, 'user');
    expect(commandLine('win32', 'C:\\x\\claude.exe', args)).toEqual({
      exe: 'C:\\x\\claude.exe',
      argv: args,
      verbatim: false,
    });
    expect(commandLine('darwin', '/usr/local/bin/claude', ['mcp', 'list']).verbatim).toBe(false);
  });
});

describe('geminiCandidates', () => {
  it('macOS: PATH, then npm / Homebrew folders; no editor-extension copies', () => {
    const list = geminiCandidates(
      { platform: 'darwin', home: '/Users/me', env: { PATH: '/usr/bin' } },
      extensions,
    );
    expect(list[0]).toBe('/usr/bin/gemini');
    expect(list).toContain('/opt/homebrew/bin/gemini');
    expect(list).toContain('/Users/me/.npm-global/bin/gemini');
    expect(list.some((p) => p.includes('extensions'))).toBe(false);
  });

  it('Windows: npm’s gemini.cmd on PATH and in %APPDATA%\\npm', () => {
    const list = geminiCandidates(
      {
        platform: 'win32',
        home: 'C:\\Users\\me',
        env: { Path: 'C:\\Tools', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      },
      extensions,
    );
    expect(list[0]).toBe(win32.join('C:\\Tools', 'gemini.cmd'));
    expect(list).toContain(win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'gemini.cmd'));
  });
});

describe('settingsFile', () => {
  it('~/ = home; an absolute folder variable (CODEX_HOME) wins; a relative one is ignored', () => {
    const spec = need(codex.settings);
    const saved = process.env['CODEX_HOME'];
    try {
      delete process.env['CODEX_HOME'];
      expect(settingsFile(spec)).toBe(join(homedir(), '.codex', 'config.toml'));
      process.env['CODEX_HOME'] = join(tmpdir(), 'codex-x');
      expect(settingsFile(spec)).toBe(join(tmpdir(), 'codex-x', 'config.toml'));
      process.env['CODEX_HOME'] = 'relative/codex';
      expect(settingsFile(spec)).toBe(join(homedir(), '.codex', 'config.toml'));
    } finally {
      if (saved === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = saved;
    }
  });
});

describe('connectCodex', () => {
  const setup: McpSetup = {
    serverPath: '/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js',
    exists: true,
    packaged: true,
    platform: 'darwin',
    command: '/Applications/Third Wheel.app/Contents/MacOS/Third Wheel',
    env: MCP_RUN_AS_NODE,
    temporaryLocation: false,
  };

  it('creates the folder + file; keeps a backup of an existing file and the user’s settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-codex-'));
    try {
      const home = join(dir, 'codex-home');
      const file = codexConfigPath(home);
      expect(file).toBe(join(home, 'config.toml'));
      expect(await connectCodex(setup, home)).toEqual({ ok: true, path: file });
      expect(readFileSync(file, 'utf8')).toBe(`${codexToml(setup)}\n`);
      writeFileSync(file, 'model = "gpt-5"\n[mcp_servers.third-wheel]\ncommand = "old"\n');
      expect((await connectCodex(setup, home)).ok).toBe(true);
      expect(readFileSync(`${file}.bak`, 'utf8')).toContain('command = "old"');
      const now = readFileSync(file, 'utf8');
      expect(now).toContain('model = "gpt-5"');
      expect(now).not.toContain('"old"');
      expect(now).toContain('tool_timeout_sec = 1800');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Windows: making a symlink needs admin rights / developer mode (CI runs on Windows).
  it.skipIf(process.platform === 'win32')(
    'a symlinked config.toml stays a link; an unsafe layout is left alone',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tw-codex-'));
      try {
        const home = join(dir, 'codex-home');
        mkdirSync(home);
        const real = join(dir, 'dotfiles-config.toml');
        writeFileSync(real, 'model = "gpt-5"\n');
        symlinkSync(real, join(home, 'config.toml'));
        expect((await connectCodex(setup, home)).ok).toBe(true);
        expect(lstatSync(join(home, 'config.toml')).isSymbolicLink()).toBe(true);
        expect(readFileSync(real, 'utf8')).toContain('tool_timeout_sec = 1800');
        writeFileSync(real, 'x = """\nmulti\n"""\n');
        const r = await connectCodex(setup, home);
        expect(r).toMatchObject({ ok: false, reason: 'failed' });
        expect(readFileSync(real, 'utf8')).toBe('x = """\nmulti\n"""\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses from a temporary location', async () => {
    expect(await connectCodex({ ...setup, temporaryLocation: true }, '/nowhere')).toEqual({
      ok: false,
      reason: 'temporary-location',
    });
  });
});

/**
 * One-click Connect with a fake `claude` that behaves like Claude Code 2.1 on its settings file
 *: local entries filed under the git project's top folder (else the folder), user entries
 * at the top, `add` refuses an existing entry. POSIX only (a `#!` script).
 */
describe.skipIf(process.platform === 'win32')('Claude Code one-click', () => {
  let dir: string;
  let log: string;
  let fake: string;
  let server: string;
  let setup: McpSetup;
  const savedConfigDir = process.env['CLAUDE_CONFIG_DIR'];
  const config = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, 'cfg', '.claude.json'), 'utf8')) as Record<string, unknown>;
  const calls = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean);

  beforeEach(() => {
    // .native: the long form of the path, as the app gets it (Windows CI temp folders have an 8.3 short name).
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-claude-')));
    mkdirSync(join(dir, 'cfg'));
    process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'cfg');
    server = join(dir, 'third-wheel-mcp.js');
    writeFileSync(server, '');
    setup = {
      serverPath: server,
      exists: true,
      packaged: false,
      platform: process.platform,
      command: 'node',
      env: {},
      temporaryLocation: false,
    };
    log = join(dir, 'calls.log');
    fake = join(dir, 'claude');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, process.cwd() + ' | ' + args.join(' ') + '\\n');
let c = {}; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
let top = process.cwd();
for (let d = top; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) { top = d; break; } if (path.dirname(d) === d) break; }
const si = args.indexOf('-s') >= 0 ? args.indexOf('-s') : args.indexOf('--scope');
const scope = si >= 0 ? args[si + 1] : 'local';
c.projects ??= {}; c.projects[top] ??= {};
const servers = scope === 'user' ? (c.mcpServers ??= {}) : (c.projects[top].mcpServers ??= {});
if (args[1] === 'remove') delete servers['third-wheel'];
if (args[1] === 'add') {
  if (servers['third-wheel']) { console.error('MCP server third-wheel already exists in ' + scope + ' config'); process.exit(1); }
  const dash = args.indexOf('--');
  servers['third-wheel'] = { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env: {} };
}
fs.writeFileSync(file, JSON.stringify(c));
`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('"This folder only" runs in the model’s folder; the plan shows the program and command first', async () => {
    const project = join(dir, 'cad');
    mkdirSync(project);
    const modelPath = join(project, 'part.step');
    const plan = await planClaudeCode(setup, { scope: 'folder', modelPath }, fake);
    expect(plan).toMatchObject({
      program: fake,
      folder: project,
      steps: [`claude mcp add third-wheel -- node "${server}"`],
      check: { state: 'none' },
    });
    expect(plan.replace).toBeUndefined();
    expect(existsSync(log)).toBe(false); // planning ran nothing
    const r = await connectClaudeCode(setup, { scope: 'folder', modelPath }, fake);
    expect(r).toMatchObject({ ok: true, path: fake, check: { state: 'ok' } });
    expect(calls()).toEqual([`${project} | mcp add third-wheel -- node ${server}`]);
    expect(config()['mcpServers']).toBeUndefined(); // not "All my folders"
  });

  it('an existing entry is replaced only after the user agreed; never removed silently', async () => {
    const r1 = await connectClaudeCode(setup, { scope: 'user' }, fake);
    expect(r1.ok).toBe(true);
    const plan = await planClaudeCode(setup, { scope: 'user' }, fake);
    expect(plan.replace).toMatchObject({ where: 'user', serverPath: server, serverExists: true });
    expect(plan.steps[0]).toBe('claude mcp remove third-wheel -s user');
    expect(await connectClaudeCode(setup, { scope: 'user' }, fake)).toEqual({
      ok: false,
      reason: 'exists',
    });
    expect(calls()).toHaveLength(1); // the refused click ran nothing
    const r2 = await connectClaudeCode(setup, { scope: 'user', replace: true }, fake);
    expect(r2.ok).toBe(true);
    expect(
      calls()
        .slice(1)
        .map((l) => l.split(' | ')[1]),
    ).toEqual([
      'mcp remove third-wheel -s user',
      `mcp add --scope user third-wheel -- node ${server}`,
    ]);
  });

  it('green only when the entry Claude Code uses starts an existing server: a folder’s broken .mcp.json wins over "All my folders"', async () => {
    const project = join(dir, 'cad');
    mkdirSync(join(project, 'sub'), { recursive: true });
    await connectClaudeCode(setup, { scope: 'user' }, fake);
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'third-wheel': { command: 'node', args: ['/gone/x.js'] } } }),
    );
    // Checked from a subfolder: a .mcp.json counts below its folder too.
    const plan = await planClaudeCode(
      setup,
      { scope: 'user', modelPath: join(project, 'sub', 'a.step') },
      fake,
    );
    expect(plan.check?.state).toBe('warn');
    expect(plan.check?.used?.where).toBe('project');
    expect(plan.check?.text).toContain('/gone/x.js');
    expect(plan.check?.text).toContain('multiple scopes');
  });

  it('inside a git project the entry is filed under its top folder and counts in subfolders', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'parts'));
    const r = await connectClaudeCode(
      setup,
      { scope: 'folder', folder: join(repo, 'parts') },
      fake,
    );
    expect(r).toMatchObject({
      ok: true,
      check: { state: 'ok', used: { where: 'local', folder: repo } },
    });
    // A folder outside the project: nothing there.
    const other = join(dir, 'other');
    mkdirSync(other);
    expect(
      (await planClaudeCode(setup, { scope: 'folder', folder: other }, fake)).check?.state,
    ).toBe('none');
  });

  it('"This folder only" without a folder: blocked, nothing runs', async () => {
    const plan = await planClaudeCode(setup, { scope: 'folder' }, fake);
    expect(plan.blocked).toContain('Choose the folder');
    expect((await connectClaudeCode(setup, { scope: 'folder' }, fake)).ok).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it('Gemini: the existing entry in settings.json is shown and replaced only when agreed', async () => {
    const settings = join(dir, 'gemini-settings.json');
    const glog = join(dir, 'gemini.log');
    const gemini = join(dir, 'gemini');
    writeFileSync(gemini, `#!/bin/sh\necho "$*" >> '${glog}'\n`, { mode: 0o755 });
    expect((await planGemini(setup, gemini, settings)).replace).toBeUndefined();
    writeFileSync(
      settings,
      JSON.stringify({ mcpServers: { 'third-wheel': { command: 'node', args: ['/old/x.js'] } } }),
    );
    const plan = await planGemini(setup, gemini, settings);
    expect(plan.replace).toMatchObject({ serverPath: '/old/x.js', serverExists: false });
    expect(plan.steps).toHaveLength(2);
    expect(await connectGemini(setup, false, gemini, settings)).toEqual({
      ok: false,
      reason: 'exists',
    });
    expect(existsSync(glog)).toBe(false);
    expect((await connectGemini(setup, true, gemini, settings)).ok).toBe(true);
    expect(readFileSync(glog, 'utf8').trim().split('\n')).toEqual([
      'mcp remove -s user third-wheel',
      `mcp add -s user --timeout 1800000 third-wheel node ${server}`,
    ]);
  });

  it('Copilot CLI: runs its own mcp add (30-min timeout, -- before the command); an old entry is replaced only when agreed', async () => {
    const settings = join(dir, 'mcp-config.json');
    const clog = join(dir, 'copilot.log');
    const program = join(dir, 'copilot');
    writeFileSync(program, `#!/bin/sh\necho "$*" >> '${clog}'\n`, { mode: 0o755 });
    const plan = (): ReturnType<typeof planCommand> =>
      planCommand(copilot, setup, { scope: 'user' }, { program, file: settings });
    const connect = (replace: boolean): ReturnType<typeof connectCommand> =>
      connectCommand(copilot, setup, { scope: 'user', replace }, { program, file: settings });
    expect((await plan()).replace).toBeUndefined();
    writeFileSync(
      settings,
      JSON.stringify({
        mcpServers: { 'third-wheel': { type: 'local', command: 'node', args: ['/old/x.js'] } },
      }),
    );
    expect((await plan()).replace).toMatchObject({ serverPath: '/old/x.js' });
    expect(await connect(false)).toEqual({ ok: false, reason: 'exists' });
    expect(existsSync(clog)).toBe(false);
    expect((await connect(true)).ok).toBe(true);
    expect(readFileSync(clog, 'utf8').trim().split('\n')).toEqual([
      'mcp remove third-wheel',
      `mcp add third-wheel --timeout 1800000 -- node ${server}`,
    ]);
  });
});
