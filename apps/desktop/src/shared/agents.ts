/**
 * The built-in engines' texts: from an agent description (`agent-desc.ts`) and this copy's MCP
 * setup, build the command the one-click button runs, the settings file text it writes, the
 * install link it opens, and what the Connect pop-up shows. Main runs them (`main/agent-cli.ts`).
 * Pure: used by main, the renderer and the tests.
 */
import type {
  AgentDesc,
  CommandSpec,
  LinkSpec,
  McpScope,
  SettingsSpec,
  Template,
} from './agent-desc.js';
import { MCP_SERVER_NAME, shellQuote, type ConnectResult, type McpSetup } from './ai-status.js';

// --- Templates ------------------------------------------------------------------------

const DROP = Symbol('drop');

function fill(text: string, setup: McpSetup): string {
  return text
    .replaceAll('{name}', MCP_SERVER_NAME)
    .replaceAll('{command}', setup.command)
    .replaceAll('{serverPath}', setup.serverPath);
}

function fillValue(t: Template, setup: McpSetup): unknown {
  if (t === '{env}') return Object.keys(setup.env).length > 0 ? { ...setup.env } : DROP;
  if (typeof t === 'string') return fill(t, setup);
  if (Array.isArray(t)) return t.map((x) => fillValue(x, setup)).filter((x) => x !== DROP);
  if (t !== null && typeof t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) {
      const value = fillValue(v, setup);
      if (value !== DROP) out[fill(k, setup)] = value;
    }
    return out;
  }
  return t;
}

/** A template with this copy's values: `"{env}"` becomes the environment (left out when empty). */
export function fillTemplate(t: Template, setup: McpSetup): unknown {
  const v = fillValue(t, setup);
  return v === DROP ? undefined : v;
}

/** A key path with `{name}` filled in. */
export function keyPath(key: readonly string[]): string[] {
  return key.map((k) => k.replaceAll('{name}', MCP_SERVER_NAME));
}

// --- Command engine -------------------------------------------------------------------

/** One argument of the add command with where it came from (for quoting in the shown text). */
interface Arg {
  readonly value: string;
  readonly path?: boolean;
  readonly bare?: boolean;
}

function addArgList(cmd: CommandSpec, setup: McpSetup, scope: McpScope): Arg[] {
  const out: Arg[] = [];
  for (const a of cmd.add) {
    if (a === '{scope}') for (const s of cmd.scopes[scope]?.args ?? []) out.push({ value: s });
    else if (a === '{env}')
      for (const [k, v] of Object.entries(setup.env))
        for (const e of cmd.env)
          out.push({ value: e.replaceAll('{key}', k).replaceAll('{value}', v) });
    else if (a === '{command}')
      out.push({ value: setup.command, path: true, bare: setup.command === 'node' });
    else if (a === '{serverPath}') out.push({ value: setup.serverPath, path: true });
    else out.push({ value: fill(a, setup) });
  }
  return out;
}

/** The arguments after the program for the add command (the button runs these without a shell). */
export function commandArgs(cmd: CommandSpec, setup: McpSetup, scope: McpScope): string[] {
  return addArgList(cmd, setup, scope).map((a) => a.value);
}

/** The add command as the user would type it: paths quoted for their shell, `node` bare. */
export function commandText(cmd: CommandSpec, setup: McpSetup, scope: McpScope): string {
  const args = addArgList(cmd, setup, scope).map((a) =>
    a.path && !a.bare ? shellQuote(a.value, setup.platform) : a.value,
  );
  return [cmd.program.name, ...args].join(' ');
}

/** The arguments of the remove command for an entry in `where`. */
export function removeArgs(cmd: CommandSpec, where: string): string[] {
  return cmd.remove.map((a) =>
    a.replaceAll('{name}', MCP_SERVER_NAME).replaceAll('{where}', where),
  );
}

export function removeText(cmd: CommandSpec, where: string): string {
  return [cmd.program.name, ...removeArgs(cmd, where)].join(' ');
}

/** The scope a one-click button uses when the agent has no switch: its only one. */
export function defaultScope(cmd: CommandSpec): McpScope {
  return cmd.scopes.folder && !cmd.scopes.user ? 'folder' : cmd.scopes.user ? 'user' : 'folder';
}

/** The agent shows the "This folder only" / "All my folders" switch. */
export function hasScopeSwitch(desc: AgentDesc): boolean {
  return desc.engine === 'command' && desc.command?.scopes.folder !== undefined;
}

// --- Settings file engine: TOML ---------------------------------------------------------

/**
 * A TOML string. Windows: a literal string in single quotes, so the `\` of a path stay as they
 * are and the user can edit it by hand; a basic string otherwise (or if the path has `'`).
 */
