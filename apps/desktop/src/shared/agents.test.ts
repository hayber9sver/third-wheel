import { describe, expect, it } from 'vitest';
import type { AgentDesc } from './agent-desc.js';
import { agentById, ALL_AGENTS, visibleAgents } from './agent-list.js';
import {
  agentPanel as panelOf,
  agentResultText as resultOf,
  commandArgs,
  commandText,
  installUrl,
  jsonSnippet,
  settingsText,
  tomlString,
  withTomlEntry,
} from './agents.js';
import { MCP_RUN_AS_NODE, type McpSetup } from './ai-status.js';

function agent(id: string): AgentDesc {
  const a = agentById(id);
  if (!a) throw new Error(`no ${id}.json`);
  return a;
}
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing in the description');
  return v;
}

// Before the description files these were hand-written builders; the expectations below are the
// ones they had, now met by the description files run through the engines.
type OtherAgentId = 'codex' | 'gemini' | 'copilot' | 'cursor' | 'vscode' | 'other';
const codexToml = (s: McpSetup): string => settingsText(need(agent('codex').settings), s);
const withCodexServer = (existing: string, block: string): string | undefined =>
  withTomlEntry(existing, ['mcp_servers', 'third-wheel'], block);
const geminiAddArgs = (s: McpSetup): string[] =>
  commandArgs(need(agent('gemini').command), s, 'user');
const geminiAddCommand = (s: McpSetup): string =>
  commandText(need(agent('gemini').command), s, 'user');
const mcpServersJson = (s: McpSetup): string => need(jsonSnippet(agent('cursor'), s));
const vscodeJson = (s: McpSetup): string => need(jsonSnippet(agent('vscode'), s));
const cursorInstallUrl = (s: McpSetup): string => installUrl(need(agent('cursor').link), s);
const vscodeInstallUrl = (s: McpSetup): string => installUrl(need(agent('vscode').link), s);
const agentPanel = (
  id: OtherAgentId,
  s: McpSetup,
  found: string | null | undefined,
): ReturnType<typeof panelOf> => panelOf(agent(id), s, found);
const agentResultText = (id: OtherAgentId, r: Parameters<typeof resultOf>[1]): string =>
  resultOf(agent(id), r);

const MAC_APP = '/Applications/Third Wheel.app/Contents';
const mac: McpSetup = {
  serverPath: `${MAC_APP}/Resources/mcp/third-wheel-mcp.js`,
  exists: true,
  packaged: true,
  platform: 'darwin',
  command: `${MAC_APP}/MacOS/Third Wheel`,
  env: MCP_RUN_AS_NODE,
  temporaryLocation: false,
};
const WIN_APP = "C:\\Users\\Zoë O'Neil\\AppData\\Local\\Programs\\Third Wheel";
const win: McpSetup = {
  ...mac,
  platform: 'win32',
  serverPath: `${WIN_APP}\\resources\\mcp\\third-wheel-mcp.js`,
  command: `${WIN_APP}\\Third Wheel.exe`,
};
const winPlain: McpSetup = {
  ...win,
  serverPath:
    'C:\\Users\\zoe\\AppData\\Local\\Programs\\Third Wheel\\resources\\mcp\\third-wheel-mcp.js',
  command: 'C:\\Users\\zoe\\AppData\\Local\\Programs\\Third Wheel\\Third Wheel.exe',
};
const dev: McpSetup = {
  ...mac,
  packaged: false,
  serverPath: '/Users/zoe/third-wheel/packages/mcp-server/build/third-wheel-mcp.js',
  command: 'node',
  env: {},
};

/** Enough of a TOML reader for our own output: tables, `k = "…"`, `k = '…'`, `k = [ … ]`, numbers. */
function readToml(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let table = '';
  const value = (v: string): unknown => {
    v = v.trim();
    if (v.startsWith('[')) return [value(v.slice(1, -1))];
    if (v.startsWith("'")) return v.slice(1, -1);
    if (v.startsWith('"')) return JSON.parse(v) as unknown; // our basic strings are JSON-compatible
    return Number(v);
  };
  for (const line of text.split(/\r?\n/)) {
    const h = /^\[(.+)\]$/.exec(line.trim());
    if (h) {
      table = h[1] ?? '';
      out[table] ??= {};
    } else if (line.includes('=')) {
      const at = line.indexOf('=');
      (out[table] ??= {})[line.slice(0, at).trim()] = value(line.slice(at + 1));
    }
  }
  return out;
}

