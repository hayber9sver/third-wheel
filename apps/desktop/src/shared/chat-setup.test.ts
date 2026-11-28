import { describe, expect, it } from 'vitest';
import { checkAgentDesc } from './agent-desc.js';
import {
  allowPreview,
  allowRules,
  cadCommandProblem,
  chatSetupLine,
  isInside,
  mergeAllow,
  startCommand,
} from './chat-setup.js';

const spec = {
  file: '.claude/settings.local.json',
  key: ['permissions', 'allow'],
  rules: ['mcp__{name}', 'Bash({cad})'],
  windowsRules: ['PowerShell({cad})'],
};

describe('chat setup', () => {
  it('startCommand: the folder in single quotes per shell', () => {
    expect(startCommand('claude', '/Users/me/my cad', 'darwin')).toBe(
      "cd '/Users/me/my cad' && claude",
    );
    expect(startCommand('claude', "/a/it's", 'darwin')).toBe("cd '/a/it'\\''s' && claude");
    expect(startCommand('claude', "C:\\Users\\me\\it's", 'win32')).toBe(
      "cd -LiteralPath 'C:\\Users\\me\\it''s'; claude",
    );
    // PowerShell also ends a string at curly quotes; [ ] stay literal with -LiteralPath.
    expect(startCommand('claude', 'C:\\Bob’s [v2]', 'win32')).toBe(
      "cd -LiteralPath 'C:\\Bob’’s [v2]'; claude",
    );
  });

  it('isInside: the folder or below, by the platform’s rules', () => {
    expect(isInside('/cad', '/cad', 'darwin')).toBe(true);
    expect(isInside('/cad/parts', '/cad', 'darwin')).toBe(true);
    expect(isInside('/cadx', '/cad', 'darwin')).toBe(false);
    expect(isInside('C:\\CAD\\parts', 'c:/cad', 'win32')).toBe(true);
  });

  it('chatSetupLine: waiting → connected (folder warning) → listening → stopped', () => {
    const line = (s: Parameters<typeof chatSetupLine>[0], folder = '/cad') =>
      chatSetupLine(s, folder, 'Claude Code', 'darwin');
    expect(line({ state: 'none' })).toMatchObject({ state: 'waiting' });
    const started = { connection: 'conn00001', at: 1, folder: '/cad/parts' };
    expect(line({ state: 'none', started })).toEqual({
      state: 'connected',
      text: 'Connected (started in “parts”) — now paste the start phrase (step 2).',
    });
    expect(line({ state: 'none', started: { ...started, folder: '/home' } }).warn).toMatch(
      /started in “home”, not in the project folder “cad”/,
    );
    expect(
      line({ state: 'none', started: { connection: 'conn00001', at: 1 } }).warn,
    ).toBeUndefined();
    expect(line({ state: 'working', started }).state).toBe('listening');
    expect(line({ state: 'not-listening' }).state).toBe('stopped');
    expect(line({ state: 'not-listening', started: { ...started, listened: true } }).state).toBe(
      'stopped',
    );
    // A new start after the last one stopped: connected, not stopped.
    expect(line({ state: 'stopped', started }).state).toBe('connected');
  });

  it('cadCommandProblem: a program first; no brackets, lone wildcards or line breaks', () => {
    expect(cadCommandProblem('python *.py')).toBeUndefined();
    expect(cadCommandProblem('uv run build.py')).toBeUndefined();
    expect(cadCommandProblem(' ')).toMatch(/Type the command/);
    expect(cadCommandProblem('*')).toMatch(/lone \*/);
    expect(cadCommandProblem('python x.py) Bash(rm')).toMatch(/brackets/);
    expect(cadCommandProblem('a\nb')).toMatch(/line breaks/);
  });

  it('allowRules: placeholders filled; Windows adds its own rules', () => {
    expect(allowRules(spec, ' python *.py ', 'darwin')).toEqual([
      'mcp__third-wheel',
      'Bash(python *.py)',
    ]);
    expect(allowRules(spec, 'python *.py', 'win32')).toEqual([
      'mcp__third-wheel',
      'Bash(python *.py)',
      'PowerShell(python *.py)',
    ]);
  });

  it('mergeAllow: keeps other settings and rules, adds only missing ones, refuses bad files', () => {
    const rules = ['mcp__third-wheel', 'Bash(python *.py)'];
    const created = mergeAllow(undefined, spec.key, rules);
    expect(created).toEqual({
      ok: true,
      add: rules,
      text: `${JSON.stringify({ permissions: { allow: rules } }, null, 2)}\n`,
    });
    const old = JSON.stringify({
      enabledMcpjsonServers: ['x'],
      permissions: { allow: ['Bash(ls *)', 'mcp__third-wheel'], deny: ['Bash(rm *)'] },
    });
    const merged = mergeAllow(old, spec.key, rules);
    if (!merged.ok) throw new Error(merged.error);
    expect(merged.add).toEqual(['Bash(python *.py)']);
    expect(JSON.parse(merged.text)).toEqual({
      enabledMcpjsonServers: ['x'],
      permissions: {
        allow: ['Bash(ls *)', 'mcp__third-wheel', 'Bash(python *.py)'],
        deny: ['Bash(rm *)'],
      },
    });
    // Nothing missing: the text stays as it is.
    expect(mergeAllow(merged.text, spec.key, rules)).toEqual({
      ok: true,
      add: [],
      text: merged.text,
    });
    expect(mergeAllow('\uFEFF{}', spec.key, rules)).toMatchObject({ ok: true, add: rules });
    expect(mergeAllow('{ nope', spec.key, rules)).toMatchObject({ ok: false });
    expect(mergeAllow('[]', spec.key, rules)).toMatchObject({ ok: false });
    expect(mergeAllow('{"permissions": {"allow": "x"}}', spec.key, rules)).toMatchObject({
      ok: false,
      error: '“allow” in it isn’t a list',
    });
    expect(mergeAllow('{"permissions": 3}', spec.key, rules)).toMatchObject({ ok: false });
  });

  it('allowPreview: says create or add, and each line', () => {
    expect(
      allowPreview('.claude/settings.local.json', '/me/cad', false, ['mcp__third-wheel']),
    ).toBe('Creates .claude/settings.local.json in “cad” with:\n  "mcp__third-wheel"');
    expect(allowPreview('f.json', '/cad', true, ['a', 'b'])).toBe(
      'Adds to f.json in “cad”:\n  "a"\n  "b"',
    );
  });

  it('description files: the chat part is checked', () => {
    const base = {
      id: 'x',
      label: 'X',
      tab: 'X',
      order: 1,
      tested: null,
      engine: 'manual',
      manual: { json: {} },
      texts: { title: 'X' },
    };
    expect(checkAgentDesc({ ...base, chat: { start: 'x', allow: spec } }, 'x')).toEqual([]);
    const bad = checkAgentDesc(
      {
        ...base,
        chat: {
          start: 'x; rm',
          allow: { ...spec, file: '~/.bashrc', rules: ['Bash({oops})'] },
        },
      },
      'x',
    );
    expect(bad).toEqual([
      'chat.start: must be a plain program name',
      'chat.allow.file: must be a .json file inside the folder (no ~/)',
      'chat.allow.rules[0]: unknown placeholder {oops}',
    ]);
    expect(
      checkAgentDesc({ ...base, chat: { start: 'x', allow: { ...spec, file: '../a.json' } } }, 'x'),
    ).toContain(
      'chat.allow.file: must start with ~/ or be a plain file name (no .. or absolute paths)',
    );
  });
});
