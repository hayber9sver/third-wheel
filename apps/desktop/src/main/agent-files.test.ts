/** The agent description files (read from disk, as a contributor's pull request adds them) and their checker. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CHAT_WAIT_SECONDS } from '@third-wheel/core';
import { describe, expect, it } from 'vitest';
import { checkAgentDesc, readAgentDescs } from '../shared/agent-desc.js';
import { AGENT_PROBLEMS, ALL_AGENTS } from '../shared/agent-list.js';
import { settingsText, withJsonEntry } from '../shared/agents.js';
import { MCP_RUN_AS_NODE, type McpSetup } from '../shared/ai-status.js';

const DIR = join(import.meta.dirname, '../../agents');
const read = (file: string): unknown =>
  JSON.parse(readFileSync(join(DIR, file), 'utf8')) as unknown;
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'));

describe('agent description files (CI fails on a broken one)', () => {
  it('every file in apps/desktop/agents/ passes the checker and is built into the app', () => {
    expect(AGENT_PROBLEMS).toEqual([]);
    for (const f of files) expect(checkAgentDesc(read(f), f.replace(/\.json$/, '')), f).toEqual([]);
    expect(ALL_AGENTS.map((a) => `${a.id}.json`).sort()).toEqual([...files].sort());
  });

  it("an agent we set up lets a tool run longer than the app's longest wait (listening to the chat)", () => {
    // Claude Code stops a tool only after 30 min without an answer or progress; the others get a
    // limit written into their setup (Codex: seconds in config.toml; Gemini / Copilot CLI: --timeout ms).
    const needSec = MAX_CHAT_WAIT_SECONDS + 60;
    for (const a of ALL_AGENTS) {
      if (a.id === 'claude') continue;
      let sec: number | undefined;
      const entry = a.settings?.entry as Record<string, unknown> | undefined;
      if (typeof entry?.['tool_timeout_sec'] === 'number') sec = entry['tool_timeout_sec'];
      const add = a.command?.add ?? [];
      const i = add.indexOf('--timeout');
      if (i >= 0) sec = Number(add[i + 1]) / 1000;
      if (a.engine === 'command' || a.engine === 'settings')
        expect(sec, a.id).toBeGreaterThanOrEqual(needSec);
    }
  });

  it('the editor schema lists the same fields as the checker', () => {
    const schema = read('agent.schema.json') as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const claude = read('claude.json') as Record<string, unknown>;
    for (const k of Object.keys(claude)) expect(Object.keys(schema.properties), k).toContain(k);
    expect(schema.required.sort()).toEqual(
      ['id', 'label', 'tab', 'order', 'tested', 'engine', 'manual', 'texts'].sort(),
    );
  });
});

describe('checkAgentDesc', () => {
  const good = {
    id: 'copilot',
    label: 'Copilot CLI',
    tab: 'Copilot CLI',
    order: 60,
    tested: null,
    engine: 'settings',
    settings: {
      file: '~/.copilot/mcp-config.json',
      format: 'json',
      key: ['mcpServers', '{name}'],
      entry: { type: 'local', command: '{command}', args: ['{serverPath}'], env: '{env}' },
    },
    manual: { settings: true },
    texts: { button: 'Add to Copilot CLI', title: 'Or add this yourself', where: '…' },
  };
  const problems = (patch: Record<string, unknown>, name = 'copilot'): string[] =>
    checkAgentDesc({ ...good, ...patch }, name);

  it('a filled-in copy is fine', () => {
    expect(problems({})).toEqual([]);
  });

  it('id = file name; unknown fields and placeholders are refused', () => {
    expect(problems({}, 'other-name').join()).toContain('must be the file name');
    expect(problems({ run: 'rm -rf ~' }).join()).toContain('copilot.run: unknown field');
    expect(
      problems({ settings: { ...good.settings, entry: { command: '{HOME}' } } }).join(),
    ).toContain('unknown placeholder {HOME}');
  });

  it('a missing engine part or button text is named', () => {
    expect(problems({ engine: 'command' }).join()).toContain('command: needed by engine');
    expect(problems({ texts: { title: 't' } }).join()).toContain('texts.button');
  });

  it('links: only an app’s own link, never a web, file or script address', () => {
    const link = (url: string): string[] =>
      problems({ engine: 'link', link: { url, config: {}, encode: 'json' } });
    expect(link('cursor://x/install?c={config}')).toEqual([]);
    expect(link('vscode:mcp/install?{config}')).toEqual([]);
    for (const url of [
      'search-ms:query={config}',
      'shell:startup?{config}',
      'https://evil.example/?c={config}',
      'file:///etc/passwd?{config}',
      'javascript:alert(1)//{config}',
      'no-scheme {config}',
    ])
      expect(link(url).join(), url).toContain('must start with cursor:');
  });

  it('files stay under home; programs are plain names; no hidden characters in texts', () => {
    const file = (f: string): string =>
      problems({ settings: { ...good.settings, file: f } }).join();
    expect(file('/etc/hosts')).toContain('settings.file');
    expect(file('~/../x.json')).toContain('settings.file');
    expect(
      problems({
        engine: 'command',
        command: {
          program: { name: '../bin/sh', windows: [], folders: [] },
          add: ['{serverPath}'],
          env: [],
          remove: [],
          scopes: { user: { args: [], where: 'user' } },
          entries: [],
          timeoutSec: 20,
        },
      }).join(),
    ).toContain('plain program name');
    expect(problems({ label: 'Copilot' + String.fromCodePoint(0x202e) }).join()).toContain(
      'invisible',
    );
    expect(file('~/.zshrc')).toContain('must end in .json');
    expect(problems({ settings: { ...good.settings, format: 'toml' } }).join()).toContain(
      'must end in .toml',
    );
  });

  it('a command agent runs its own program only: no shells or script runners', () => {
    const cmd = (name: string, windows: string[] = [`${name}.exe`]): string =>
      problems({
        engine: 'command',
        command: {
          program: { name, windows, folders: [] },
          add: ['mcp', 'add', '{name}', '{command}', '{serverPath}'],
          env: [],
          remove: [],
          scopes: { user: { args: [], where: 'user' } },
          entries: [],
          timeoutSec: 20,
        },
      }).join();
    expect(cmd('copilot', ['copilot.exe', 'copilot.cmd'])).toBe('');
    for (const shell of ['bash', 'pwsh', 'node', 'python3', 'osascript', 'CMD.exe'])
      expect(cmd(shell), shell).toContain('own program');
    expect(cmd('copilot', ['cmd.exe'])).toContain('must be copilot.exe or copilot.cmd');
    expect(cmd('copilot', ['..\\copilot.exe'])).toContain('must be copilot.exe');
  });

  it('a broken file is left out with its problems; the rest are sorted by order', () => {
    const r = readAgentDescs({
      'x/agents/copilot.json': good,
      'x/agents/broken.json': { id: 'broken' },
      'x/agents/first.json': { ...good, id: 'first', order: 1 },
      'x/agents/agent.schema.json': {},
    });
    expect(r.agents.map((a) => a.id)).toEqual(['first', 'copilot']);
    expect(r.problems.every((p) => p.startsWith('broken.json: '))).toBe(true);
  });
});

describe('settings engine, JSON format (for agents like Copilot CLI)', () => {
  const setup: McpSetup = {
    serverPath: '/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js',
    exists: true,
    packaged: true,
    platform: 'darwin',
    command: '/Applications/Third Wheel.app/Contents/MacOS/Third Wheel',
    env: MCP_RUN_AS_NODE,
    temporaryLocation: false,
  };
  const spec = {
    file: '~/.copilot/mcp-config.json',
    format: 'json' as const,
    key: ['mcpServers', '{name}'],
    entry: { command: '{command}', args: ['{serverPath}'], env: '{env}' },
  };

  it('shows the entry nested under its keys', () => {
    expect(JSON.parse(settingsText(spec, setup))).toEqual({
      mcpServers: {
        'third-wheel': { command: setup.command, args: [setup.serverPath], env: MCP_RUN_AS_NODE },
      },
    });
  });

  it('replaces our entry, keeps everything else; refuses a file that isn’t a JSON object', () => {
    const before = JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'x' }, 'third-wheel': { command: 'old' } },
    });
    const after = JSON.parse(
      withJsonEntry(before, ['mcpServers', 'third-wheel'], { command: 'new' }) ?? '',
    ) as unknown;
    expect(after).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'x' }, 'third-wheel': { command: 'new' } },
    });
    expect(withJsonEntry('', ['a', 'b'], 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
    expect(withJsonEntry('{ broken', ['a'], 1)).toBeUndefined();
    expect(withJsonEntry('[]', ['a'], 1)).toBeUndefined();
    expect(withJsonEntry('{"mcpServers": 3}', ['mcpServers', 'x'], 1)).toBeUndefined();
  });
});