describe('agent list', () => {
  it('Claude Code first, then Codex, Gemini CLI, Copilot CLI, Cursor, VS Code, Other', () => {
    expect(ALL_AGENTS.map((a) => a.label)).toEqual([
      'Claude Code',
      'Codex',
      'Gemini CLI',
      'Copilot CLI',
      'Cursor',
      'VS Code',
      'Other',
    ]);
    expect(agentById('codex')).toBeDefined();
    expect(agentById('chatgpt')).toBeUndefined();
    expect(agentById(null)).toBeUndefined();
  });

  it('only agents tried with the real program are shown; all of them with THIRD_WHEEL_SHOW_UNTESTED', () => {
    expect(visibleAgents(false).map((a) => a.id)).toEqual(['claude', 'other']);
    expect(visibleAgents(true)).toEqual(ALL_AGENTS);
  });
});

describe('Codex config.toml', () => {
  it('macOS: basic strings, timeout, env table', () => {
    const toml = codexToml(mac);
    expect(toml).toBe(
      [
        '[mcp_servers.third-wheel]',
        `command = "${MAC_APP}/MacOS/Third Wheel"`,
        `args = ["${MAC_APP}/Resources/mcp/third-wheel-mcp.js"]`,
        'tool_timeout_sec = 1800',
        '',
        '[mcp_servers.third-wheel.env]',
        'ELECTRON_RUN_AS_NODE = "1"',
      ].join('\n'),
    );
  });

  it('Windows: paths in single quotes with the \\ as they are', () => {
    const toml = codexToml(winPlain);
    expect(toml).toContain(`command = '${winPlain.command}'`);
    expect(toml).toContain(`args = ['${winPlain.serverPath}']`);
    expect(readToml(toml)['mcp_servers.third-wheel']).toEqual({
      command: winPlain.command,
      args: [winPlain.serverPath],
      tool_timeout_sec: 1800,
    });
  });

  it("Windows path with ' falls back to an escaped basic string that reads back the same", () => {
    expect(tomlString("C:\\O'Neil", 'win32')).toBe('"C:\\\\O\'Neil"');
    expect(readToml(codexToml(win))['mcp_servers.third-wheel']).toMatchObject({
      command: win.command,
      args: [win.serverPath],
    });
  });

  it('dev build: node, no env table', () => {
    const toml = codexToml(dev);
    expect(toml).toContain('command = "node"');
    expect(toml).not.toContain('.env]');
  });

  it('a mac path with " or \\ is escaped', () => {
    expect(tomlString('/a "b"\\c', 'darwin')).toBe('"/a \\"b\\"\\\\c"');
  });
});

