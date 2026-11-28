/**
 * Agent description files (`apps/desktop/agents/<id>.json`): what the Connect pop-up shows for one
 * AI agent and what its one-click button does. A file only fills in one of the built-in engines
 * (`agents.ts` builds the texts, `main/agent-cli.ts` runs them); it can't make the app run
 * anything those engines don't already do. How to write one: `docs/adding-an-agent.md`.
 * Pure: used by main, the renderer and the tests.
 */

/** Where an existing Third Wheel entry sits, in Claude Code's words (other agents use `user`). */
export type EntryWhere = 'local' | 'project' | 'user';

/** The scopes the pop-up's switch offers: "This folder only" and "All my folders". */
export type McpScope = 'folder' | 'user';

/**
 * A JSON value with placeholders: the strings `"{name}"`, `"{command}"`, `"{serverPath}"` (also as
 * object keys), and `"{env}"` as a whole value = the environment object, left out when empty.
 */
export type Template = string | number | boolean | null | Template[] | { [key: string]: Template };

/** A settings file: `~/` = the home folder; `fileEnv` = an environment variable naming its folder. */
export interface FileSpec {
  readonly file: string;
  readonly fileEnv?: string;
}

/** A Third Wheel entry the agent may already have (shown, and replaced only when agreed). */
export interface EntrySpec extends FileSpec {
  readonly where: EntryWhere;
  /**
   * Path of keys to the entry in that JSON file. `{project}` = the folder (or its git project's
   * top folder), compared the way the platform compares paths. A file without `~/` is looked for
   * in the folder and the ones above it (like `.mcp.json`).
   */
  readonly key: readonly string[];
  /** For an entry the agent asks about before using it (Claude Code: a folder's `.mcp.json`). */
  readonly approval?: ApprovalSpec;
}

/**
 * Where the agent keeps the user's yes / no for a folder's entries: lists of server names
 * (`enabled`, `disabled`) and a "yes to all" flag (`all`) in the objects at `files[].key`. A file
 * without `~/` is looked for in the folder (and its git project's top folder).
 */
export interface ApprovalSpec {
  readonly files: readonly (FileSpec & { readonly key: readonly string[] })[];
  readonly enabled: string;
  readonly disabled: string;
  readonly all: string;
}

/** The Connect pop-up's "Chat in Third Wheel" part. */
export interface ChatSpec {
  /** What to type in a terminal to start the agent ("claude"). */
  readonly start: string;
  /** "Ask fewer permission questions": rules written into a settings file in the folder. */
  readonly allow?: AllowSpec;
}

/** Pre-allow rules: `{name}` = the server's name, `{cad}` = the CAD command the user typed. */
export interface AllowSpec {
  /** A `.json` file, relative to the folder the agent starts in (never `~/`, never `..`). */
  readonly file: string;
  /** Path of keys to the list of rules. */
  readonly key: readonly string[];
  readonly rules: readonly string[];
  /** Added on Windows only. */
  readonly windowsRules?: readonly string[];
}

export interface CommandSpec {
  /** The program to look for: name, Windows file names, install folders, editor extension copy. */
  readonly program: {
    readonly name: string;
    readonly windows: readonly string[];
    readonly folders: readonly string[];
    readonly editorExtension?: string;
  };
  /** Arguments of the add command: `{scope}` and `{env}` expand to several (or none). */
  readonly add: readonly string[];
  /** Arguments per environment variable, with `{key}` and `{value}`. */
  readonly env: readonly string[];
  /** Arguments of the remove command, with `{where}` = the entry's scope name. */
  readonly remove: readonly string[];
  /** The scopes offered: one = no switch in the pop-up; `folder` = runs in the chosen folder. */
  readonly scopes: Readonly<
    Partial<Record<McpScope, { readonly args: readonly string[]; readonly where: EntryWhere }>>
  >;
  /** Existing entries, in the order the agent uses them (first wins). */
  readonly entries: readonly EntrySpec[];
  /** Show a status line: is the entry the agent will use this app's? */
  readonly check?: boolean;
  readonly timeoutSec: number;
}

export interface SettingsSpec extends FileSpec {
  readonly format: 'json' | 'toml';
  /** Path of keys to the entry (TOML: its table). */
  readonly key: readonly string[];
  readonly entry: Template;
}

export interface LinkSpec {
  /** With `{name}` and `{config}`. */
  readonly url: string;
  readonly config: Template;
  /** `base64`: URL-encoded base64 of the JSON; `json`: URL-encoded JSON. */
  readonly encode: 'base64' | 'json';
}

