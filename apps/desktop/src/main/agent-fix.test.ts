import {
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentById } from '../shared/agent-list.js';
import type { McpSetup } from '../shared/ai-status.js';
import { planCommand } from './agent-cli.js';
import { planAllow, removeEntry, writeAllow } from './agent-fix.js';

const claude = agentById('claude');
if (!claude) throw new Error('agents/claude.json missing');

describe('agent fixes', () => {
  let dir: string;
  let cad: string;
  let setup: McpSetup;
  const savedConfigDir = process.env['CLAUDE_CONFIG_DIR'];
  const settings = (): string => join(cad, '.claude', 'settings.local.json');

  beforeEach(() => {
    // .native: the long form of the path, as the app gets it (Windows CI temp folders have an 8.3 short name).
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-fix-')));
    cad = join(dir, 'cad');
    mkdirSync(join(dir, 'cfg'));
    mkdirSync(cad);
    process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'cfg'); // never the real ~/.claude.json
    const server = join(dir, 'third-wheel-mcp.js');
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
  });
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const extra = process.platform === 'win32' ? ['PowerShell(python *.py)'] : [];

  it('allow: preview first, writes only what it showed, keeps the rest, never twice', async () => {
    const plan = await planAllow(claude, cad, 'python *.py');
    expect(plan).toEqual({
      file: settings(),
      exists: false,
      add: ['mcp__third-wheel', 'Bash(python *.py)', ...extra],
    });
    expect(existsSync(settings())).toBe(false); // planning wrote nothing
    // The file changed after the preview: refused, nothing written.
    expect(await writeAllow(claude, cad, 'python *.py', ['mcp__third-wheel'])).toMatchObject({
      ok: false,
      changed: true,
    });
    expect(await writeAllow(claude, cad, 'python *.py', plan.add)).toEqual({
      ok: true,
      file: settings(),
      added: plan.add,
    });
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toEqual({
      permissions: { allow: plan.add },
    });
    // An existing file: other settings stay, a .bak is kept.
    writeFileSync(
      settings(),
      JSON.stringify({ enabledMcpjsonServers: ['x'], permissions: { allow: ['Bash(ls *)'] } }),
    );
    const again = await planAllow(claude, cad, 'uv run *.py');
    expect(again.exists).toBe(true);
    await writeAllow(claude, cad, 'uv run *.py', again.add);
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toEqual({
      enabledMcpjsonServers: ['x'],
      permissions: {
        allow: [
          'Bash(ls *)',
          'mcp__third-wheel',
          'Bash(uv run *.py)',
          ...(extra.length ? ['PowerShell(uv run *.py)'] : []),
        ],
      },
    });
    expect(existsSync(`${settings()}.bak`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'never writes through links a cloned folder may hold (settings file, .bak, temp file)',
    async () => {
      const outside = join(dir, 'outside.json');
      writeFileSync(outside, '{"keep": true}');
      mkdirSync(join(cad, '.claude'));
      // A planted .bak and temp file link: removed and made fresh, the target untouched.
      symlinkSync(outside, `${settings()}.bak`);
      symlinkSync(outside, `${settings()}.thirdwheel-tmp`);
      writeFileSync(settings(), '{}');
      const plan = await planAllow(claude, cad, 'python *.py');
      expect(await writeAllow(claude, cad, 'python *.py', plan.add)).toMatchObject({ ok: true });
      expect(readFileSync(outside, 'utf8')).toBe('{"keep": true}');
      expect(readFileSync(`${settings()}.bak`, 'utf8')).toBe('{}');
      // The settings file itself a link: refused, nothing written.
      rmSync(settings());
      symlinkSync(outside, settings());
      expect((await planAllow(claude, cad, 'python *.py')).error).toMatch(/is a link/);
      expect(await writeAllow(claude, cad, 'python *.py', [])).toMatchObject({ ok: false });
      expect(readFileSync(outside, 'utf8')).toBe('{"keep": true}');
      // A linked .claude folder: refused.
      rmSync(join(cad, '.claude'), { recursive: true });
      mkdirSync(join(dir, 'elsewhere'));
      symlinkSync(join(dir, 'elsewhere'), join(cad, '.claude'));
      const viaLink = await planAllow(claude, cad, 'python *.py');
      expect(await writeAllow(claude, cad, 'python *.py', viaLink.add)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/link to another folder/) as unknown,
      });
      expect(existsSync(join(dir, 'elsewhere', 'settings.local.json'))).toBe(false);
    },
  );

  it('allow: refuses a bad command, a broken file and a missing folder', async () => {
    expect((await planAllow(claude, cad, '*')).error).toMatch(/lone \*/);
    expect((await planAllow(claude, join(dir, 'gone'), 'python *.py')).error).toMatch(
      /Open a project folder/,
    );
    mkdirSync(join(cad, '.claude'));
    writeFileSync(settings(), '{ broken');
    expect((await planAllow(claude, cad, 'python *.py')).error).toMatch(/isn’t valid JSON/);
    expect(await writeAllow(claude, cad, 'python *.py', [])).toMatchObject({ ok: false });
    expect(readFileSync(settings(), 'utf8')).toBe('{ broken');
  });

  it('a .mcp.json you said no to doesn’t count; a broken one can be removed (only what the check offered)', async () => {
    const mcpJson = join(cad, '.mcp.json');
    writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: { 'third-wheel': { command: 'node', args: ['/gone/x.js'] }, other: {} },
      }),
    );
    const target = { scope: 'folder' as const, folder: cad };
    const plan = await planCommand(claude, setup, target, { program: '' });
    expect(plan.check).toMatchObject({ state: 'warn', fixes: [{ where: 'project' }] });
    mkdirSync(join(cad, '.claude'));
    writeFileSync(settings(), JSON.stringify({ disabledMcpjsonServers: ['third-wheel'] }));
    const off = await planCommand(claude, setup, target, { program: '' });
    expect(off.check?.state).toBe('none');
    expect(off.check?.text).toContain('you said no to it');
    // Not offered any more (turned off): refused.
    expect(
      await removeEntry(claude, setup, target, { where: 'project', file: mcpJson }),
    ).toMatchObject({ ok: false });
    rmSync(settings());
    expect(await removeEntry(claude, setup, target, { where: 'project', file: mcpJson })).toEqual({
      ok: true,
    });
    expect(JSON.parse(readFileSync(mcpJson, 'utf8'))).toEqual({ mcpServers: { other: {} } });
    expect(existsSync(`${mcpJson}.bak`)).toBe(true);
  });
});