describe('withCodexServer (one-click Codex writes config.toml)', () => {
  const block = codexToml(mac);

  it('empty file → only our entry', () => {
    expect(withCodexServer('', block)).toBe(`${block}\n`);
  });

  it('keeps other settings and servers, replaces an older Third Wheel entry and its env table', () => {
    const before = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.third-wheel]',
      'command = "node"',
      'args = ["/old/third-wheel-mcp.js"]',
      '',
      '[mcp_servers.third-wheel.env]',
      'FOO = "1"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n');
    const after = withCodexServer(before, block);
    expect(after).toBe(
      ['model = "gpt-5"', '', '[mcp_servers.other]', 'command = "other"', '', block, ''].join('\n'),
    );
    // Running it again changes nothing.
    expect(withCodexServer(after ?? '', block)).toBe(after);
  });

  it('quoted table names and inline / dotted forms of the old entry go too', () => {
    const before = [
      'mcp_servers.third-wheel.command = "w"',
      '[mcp_servers."third-wheel"]',
      'command = "x"',
      '[mcp_servers]',
      'third-wheel = { command = "y" }',
      'keep = { command = "z" }',
      '[profiles.a]',
      'mcp_servers.third-wheel.command = "kept"', // the profile's, not ours
    ].join('\n');
    const after = withCodexServer(before, block);
    expect(after).not.toMatch(/"x"|"y"|"w"/);
    expect(after).toContain('keep = { command = "z" }');
    expect(after).toContain('[profiles.a]\nmcp_servers.third-wheel.command = "kept"');
  });

  it('keeps a comment above the next table; refuses layouts it can’t edit line by line', () => {
    const before = [
      '[mcp_servers.third-wheel]',
      'command = "old"',
      '',
      '# my precious server',
      '[mcp_servers.foo]',
      'command = "foo"',
    ].join('\n');
    expect(withCodexServer(before, block)).toBe(
      ['# my precious server', '[mcp_servers.foo]', 'command = "foo"', '', block, ''].join('\n'),
    );
    const multiLineEntry = [
      '[mcp_servers]',
      'third-wheel = { command = "a", args = [',
      '  "b",',
      '] }',
    ];
    expect(withCodexServer(multiLineEntry.join('\n'), block)).toBeUndefined();
    expect(withCodexServer('instructions = """\n[mcp_servers]\n"""\n', block)).toBeUndefined();
    expect(withCodexServer('[mcp_servers]\nthird-wheel = { args = ["]"] }\n', block)).toContain(
      '[mcp_servers]',
    );
  });

  it('keeps Windows line ends', () => {
    const after = withCodexServer('model = "gpt-5"\r\n', codexToml(winPlain));
    expect(after).toBe(
      `model = "gpt-5"\r\n\r\n${codexToml(winPlain).split('\n').join('\r\n')}\r\n`,
    );
  });
});

describe('Gemini CLI', () => {
  it('macOS: -s user, -e before the name, quoted paths', () => {
    expect(geminiAddCommand(mac)).toBe(
      `gemini mcp add -s user --timeout 1800000 -e ELECTRON_RUN_AS_NODE=1 third-wheel "${mac.command}" "${mac.serverPath}"`,
    );
    expect(geminiAddArgs(mac)).toEqual([
      'mcp',
      'add',
      '-s',
      'user',
      '--timeout',
      '1800000',
      '-e',
      'ELECTRON_RUN_AS_NODE=1',
      'third-wheel',
      mac.command,
      mac.serverPath,
    ]);
  });

  it('Windows: plain \\ in double quotes; dev: node', () => {
    expect(geminiAddCommand(winPlain)).toBe(
      `gemini mcp add -s user --timeout 1800000 -e ELECTRON_RUN_AS_NODE=1 third-wheel "${winPlain.command}" "${winPlain.serverPath}"`,
    );
    expect(geminiAddCommand(dev)).toBe(
      `gemini mcp add -s user --timeout 1800000 third-wheel node "${dev.serverPath}"`,
    );
  });
});

describe('Copilot CLI', () => {
  it('name first, --env per variable, -- before the command; dev: node', () => {
    const text = (s: McpSetup): string => commandText(need(agent('copilot').command), s, 'user');
    expect(text(mac)).toBe(
      `copilot mcp add third-wheel --timeout 1800000 --env ELECTRON_RUN_AS_NODE=1 -- "${mac.command}" "${mac.serverPath}"`,
    );
    expect(text(dev)).toBe(
      `copilot mcp add third-wheel --timeout 1800000 -- node "${dev.serverPath}"`,
    );
    expect(agentPanel('copilot', mac, null).text).toBe(text(mac));
  });
});