/** Texts; `{file}` in `buttonHint` = the settings file. */
export interface AgentTexts {
  readonly button?: string;
  readonly buttonHint?: string;
  /** Instead of `buttonHint` / `title` when the program wasn't found. */
  readonly notFoundHint?: string;
  readonly title?: string;
  readonly notFoundTitle?: string;
  readonly where?: string;
  /** After a successful one-click: how to check it. */
  readonly after?: string;
  /** The ⓘ texts of the scope switch. */
  readonly scopeFolder?: string;
  readonly scopeUser?: string;
}

export interface AgentDesc {
  readonly id: string;
  /** The agent's name in sentences ("Claude Code"). */
  readonly label: string;
  /** The tab. */
  readonly tab: string;
  /** Tabs are sorted by this. */
  readonly order: number;
  /** Who tried it with the real program, when, which version / OS; null = not yet (tab hidden). */
  readonly tested: string | null;
  readonly engine: 'command' | 'settings' | 'link' | 'manual';
  readonly command?: CommandSpec;
  readonly settings?: SettingsSpec;
  readonly link?: LinkSpec;
  readonly chat?: ChatSpec;
  /** The copy box: the add command, the settings file text, and / or a JSON snippet. */
  readonly manual: {
    readonly command?: boolean;
    readonly settings?: boolean;
    readonly json?: Template;
  };
  readonly texts: AgentTexts;
}

// --- Checking a file -----------------------------------------------------------------

const ENGINES = ['command', 'settings', 'link', 'manual'] as const;
const WHERES = ['local', 'project', 'user'] as const;
const PLACEHOLDERS = ['{name}', '{command}', '{serverPath}', '{env}'];

/**
 * Programs a description may never name: shells and script runners would let the add command run
 * anything. An agent's own command-line tool is what a command agent runs.
 */
const NOT_A_PROGRAM = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'env',
  'sudo',
  'su',
  'doas',
  'cmd',
  'command',
  'powershell',
  'pwsh',
  'wsl',
  'start',
  'explorer',
  'open',
  'xdg-open',
  'node',
  'nodejs',
  'deno',
  'bun',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'py',
  'perl',
  'ruby',
  'php',
  'lua',
  'osascript',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'curl',
  'wget',
  'rm',
  'del',
  'mv',
  'cp',
  'dd',
  'chmod',
  'chown',
  'kill',
  'electron',
  'open-cli',
]);

/** Install-link schemes the app opens: only these apps' own links (a new one is a code change). */
export const LINK_SCHEMES = ['cursor', 'vscode', 'vscode-insiders'] as const;
const TEXT_KEYS = [
  'button',
  'buttonHint',
  'notFoundHint',
  'title',
  'notFoundTitle',
  'where',
  'after',
  'scopeFolder',
  'scopeUser',
];

/** Control characters, zero-width and text-direction characters: a text could hide words with them. */
function hasHiddenCharacters(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a) continue;
    if (c < 0x20 || c === 0x7f) return true;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)) return true;
    if ((c >= 0x2066 && c <= 0x2069) || c === 0xfeff) return true;
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Collects problems with paths ("command.add[2]"); the checks below read like the schema. */
class Checker {
  readonly errors: string[] = [];

  fail(at: string, what: string): void {
    this.errors.push(`${at}: ${what}`);
  }

  object(
    v: unknown,
    at: string,
    required: readonly string[],
    optional: readonly string[] = [],
  ): v is Record<string, unknown> {
    if (!isRecord(v)) {
      this.fail(at, 'must be an object');
      return false;
    }
    for (const k of required) if (!(k in v)) this.fail(at, `missing "${k}"`);
    for (const k of Object.keys(v))
      if (!required.includes(k) && !optional.includes(k)) this.fail(`${at}.${k}`, 'unknown field');
    return true;
  }

  text(v: unknown, at: string, allowEmpty = false): void {
    if (typeof v !== 'string' || (!allowEmpty && v.trim() === '')) this.fail(at, 'must be text');
    else if (hasHiddenCharacters(v)) this.fail(at, 'has invisible or control characters');
  }

  texts(v: unknown, at: string, allowEmpty = false): void {
    if (!Array.isArray(v)) this.fail(at, 'must be a list of texts');
    else
      v.forEach((x, i) => {
        this.text(x, `${at}[${String(i)}]`, allowEmpty);
      });
  }

  oneOf(v: unknown, at: string, values: readonly string[]): void {
    if (typeof v !== 'string' || !values.includes(v))
      this.fail(at, `must be one of ${values.join(', ')}`);
  }