export function tomlString(value: string, platform: string): string {
  if (platform === 'win32' && !/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return `"${escaped}"`;
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k, '');
}

function tomlValue(v: unknown, platform: string): string {
  if (typeof v === 'string') return tomlString(v, platform);
  if (Array.isArray(v)) return `[${v.map((x) => tomlValue(x, platform)).join(', ')}]`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new Error('TOML: unsupported value');
}

/** `[a.b]` + its values, then its sub-tables (`[a.b.env]`). */
function tomlTable(
  keys: readonly string[],
  entry: Record<string, unknown>,
  platform: string,
): string[] {
  const lines = [`[${keys.map(tomlKey).join('.')}]`];
  const tables: [string, Record<string, unknown>][] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
      tables.push([k, v as Record<string, unknown>]);
    else lines.push(`${tomlKey(k)} = ${tomlValue(v, platform)}`);
  }
  for (const [k, v] of tables) lines.push('', ...tomlTable([...keys, k], v, platform));
  return lines;
}

/** `a."b c".d` → ['a', 'b c', 'd'] (enough of TOML's dotted keys for table headers). */
function tomlKeys(key: string): string[] {
  return (key.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.]+/g) ?? []).map((k) => {
    const t = k.trim();
    return /^["'].*["']$/.test(t) ? t.slice(1, -1) : t;
  });
}

const HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;

/** `[` / `{` outside strings minus `]` / `}`: non-zero = the value goes on over more lines. */
function openBrackets(line: string): number {
  const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*$/, '');
  let n = 0;
  for (const c of bare) n += c === '[' || c === '{' ? 1 : c === ']' || c === '}' ? -1 : 0;
  return n;
}

/**
 * A TOML file with the entry at `key` (e.g. `mcp_servers.third-wheel`) replaced by `block`: drops
 * every table under that key and a `third-wheel = { … }` line under its parent table (an older
 * install's entry would make the agent refuse a duplicate), keeps everything else as is.
 * Undefined when the file can't be edited safely line by line (multi-line strings, or an old
 * entry spread over several lines): the user then pastes it by hand.
 */
export function withTomlEntry(
  existing: string,
  key: readonly string[],
  block: string,
): string | undefined {
  if (existing.includes('"""') || existing.includes("'''")) return undefined;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  /** Comments / blank lines seen while dropping: they may belong to the next table. */
  let held: string[] = [];
  let table: string[] = [];
  let dropping = false;
  const isOurs = (keys: readonly string[]): boolean =>
    keys.length >= key.length && key.every((k, i) => keys[i] === k);
  for (const line of existing.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      table = tomlKeys(header[1] ?? '');
      const wasDropping = dropping;
      dropping = isOurs(table);
      // The comment above a kept table (from its first comment line: no doubled blank lines).
      const from = held.findIndex((l) => l.trim().startsWith('#'));
      if (wasDropping && !dropping && from >= 0) out.push(...held.slice(from));
      held = [];
      if (dropping) continue;
    }
    if (dropping) {
      if (/^\s*(#.*)?$/.test(line)) held.push(line);
      else held = [];
      continue;
    }
    // Dotted or inline forms of the same entry.
    const k = /^\s*((?:"[^"]*"|'[^']*'|[\w-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[\w-]+))*)\s*=/.exec(
      line,
    );
    if (!header && k) {
      const keys = [...table, ...tomlKeys(k[1] ?? '').map((x) => x.trim())];
      if (isOurs(keys)) {
        if (openBrackets(line) !== 0) return undefined;
        continue;
      }
    }
    out.push(line);
  }
  while (out.length > 0 && out.at(-1)?.trim() === '') out.pop();
  const head = out.length > 0 ? out.join(eol) + eol + eol : '';
  return head + block.split('\n').join(eol) + eol;
}

// --- Settings file engine: JSON ---------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nested(key: readonly string[], entry: unknown): unknown {
  return key.reduceRight<unknown>((inner, k) => ({ [k]: inner }), entry);
}

/**
 * A JSON settings file with the entry at `key` set (objects on the way created, everything else
 * kept). Undefined when the file isn't a JSON object or something on the way isn't an object.
 */
