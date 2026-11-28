import { describe, expect, it } from 'vitest';
import { agentById } from './agent-list.js';
import {
  approvalOf,
  checkSetup as checkFor,
  objectAt,
  confirmText,
  entryInJson,
  replaceText,
  samePath,
  type FoundEntry,
  type RawEntry,
} from './claude-setup.js';

const claude = agentById('claude');
if (!claude) throw new Error('agents/claude.json missing');
const checkSetup = (
  ...args: [
    FoundEntry[],
    { serverPath: string; platform: string; command?: string; env?: Record<string, string> },
    string | undefined,
  ]
) => checkFor(claude, ...args);
/** `~/.claude.json`: the local entry for the folder, then the user entry (as claude.json says). */
const claudeJsonEntries = (
  json: unknown,
  file: string,
  key: string,
  platform: string,
): RawEntry[] =>
  (claude.command?.entries ?? [])
    .filter((e) => e.file === '~/.claude.json')
    .map((e) =>
      entryInJson(
        json,
        e.key.map((k) => k.replace('{name}', 'third-wheel')),
        e.where,
        file,
        key,
        platform,
      ),
    )
    .filter((e): e is RawEntry => e !== undefined);
const mcpJsonEntry = (json: unknown, file: string): RawEntry | undefined =>
  entryInJson(json, ['mcpServers', 'third-wheel'], 'project', file, undefined, '');

const ours = '/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js';
const setup = { serverPath: ours, platform: 'darwin' };
const entry = (where: FoundEntry['where'], serverPath: string, exists = true): FoundEntry => ({
  where,
  file: where === 'project' ? '/cad/.mcp.json' : '/Users/me/.claude.json',
  ...(where === 'local' ? { folder: '/cad' } : {}),
  command: 'node',
  args: [serverPath],
  serverPath,
  serverExists: exists,
});

describe('reading Claude Code settings', () => {
  const json = {
    mcpServers: { 'third-wheel': { command: 'node', args: ['/u/x.js'] } },
    projects: {
      'C:/Users/me/CAD': {
        mcpServers: { 'third-wheel': { command: 'node', args: ['--flag', 'C:\\tw\\mcp.js'] } },
      },
      '/cad': { mcpServers: { other: { command: 'x' } } },
    },
  };

  it('local entry by the folder key (Windows: any case, / or \\), then the user entry', () => {
    const win = claudeJsonEntries(json, 'cfg', 'c:\\users\\me\\cad\\', 'win32');
    expect(win.map((e) => [e.where, e.serverPath, e.folder])).toEqual([
      ['local', 'C:\\tw\\mcp.js', 'C:/Users/me/CAD'],
      ['user', '/u/x.js', undefined],
    ]);
    // macOS / Linux: case counts; another server in the folder is not ours.
    expect(claudeJsonEntries(json, 'cfg', '/CAD', 'darwin').map((e) => e.where)).toEqual(['user']);
    expect(claudeJsonEntries(json, 'cfg', '/cad', 'darwin').map((e) => e.where)).toEqual(['user']);
    expect(claudeJsonEntries('not json', 'cfg', '/cad', 'darwin')).toEqual([]);
  });

  it('.mcp.json entry; paths compared per platform', () => {
    expect(
      mcpJsonEntry({ mcpServers: { 'third-wheel': { command: 'node', args: ['/p.js'] } } }, 'f'),
    ).toMatchObject({ where: 'project', serverPath: '/p.js' });
    expect(mcpJsonEntry({}, 'f')).toBeUndefined();
    expect(samePath('C:\\A\\b\\', 'c:/a/B', 'win32')).toBe(true);
    expect(samePath('/A/b/', '/a/b', 'darwin')).toBe(false);
    expect(samePath('/a/b/', '/a/b', 'darwin')).toBe(true);
  });
});

describe('checkSetup: green only when it will work', () => {
  it('none, ok, missing file, another copy', () => {
    expect(checkSetup([], setup, '/cad').state).toBe('none');
    expect(checkSetup([entry('user', ours)], setup, '/cad')).toMatchObject({
      state: 'ok',
      used: { where: 'user' },
    });
    const gone = checkSetup([entry('local', '/old/mcp.js', false)], setup, '/cad');
    expect(gone.state).toBe('warn');
    expect(gone.text).toContain('doesn’t exist');
    const other = checkSetup([entry('user', '/dev/third-wheel-mcp.js')], setup, undefined);
    expect(other.state).toBe('warn');
    expect(other.text).toContain('another copy');
  });

  it('local before .mcp.json before user; a second entry elsewhere is flagged', () => {
    const check = checkSetup(
      [entry('user', ours), entry('project', '/gone.js', false), entry('local', ours)],
      setup,
      '/cad',
    );
    expect(check.used?.where).toBe('local');
    expect(check.state).toBe('warn');
    expect(check.text).toContain('/cad/.mcp.json');
    expect(check.text).toContain('multiple scopes');
    expect(check.text).not.toContain('-s user'); // same file as the one used: no conflict
  });
});

