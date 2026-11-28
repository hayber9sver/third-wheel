import { describe, expect, it } from 'vitest';
import {
  ago,
  aiStatusView,
  RECENT_CALL_MS,
  saveStatusView,
  shellQuote,
  toolOfMethod,
  type McpSetup,
  type McpScope,
  MCP_RUN_AS_NODE,
} from './ai-status.js';
import { agentById } from './agent-list.js';
import { commandArgs, commandText, jsonSnippet } from './agents.js';

// Claude Code's command and .mcp.json, now from agents/claude.json: the expectations are the ones
// the hand-written builders had.
const claude = agentById('claude');
const claudeCommand = claude?.command;
if (!claude || !claudeCommand) throw new Error('agents/claude.json missing');
const claudeAddCommand = (s: McpSetup, scope: McpScope): string =>
  commandText(claudeCommand, s, scope);
const claudeAddArgs = (s: McpSetup, scope: McpScope): string[] =>
  commandArgs(claudeCommand, s, scope);
const mcpJsonSnippet = (s: McpSetup): string => jsonSnippet(claude, s) ?? '';

const NOW = 1_800_000_000_000;

describe('toolOfMethod', () => {
  it('names the MCP tool behind each bridge method; ping / status are no tool', () => {
    expect(toolOfMethod('load')).toBe('load_model');
    expect(toolOfMethod('wait_review')).toBe('wait_for_review');
    expect(toolOfMethod('annotations')).toBe('get_annotations');
    expect(toolOfMethod('render')).toBe('render_region');
    expect(toolOfMethod('reply_comment')).toBe('reply_to_comment');
    expect(toolOfMethod('open_model')).toBe('get_open_model');
    expect(toolOfMethod('search_parts')).toBe('search_parts');
    expect(toolOfMethod('ping')).toBeUndefined();
    expect(toolOfMethod('status')).toBeUndefined();
    expect(toolOfMethod('toString')).toBeUndefined();
  });
});

describe('aiStatusView', () => {
  it('grey "no agent yet" before any call, never says "connected" or "ready"', () => {
    const v = aiStatusView({ bridge: 'on' }, NOW);
    expect(v).toMatchObject({ dot: 'idle', label: 'AI: no agent yet' });
    expect(v.label + v.title).not.toMatch(/connected|ready/i);
  });

  it('green "listening" while an agent waits in the Agent tab', () => {
    const last = { tool: 'wait_for_message', at: NOW - RECENT_CALL_MS - 1 };
    expect(aiStatusView({ bridge: 'on', lastCall: last }, NOW, true)).toMatchObject({
      dot: 'active',
      label: 'AI: listening',
    });
    expect(aiStatusView({ bridge: 'on' }, NOW, true).label).toBe('AI: listening');
    // A bridge that is down wins.
    expect(aiStatusView({ bridge: 'failed' }, NOW, true).dot).toBe('error');
  });

  it('green for a recent call (outlasts a chat wait), grey after', () => {
    const at = NOW - 2 * 60_000;
    const v = aiStatusView({ bridge: 'on', lastCall: { tool: 'load_model', at } }, NOW);
    expect(v).toMatchObject({ dot: 'active', label: 'AI: last call 2 min ago' });
    expect(v.title).toContain('load_model');
    const old = aiStatusView(
      { bridge: 'on', lastCall: { tool: 'load_model', at: NOW - RECENT_CALL_MS - 1 } },
      NOW,
    );
    expect(old).toMatchObject({ dot: 'idle', label: 'AI: last call 30 min ago' });
    const listening = aiStatusView(
      { bridge: 'on', lastCall: { tool: 'wait_for_message', at: NOW - 25 * 60_000 } },
      NOW,
    );
    expect(listening.dot).toBe('active');
  });

  it('red when the bridge failed or is off', () => {
    const v = aiStatusView({ bridge: 'failed', error: 'EACCES' }, NOW);
    expect(v).toMatchObject({ dot: 'error', label: "AI: off — couldn't start" });
    expect(v.title).toContain('EACCES');
    expect(aiStatusView({ bridge: 'off' }, NOW).dot).toBe('error');
  });
});

describe('ago', () => {
  it('reads like a person', () => {
    expect(ago(10_000)).toBe('just now');
    expect(ago(-5)).toBe('just now');
    expect(ago(59 * 60_000)).toBe('59 min ago');
    expect(ago(3 * 3600_000)).toBe('3 h ago');
    expect(ago(24 * 3600_000)).toBe('1 day ago');
    expect(ago(50 * 3600_000)).toBe('2 days ago');
  });
});