  /** Placeholders in `{…}` must be known ones. */
  placeholders(v: unknown, at: string, known: readonly string[]): void {
    if (typeof v !== 'string') return;
    for (const m of v.match(/\{[A-Za-z]+\}/g) ?? [])
      if (!known.includes(m)) this.fail(at, `unknown placeholder ${m}`);
  }

  template(v: unknown, at: string): void {
    if (typeof v === 'string') this.placeholders(v, at, PLACEHOLDERS);
    else if (Array.isArray(v))
      v.forEach((x, i) => {
        this.template(x, `${at}[${String(i)}]`);
      });
    else if (isRecord(v))
      for (const [k, x] of Object.entries(v)) {
        this.placeholders(k, `${at} key`, ['{name}']);
        this.template(x, `${at}.${k}`);
      }
    else if (!(typeof v === 'number' || typeof v === 'boolean' || v === null))
      this.fail(at, 'must be JSON');
  }

  fileSpec(v: Record<string, unknown>, at: string): void {
    this.text(v['file'], `${at}.file`);
    if (
      typeof v['file'] === 'string' &&
      (v['file'].includes('..') || /^([a-z]:|[\\/])/i.test(v['file']))
    )
      this.fail(
        `${at}.file`,
        'must start with ~/ or be a plain file name (no .. or absolute paths)',
      );
    if ('fileEnv' in v) {
      this.text(v['fileEnv'], `${at}.fileEnv`);
      if (typeof v['fileEnv'] === 'string' && !/^[A-Z][A-Z0-9_]*$/.test(v['fileEnv']))
        this.fail(`${at}.fileEnv`, 'must be an environment variable name');
    }
  }

  keyPath(v: unknown, at: string, known: readonly string[]): void {
    this.texts(v, at);
    if (Array.isArray(v))
      v.forEach((k, i) => {
        this.placeholders(k, `${at}[${String(i)}]`, known);
      });
  }
}