export function withJsonEntry(
  existing: string,
  key: readonly string[],
  entry: unknown,
): string | undefined {
  let root: unknown = {};
  if (existing.trim() !== '') {
    try {
      root = JSON.parse(existing) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(root)) return undefined;
  let at: Record<string, unknown> = root;
  for (const k of key.slice(0, -1)) {
    const next = at[k] ?? {};
    if (!isRecord(next)) return undefined;
    at[k] = next;
    at = next;
  }
  const last = key.at(-1);
  if (last === undefined) return undefined;
  at[last] = entry;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(root, null, 2).split('\n').join(eol) + eol;
}

/** What the settings engine writes for this copy (TOML: the table; JSON: the entry nested). */
export function settingsText(spec: SettingsSpec, setup: McpSetup): string {
  const entry = fillTemplate(spec.entry, setup);
  const key = keyPath(spec.key);
  if (spec.format === 'toml')
    return tomlTable(key, isRecord(entry) ? entry : {}, setup.platform).join('\n');
  return JSON.stringify(nested(key, entry), null, 2);
}

/** The settings file's new content with this copy's entry; undefined = can't be edited safely. */
export function settingsWith(
  spec: SettingsSpec,
  setup: McpSetup,
  existing: string,
): string | undefined {
  const key = keyPath(spec.key);
  return spec.format === 'toml'
    ? withTomlEntry(existing, key, settingsText(spec, setup))
    : withJsonEntry(existing, key, fillTemplate(spec.entry, setup));
}

// --- Install link engine -----------------------------------------------------------------

/** Base64 of UTF-8 (paths may hold any letter; `btoa` alone takes Latin-1 only). */
function base64(text: string): string {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** The install link: the agent's app opens and asks to install the server. */
export function installUrl(link: LinkSpec, setup: McpSetup): string {
  const json = JSON.stringify(fillTemplate(link.config, setup));
  const config = encodeURIComponent(link.encode === 'base64' ? base64(json) : json);
  return link.url.replaceAll('{name}', MCP_SERVER_NAME).replaceAll('{config}', config);
}

// --- What the pop-up shows -----------------------------------------------------------------

/** The JSON snippet of the copy box (`manual.json`), pretty-printed. */
export function jsonSnippet(desc: AgentDesc, setup: McpSetup): string | undefined {
  return desc.manual.json === undefined
    ? undefined
    : JSON.stringify(fillTemplate(desc.manual.json, setup), null, 2);
}

/** The copy box's text: the settings text, else the add command, else the JSON snippet. */
export function manualText(desc: AgentDesc, setup: McpSetup, scope?: McpScope): string {
  if (desc.manual.settings && desc.settings) return settingsText(desc.settings, setup);
  if (desc.manual.command && desc.command)
    return commandText(desc.command, setup, scope ?? defaultScope(desc.command));
  return jsonSnippet(desc, setup) ?? '';
}

export interface AgentPanel {
  /** One-click button label; undefined = no button for this agent. */
  readonly button?: string | undefined;
  /** Under the button: what it does, or why there is none. */
  readonly buttonHint?: string;
  /** Heading above the copy box. */
  readonly title: string;
  readonly text: string;
  /** Under the copy box: where it goes and how to check. */
  readonly where: string;
}

/**
 * Panel of an agent without the folder switch. `found`: what main found for the button — the
 * program, the settings file; undefined = still looking, null = not found.
 */
export function agentPanel(
  desc: AgentDesc,
  setup: McpSetup,
  found: string | null | undefined,
): AgentPanel {
  const t = desc.texts;
  const missing = desc.engine === 'command' && found === null;
  const hint = missing
    ? t.notFoundHint
    : t.buttonHint?.replaceAll('{file}', found ?? desc.settings?.file ?? '');
  return {
    ...(desc.engine === 'manual' || missing ? {} : { button: t.button }),
    ...(hint === undefined ? {} : { buttonHint: hint }),
    title: (missing ? t.notFoundTitle : undefined) ?? t.title ?? '',
    text: manualText(desc, setup),
    where: t.where ?? '',
  };
}

/** The line under an agent's button after a click. */
export function agentResultText(desc: AgentDesc, result: ConnectResult): string {
  const name = desc.label;
  const after = desc.texts.after ? ` ${desc.texts.after}` : '';
  if (result.ok) {
    if (desc.engine === 'settings') return `Added ✓ to ${result.path}.${after}`;
    if (desc.engine === 'command') return `Added ✓${after}`;
    return `${name} should open and ask to install third-wheel. Nothing opened? Use the JSON below.`;
  }
  if (result.reason === 'temporary-location')
    return 'Move Third Wheel to your Applications folder and open it from there first.';
  if (result.reason === 'not-found')
    return desc.engine === 'link'
      ? `${name} didn’t open: is it installed? Use the JSON below instead.`
      : `${name} wasn’t found. Use the setup below.`;
  return `Couldn’t add it${result.detail ? `: ${result.detail}` : '.'} Use the setup below instead.`;
}