describe('connect command', () => {
  const mac: McpSetup = {
    serverPath: '/Users/me/third wheel/third-wheel-mcp.js',
    exists: true,
    packaged: false,
    platform: 'darwin',
    command: 'node',
    env: {},
    temporaryLocation: false,
  };
  const win: McpSetup = {
    serverPath: 'C:\\Program Files\\third-wheel\\resources\\mcp\\third-wheel-mcp.js',
    exists: true,
    packaged: false,
    platform: 'win32',
    command: 'node',
    env: {},
    temporaryLocation: false,
  };
  const macApp: McpSetup = {
    serverPath: '/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js',
    exists: true,
    packaged: true,
    platform: 'darwin',
    command: '/Applications/Third Wheel.app/Contents/MacOS/Third Wheel',
    env: MCP_RUN_AS_NODE,
    temporaryLocation: false,
  };
  const winApp: McpSetup = {
    serverPath:
      'C:\\Users\\me\\AppData\\Local\\Programs\\Third Wheel\\resources\\mcp\\third-wheel-mcp.js',
    exists: true,
    packaged: true,
    platform: 'win32',
    command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Third Wheel\\Third Wheel.exe',
    env: MCP_RUN_AS_NODE,
    temporaryLocation: false,
  };

  it('quotes the path; folder scope is Claude Code’s default', () => {
    expect(claudeAddCommand(mac, 'folder')).toBe(
      'claude mcp add third-wheel -- node "/Users/me/third wheel/third-wheel-mcp.js"',
    );
    expect(claudeAddCommand(mac, 'user')).toBe(
      'claude mcp add --scope user third-wheel -- node "/Users/me/third wheel/third-wheel-mcp.js"',
    );
    expect(claudeAddCommand(win, 'folder')).toBe(
      'claude mcp add third-wheel -- node "C:\\Program Files\\third-wheel\\resources\\mcp\\third-wheel-mcp.js"',
    );
  });

  it('packaged app: runs the server with its own executable as Node', () => {
    expect(claudeAddCommand(macApp, 'user')).toBe(
      'claude mcp add --scope user third-wheel --env ELECTRON_RUN_AS_NODE=1 -- "/Applications/Third Wheel.app/Contents/MacOS/Third Wheel" "/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js"',
    );
    expect(claudeAddCommand(winApp, 'folder')).toBe(
      `claude mcp add third-wheel --env ELECTRON_RUN_AS_NODE=1 -- "${winApp.command}" "${winApp.serverPath}"`,
    );
    expect(claudeAddArgs(winApp, 'user')).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'third-wheel',
      '--env',
      'ELECTRON_RUN_AS_NODE=1',
      '--',
      winApp.command,
      winApp.serverPath,
    ]);
    expect(claudeAddArgs(mac, 'folder')).toEqual([
      'mcp',
      'add',
      'third-wheel',
      '--',
      'node',
      mac.serverPath,
    ]);
    expect(JSON.parse(mcpJsonSnippet(winApp))).toEqual({
      mcpServers: {
        'third-wheel': {
          command: winApp.command,
          args: [winApp.serverPath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    });
  });

  it('single-quotes paths sh would expand', () => {
    expect(shellQuote("/a/$HOME/it's.js", 'darwin')).toBe(`'/a/$HOME/it'\\''s.js'`);
    expect(shellQuote('C:\\a b\\x.js', 'win32')).toBe('"C:\\a b\\x.js"');
  });

  it('.mcp.json snippet is valid JSON with the exact path', () => {
    const parsed = JSON.parse(mcpJsonSnippet(win)) as {
      mcpServers: { 'third-wheel': { command: string; args: string[] } };
    };
    expect(parsed.mcpServers['third-wheel']).toEqual({ command: 'node', args: [win.serverPath] });
  });
});

describe('saveStatusView', () => {
  it('grey Saved, amber Saving…, red Not saved', () => {
    expect(saveStatusView('saved')).toEqual({ dot: 'idle', label: 'Saved' });
    expect(saveStatusView('pending')).toEqual({ dot: 'busy', label: 'Saving…' });
    expect(saveStatusView('saving').dot).toBe('busy');
    expect(saveStatusView('error').dot).toBe('error');
  });
});