describe('Cursor / VS Code / other JSON', () => {
  it('mcpServers JSON; Windows \\ escaped by JSON and read back the same', () => {
    expect(JSON.parse(mcpServersJson(win))).toEqual({
      mcpServers: {
        'third-wheel': { command: win.command, args: [win.serverPath], env: MCP_RUN_AS_NODE },
      },
    });
    expect(mcpServersJson(win)).toContain('C:\\\\Users');
    expect(JSON.parse(mcpServersJson(dev))).toEqual({
      mcpServers: { 'third-wheel': { command: 'node', args: [dev.serverPath] } },
    });
  });

  it('VS Code Copilot: type stdio + tools', () => {
    expect(JSON.parse(vscodeJson(mac))).toEqual({
      mcpServers: {
        'third-wheel': {
          type: 'stdio',
          command: mac.command,
          args: [mac.serverPath],
          env: MCP_RUN_AS_NODE,
          tools: ['*'],
        },
      },
    });
  });

  it('Cursor install link: name + base64 JSON (UTF-8 paths survive)', () => {
    const url = new URL(cursorInstallUrl(win));
    expect(url.protocol).toBe('cursor:');
    expect(url.searchParams.get('name')).toBe('third-wheel');
    const bytes = Uint8Array.from(atob(url.searchParams.get('config') ?? ''), (c) =>
      c.charCodeAt(0),
    );
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      command: win.command,
      args: [win.serverPath],
      env: MCP_RUN_AS_NODE,
    });
  });

  it('VS Code install link: vscode:mcp/install?<JSON with name>', () => {
    const url = vscodeInstallUrl(mac);
    expect(url.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(url.slice('vscode:mcp/install?'.length)))).toEqual({
      name: 'third-wheel',
      type: 'stdio',
      command: mac.command,
      args: [mac.serverPath],
      env: MCP_RUN_AS_NODE,
    });
  });
});

describe('agentPanel', () => {
  const ids: OtherAgentId[] = ['codex', 'gemini', 'cursor', 'vscode', 'other'];

  it('every agent shows copy-ready text with this copy’s paths, on both OSes', () => {
    for (const setup of [mac, winPlain])
      for (const id of ids) {
        const p = agentPanel(id, setup, undefined);
        expect(p.text, id).toContain(
          id === 'codex' ? `'${setup.command}'`.slice(1, 10) : 'third-wheel',
        );
        expect(p.title, id).not.toBe('');
        expect(p.where, id).not.toBe('');
      }
    expect(agentPanel('codex', winPlain, null).text).toBe(codexToml(winPlain));
    expect(agentPanel('gemini', mac, '/opt/homebrew/bin/gemini').text).toBe(geminiAddCommand(mac));
    expect(agentPanel('vscode', mac, null).text).toBe(vscodeJson(mac));
  });

  it('buttons: Codex / Cursor / VS Code always, Gemini only when found, none for Other', () => {
    expect(agentPanel('codex', mac, '/Users/z/.codex/config.toml')).toMatchObject({
      button: 'Add to Codex',
    });
    expect(agentPanel('codex', mac, '/Users/z/.codex/config.toml').buttonHint).toContain(
      '/Users/z/.codex/config.toml',
    );
    expect(agentPanel('cursor', mac, null).button).toBe('Add to Cursor');
    expect(agentPanel('vscode', mac, null).button).toBe('Install in VS Code');
    expect(agentPanel('gemini', mac, '/x/gemini').button).toBe('Add to Gemini CLI');
    const missing = agentPanel('gemini', mac, null);
    expect(missing.button).toBeUndefined();
    expect(missing.buttonHint).toContain('wasn’t found');
    expect(agentPanel('other', mac, null).button).toBeUndefined();
    expect(agentPanel('codex', mac, null).where).toContain('60 s');
  });

  it('result lines', () => {
    expect(agentResultText('codex', { ok: true, path: '/u/.codex/config.toml' })).toContain(
      'Added ✓ to /u/.codex/config.toml',
    );
    expect(agentResultText('gemini', { ok: true, path: '/g' })).toContain('Added ✓');
    expect(agentResultText('cursor', { ok: false, reason: 'not-found' })).toContain(
      'Cursor didn’t open',
    );
    expect(agentResultText('gemini', { ok: false, reason: 'failed', detail: 'boom' })).toContain(
      'boom',
    );
    expect(agentResultText('vscode', { ok: false, reason: 'temporary-location' })).toContain(
      'Applications',
    );
  });
});