function checkCommand(c: Checker, v: unknown): void {
  const at = 'command';
  if (
    !c.object(
      v,
      at,
      ['program', 'add', 'env', 'remove', 'scopes', 'entries', 'timeoutSec'],
      ['check'],
    )
  )
    return;
  const p = v['program'];
  if (c.object(p, `${at}.program`, ['name', 'windows', 'folders'], ['editorExtension'])) {
    c.text(p['name'], `${at}.program.name`);
    const name = typeof p['name'] === 'string' ? p['name'] : '';
    if (!/^[a-z0-9][\w.-]*$/i.test(name) || name.includes('..'))
      c.fail(`${at}.program.name`, 'must be a plain program name');
    else if (NOT_A_PROGRAM.has(name.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')))
      c.fail(`${at}.program.name`, `must be the agent's own program, not ${name}`);
    c.texts(p['windows'], `${at}.program.windows`);
    if (Array.isArray(p['windows']))
      p['windows'].forEach((w, i) => {
        // Only the same program as on macOS: its .exe or npm's .cmd shim.
        if (
          typeof w === 'string' &&
          w.toLowerCase() !== `${name.toLowerCase()}.exe` &&
          w.toLowerCase() !== `${name.toLowerCase()}.cmd`
        )
          c.fail(`${at}.program.windows[${String(i)}]`, `must be ${name}.exe or ${name}.cmd`);
      });
    c.texts(p['folders'], `${at}.program.folders`);
    if (Array.isArray(p['folders']))
      p['folders'].forEach((f, i) => {
        if (typeof f === 'string' && (!f.startsWith('~/') || f.includes('..')))
          c.fail(`${at}.program.folders[${String(i)}]`, 'must start with ~/');
      });
    if ('editorExtension' in p) c.text(p['editorExtension'], `${at}.program.editorExtension`);
  }
  c.texts(v['add'], `${at}.add`);
  if (Array.isArray(v['add'])) {
    v['add'].forEach((a, i) => {
      c.placeholders(a, `${at}.add[${String(i)}]`, [
        '{scope}',
        '{env}',
        ...PLACEHOLDERS.slice(0, 3),
      ]);
    });
    if (!v['add'].includes('{serverPath}')) c.fail(`${at}.add`, 'must contain {serverPath}');
  }
  c.texts(v['env'], `${at}.env`);
  if (Array.isArray(v['env']))
    v['env'].forEach((a, i) => {
      c.placeholders(a, `${at}.env[${String(i)}]`, ['{key}', '{value}']);
    });
  c.texts(v['remove'], `${at}.remove`);
  if (Array.isArray(v['remove']))
    v['remove'].forEach((a, i) => {
      c.placeholders(a, `${at}.remove[${String(i)}]`, ['{name}', '{where}']);
    });
  const scopes = v['scopes'];
  if (c.object(scopes, `${at}.scopes`, [], ['folder', 'user'])) {
    if (Object.keys(scopes).length === 0) c.fail(`${at}.scopes`, 'needs "folder" and / or "user"');
    for (const [k, s] of Object.entries(scopes))
      if (c.object(s, `${at}.scopes.${k}`, ['args', 'where'])) {
        c.texts(s['args'], `${at}.scopes.${k}.args`);
        c.oneOf(s['where'], `${at}.scopes.${k}.where`, WHERES);
      }
  }
  if (!Array.isArray(v['entries'])) c.fail(`${at}.entries`, 'must be a list');
  else
    v['entries'].forEach((e, i) => {
      const ea = `${at}.entries[${String(i)}]`;
      if (!c.object(e, ea, ['where', 'file', 'key'], ['fileEnv', 'approval'])) return;
      c.oneOf(e['where'], `${ea}.where`, WHERES);
      c.fileSpec(e, ea);
      c.keyPath(e['key'], `${ea}.key`, ['{name}', '{project}']);
      if ('approval' in e) checkApproval(c, e['approval'], `${ea}.approval`);
    });
  if ('check' in v && typeof v['check'] !== 'boolean')
    c.fail(`${at}.check`, 'must be true or false');
  const t = v['timeoutSec'];
  if (typeof t !== 'number' || !(t >= 1 && t <= 300)) c.fail(`${at}.timeoutSec`, 'must be 1–300');
}

function checkApproval(c: Checker, v: unknown, at: string): void {
  if (!c.object(v, at, ['files', 'enabled', 'disabled', 'all'])) return;
  for (const k of ['enabled', 'disabled', 'all']) c.text(v[k], `${at}.${k}`);
  if (!Array.isArray(v['files'])) c.fail(`${at}.files`, 'must be a list');
  else
    v['files'].forEach((f, i) => {
      const fa = `${at}.files[${String(i)}]`;
      if (!c.object(f, fa, ['file', 'key'], ['fileEnv'])) return;
      c.fileSpec(f, fa);
      if (Array.isArray(f['key']) && f['key'].length === 0) return; // the file's top level
      c.keyPath(f['key'], `${fa}.key`, ['{project}']);
    });
}

function checkChat(c: Checker, v: unknown): void {
  const at = 'chat';
  if (!c.object(v, at, ['start'], ['allow'])) return;
  c.text(v['start'], `${at}.start`);
  if (typeof v['start'] === 'string' && !/^[a-z0-9][\w.-]*$/i.test(v['start']))
    c.fail(`${at}.start`, 'must be a plain program name');
  if (!('allow' in v)) return;
  const a = v['allow'];
  const aa = `${at}.allow`;
  if (!c.object(a, aa, ['file', 'key', 'rules'], ['windowsRules'])) return;
  c.fileSpec(a, aa);
  const file = a['file'];
  // Only a JSON file in the agent's folder: never home, never a script.
  if (typeof file === 'string' && (file.startsWith('~') || !file.toLowerCase().endsWith('.json')))
    c.fail(`${aa}.file`, 'must be a .json file inside the folder (no ~/)');
  c.keyPath(a['key'], `${aa}.key`, []);
  for (const k of ['rules', 'windowsRules'] as const) {
    if (!(k in a)) continue;
    c.texts(a[k], `${aa}.${k}`);
    if (Array.isArray(a[k]))
      a[k].forEach((r, i) => {
        c.placeholders(r, `${aa}.${k}[${String(i)}]`, ['{name}', '{cad}']);
      });
  }
}

function checkSettings(c: Checker, v: unknown): void {
  const at = 'settings';
  if (!c.object(v, at, ['file', 'format', 'key', 'entry'], ['fileEnv'])) return;
  c.fileSpec(v, at);
  if (typeof v['file'] === 'string' && !v['file'].startsWith('~/'))
    c.fail(`${at}.file`, 'must start with ~/');
  c.oneOf(v['format'], `${at}.format`, ['json', 'toml']);
  // The file's type must match what is written: never a script or shell start-up file.
  if (
    typeof v['file'] === 'string' &&
    typeof v['format'] === 'string' &&
    !v['file'].toLowerCase().endsWith(`.${v['format']}`)
  )
    c.fail(`${at}.file`, `must end in .${v['format']} (the format written)`);
  c.keyPath(v['key'], `${at}.key`, ['{name}']);
  c.template(v['entry'], `${at}.entry`);
}

function checkLink(c: Checker, v: unknown): void {
  const at = 'link';
  if (!c.object(v, at, ['url', 'config', 'encode'])) return;
  c.text(v['url'], `${at}.url`);
  c.placeholders(v['url'], `${at}.url`, ['{name}', '{config}']);
  if (typeof v['url'] === 'string') {
    if (!v['url'].includes('{config}')) c.fail(`${at}.url`, 'must contain {config}');
    // Only the known apps' own links: never a web page, a file, a script or a system link.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v['url'])?.[1]?.toLowerCase() ?? '';
    if (!(LINK_SCHEMES as readonly string[]).includes(scheme))
      c.fail(`${at}.url`, `must start with ${LINK_SCHEMES.map((x) => `${x}:`).join(', ')}`);
  }
  c.template(v['config'], `${at}.config`);
  c.oneOf(v['encode'], `${at}.encode`, ['base64', 'json']);
}

/** The problems in a description file's content; empty = fine. `fileName` without `.json`. */
export function checkAgentDesc(json: unknown, fileName: string): string[] {
  const c = new Checker();
  if (
    !c.object(
      json,
      fileName,
      ['id', 'label', 'tab', 'order', 'tested', 'engine', 'manual', 'texts'],
      ['$schema', 'command', 'settings', 'link', 'chat'],
    )
  )
    return c.errors;
  const v = json;
  c.text(v['id'], 'id');
  if (typeof v['id'] === 'string' && !/^[a-z][a-z0-9-]*$/.test(v['id']))
    c.fail('id', 'must be lower-case letters, digits, -');
  if (v['id'] !== fileName) c.fail('id', `must be the file name (${fileName})`);
  c.text(v['label'], 'label');
  c.text(v['tab'], 'tab');
  if (typeof v['order'] !== 'number' || !Number.isFinite(v['order']))
    c.fail('order', 'must be a number');
  if (v['tested'] !== null) c.text(v['tested'], 'tested');
  c.oneOf(v['engine'], 'engine', ENGINES);
  const engine = v['engine'];
  for (const e of ['command', 'settings', 'link'] as const)
    if (engine === e && !(e in v)) c.fail(e, `needed by engine "${e}"`);
  if ('command' in v) checkCommand(c, v['command']);
  if ('settings' in v) checkSettings(c, v['settings']);
  if ('link' in v) checkLink(c, v['link']);
  if ('chat' in v) checkChat(c, v['chat']);
  const m = v['manual'];
  if (c.object(m, 'manual', [], ['command', 'settings', 'json'])) {
    for (const k of ['command', 'settings'] as const)
      if (k in m) {
        if (m[k] !== true) c.fail(`manual.${k}`, 'must be true or left out');
        else if (!(k in v)) c.fail(`manual.${k}`, `needs "${k}"`);
      }
    if ('json' in m) c.template(m['json'], 'manual.json');
    if (Object.keys(m).length === 0) c.fail('manual', 'needs "command", "settings" or "json"');
  }
  const t = v['texts'];
  if (c.object(t, 'texts', [], TEXT_KEYS)) {
    for (const [k, x] of Object.entries(t)) {
      c.text(x, `texts.${k}`);
      c.placeholders(x, `texts.${k}`, k === 'buttonHint' ? ['{file}'] : []);
    }
    const cmd = v['command'];
    const folderSwitch =
      engine === 'command' && isRecord(cmd) && isRecord(cmd['scopes']) && 'folder' in cmd['scopes'];
    if (folderSwitch) {
      // The scope panel names the agent itself ("Add Third Wheel to Claude Code…").
      for (const k of ['scopeFolder', 'scopeUser'] as const)
        if (!(k in t)) c.fail(`texts.${k}`, 'needed when the folder switch is shown');
    } else {
      if (!('title' in t)) c.fail('texts.title', 'missing');
      if (engine !== 'manual' && !('button' in t))
        c.fail('texts.button', 'needed by a one-click engine');
    }
  }
  return c.errors;
}

/**
 * The description files, checked and sorted for the tabs. A file with problems is left out (and
 * its problems returned): CI fails on them, the app just doesn't show that tab.
 */
export function readAgentDescs(files: Readonly<Record<string, unknown>>): {
  readonly agents: readonly AgentDesc[];
  readonly problems: readonly string[];
} {
  const agents: AgentDesc[] = [];
  const problems: string[] = [];
  for (const [path, json] of Object.entries(files)) {
    const name = (path.split(/[\\/]/).at(-1) ?? path).replace(/\.json$/, '');
    if (name.endsWith('.schema')) continue;
    const errors = checkAgentDesc(json, name);
    if (errors.length > 0) problems.push(...errors.map((e) => `${name}.json: ${e}`));
    else agents.push(json as AgentDesc);
  }
  agents.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { agents, problems };
}