describe('checkSetup: how the entry starts the server, and the user’s yes / no', () => {
  const packaged = {
    ...setup,
    command: '/Applications/Third Wheel.app/Contents/MacOS/Third Wheel',
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const appEntry = (env?: Record<string, string>): FoundEntry => ({
    ...entry('local', ours),
    command: packaged.command,
    ...(env ? { env } : {}),
  });

  it('packaged: the app itself with ELECTRON_RUN_AS_NODE; dev: any node', () => {
    expect(checkSetup([appEntry({ ELECTRON_RUN_AS_NODE: '1' })], packaged, '/cad').state).toBe(
      'ok',
    );
    const noEnv = checkSetup([appEntry()], packaged, '/cad');
    expect(noEnv).toMatchObject({ state: 'warn', fixes: [{ where: 'local' }] });
    expect(noEnv.text).toContain('misses ELECTRON_RUN_AS_NODE=1');
    const viaNode = checkSetup([entry('local', ours)], packaged, '/cad');
    expect(viaNode.text).toContain('starts the server with node, not /Applications/');
    const dev = { ...setup, command: 'node', env: {} };
    expect(
      checkSetup([{ ...entry('local', ours), command: '/opt/homebrew/bin/node' }], dev, '/cad')
        .state,
    ).toBe('ok');
    expect(checkSetup([{ ...entry('local', ours), command: 'python' }], dev, '/cad').state).toBe(
      'warn',
    );
  });

  it('.mcp.json: a no hides it, not asked yet = needs your yes, duplicates are fixes', () => {
    const project = (approval: FoundEntry['approval']): FoundEntry => ({
      ...entry('project', ours),
      ...(approval ? { approval } : {}),
    });
    const off = checkSetup([project('off')], setup, '/cad');
    expect(off.state).toBe('none');
    expect(off.text).toContain('you said no to it in Claude Code');
    expect(checkSetup([project('ask')], setup, '/cad')).toMatchObject({
      state: 'warn',
      short: 'Needs your yes',
    });
    expect(checkSetup([project('on')], setup, '/cad').state).toBe('ok');
    const dup = checkSetup(
      [entry('local', ours), entry('user', '/old/x.js', false)],
      setup,
      '/cad',
    );
    expect(dup.fixes.map((e) => e.where)).toEqual(['user']);
    // A no means Claude Code never loads it: no "multiple scopes" either.
    expect(checkSetup([entry('local', ours), project('off')], setup, '/cad').state).toBe('ok');
  });

  it('approvalOf / objectAt: a no anywhere wins, then a yes or "all"', () => {
    const spec = {
      enabled: 'enabledMcpjsonServers',
      disabled: 'disabledMcpjsonServers',
      all: 'enableAllProjectMcpServers',
    };
    const home = { projects: { 'C:/CAD': { enabledMcpjsonServers: ['third-wheel'] } } };
    const proj = objectAt(home, ['projects', '{project}'], 'c:\\cad', 'win32');
    expect(approvalOf([proj], spec, 'third-wheel')).toBe('on');
    expect(
      approvalOf([proj, { disabledMcpjsonServers: ['third-wheel'] }], spec, 'third-wheel'),
    ).toBe('off');
    expect(approvalOf([undefined, { enableAllProjectMcpServers: true }], spec, 'third-wheel')).toBe(
      'on',
    );
    expect(approvalOf([{ enabledMcpjsonServers: ['other'] }], spec, 'third-wheel')).toBe('ask');
    expect(objectAt(home, [], undefined, '')).toBe(home);
  });
});

describe('the "about to run" box', () => {
  it('names program, folder and the entry it replaces', () => {
    const text = confirmText(
      { program: '/Users/me/.local/bin/claude', folder: '/cad', steps: [] },
      'folder',
    );
    expect(text).toContain('Program: /Users/me/.local/bin/claude');
    expect(text).toContain('In folder: /cad');
    expect(confirmText({ program: null, steps: [] }, 'user')).not.toContain('In folder');
    expect(replaceText(entry('local', '/old.js', false))).toContain(
      '/old.js (that file doesn’t exist)',
    );
  });
});
